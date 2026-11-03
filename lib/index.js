/**
 * dsh-lan-exec - pair two DeepSeek Harness hosts on a LAN and forward
 * model-authored tool calls from one to the other.
 *
 * One package, two roles:
 * - `server` (the controlled host) listens and executes forwarded calls through
 *   its own tool pipeline, so its session approval, sandbox and filesystem
 *   policy decide what a forwarded call may do.
 * - `client` (the controlling host) publishes exactly one tool while the link
 *   is up. The model writes a TypeScript program; each `tools.x(...)` inside it
 *   becomes an authenticated RPC to the peer. The source itself never leaves.
 *
 * @module dsh-lan-exec
 */

import { createBridgeClient } from './host-client.js'
import { createBridgeServer } from './server.js'
import { exposeLocalProgramTool } from './local-tool.js'
import { createStore, DEFAULT_MAX_BYTES } from './store.js'
import { generateToken, fingerprint, looksWeak } from './token.js'
import path from 'node:path'
import os from 'node:os'

export const name = 'lan-exec'
export const inject = ['tools']

/** Version reported in logs and in the handshake. */
export const VERSION = '1.0.0'

/** Five minutes: the pair closes after this long with no completed call. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Tool name used when the config does not override it. */
export const DEFAULT_TOOL_NAME = 'remote_run'

/** Local program tool name used when the config does not override it. */
export const DEFAULT_LOCAL_TOOL_NAME = 'run_ts'

/**
 * Default location of the replicated data space.
 * @returns {string} absolute file path.
 */
function defaultStoreFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'lan-exec', 'store.json')
}

/**
 * Merge user config over defaults.
 * @param {Record<string, unknown>} [config] - raw config.
 * @returns {object} resolved config.
 */
export function resolveConfig(config = {}) {
  // Two sides, named for what they do rather than for who connects to whom:
  //   origin   - runs the session and the model; decides what to call
  //   executor - runs the forwarded calls, and owns the permissions they need
  // `client`/`server` were the old spellings; they stay accepted so an existing
  // profile keeps working, and map onto the new names.
  const raw = String(config.mode ?? config.role ?? 'off')
  const role = raw === 'client' ? 'origin' : raw === 'server' ? 'executor' : raw
  return {
    role,
    mode: role,
    name: typeof config.name === 'string' && config.name.length > 0 ? config.name : 'dsh-lan-exec',
    version: VERSION,
    token: typeof config.token === 'string' ? config.token.trim() : '',
    peerToken: typeof config.peerToken === 'string' ? config.peerToken.trim() : '',
    peerName: typeof config.peerName === 'string' && config.peerName.length > 0 ? config.peerName : 'peer',
    port: Number.isInteger(config.port) ? config.port : 45870,
    bind: typeof config.bind === 'string' && config.bind.length > 0 ? config.bind : '0.0.0.0',
    host: typeof config.host === 'string' ? config.host.trim() : '',
    session: typeof config.session === 'string' && config.session.length > 0 ? config.session : 'auto',
    idleTimeoutMs: Number.isFinite(config.idleTimeoutMs) ? Math.max(0, Math.floor(config.idleTimeoutMs)) : DEFAULT_IDLE_TIMEOUT_MS,
    autoReconnect: config.autoReconnect !== false,
    toolName: typeof config.toolName === 'string' && config.toolName.length > 0 ? config.toolName : DEFAULT_TOOL_NAME,
    localTool: config.localTool !== false,
    localToolName: typeof config.localToolName === 'string' && config.localToolName.length > 0 ? config.localToolName : DEFAULT_LOCAL_TOOL_NAME,
    callTimeoutMs: Number.isFinite(config.callTimeoutMs) ? Math.floor(config.callTimeoutMs) : 300_000,
    maxResultBytes: Number.isFinite(config.maxResultBytes) ? Math.floor(config.maxResultBytes) : 4 * 1024 * 1024,
    storeFile: typeof config.storeFile === 'string' && config.storeFile.length > 0 ? config.storeFile : defaultStoreFile(),
    maxStoreBytes: Number.isFinite(config.maxStoreBytes) ? Math.max(0, Math.floor(config.maxStoreBytes)) : DEFAULT_MAX_BYTES,
    hideTools: Array.isArray(config.hideTools) ? config.hideTools.map(String) : ['run_code'],
    allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools.map(String) : [],
  }
}

/**
 * Validate a resolved config, failing loudly at mount time rather than at the
 * first model call.
 * @param {object} resolved - resolved config.
 */
export function assertConfig(resolved) {
  if (!['off', 'origin', 'executor'].includes(resolved.role)) {
    throw new Error(`lan-exec: mode must be "origin", "executor" or "off" (got ${JSON.stringify(resolved.mode)})`)
  }
  if (resolved.role === 'off') return
  if (!Number.isInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535) {
    throw new Error(`lan-exec: port must be an integer between 1 and 65535 (got ${resolved.port})`)
  }
  if (resolved.token.length === 0) throw new Error('lan-exec: `token` (this host\'s own credential) is required; run setup.mjs to mint one')
  if (resolved.peerToken.length === 0) throw new Error('lan-exec: `peerToken` (the other host\'s credential) is required; paste the token printed there')
  if (resolved.token === resolved.peerToken) throw new Error('lan-exec: the two hosts must use different credentials; each side mints its own')
  if (resolved.role === 'origin' && !/^[A-Za-z0-9_.-]+$/.test(resolved.toolName)) {
    throw new Error(`lan-exec: toolName must be a plain identifier (got ${JSON.stringify(resolved.toolName)})`)
  }
  if (resolved.toolName === 'run_code') throw new Error('lan-exec: toolName must not be the reserved PTC transport name "run_code"')
  if (resolved.localTool && resolved.localToolName === 'run_code') {
    throw new Error('lan-exec: localToolName must not be the reserved PTC transport name "run_code"')
  }
  if (resolved.localTool && resolved.localToolName === resolved.toolName) {
    throw new Error('lan-exec: localToolName and toolName must differ')
  }
}

/**
 * Cordis plugin entry.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} [rawConfig] - plugin config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)

  const log = (level, message) => {
    const line = `lan-exec: ${message}`
    const logger = ctx.logger
    if (logger === undefined || logger === null) return
    const scoped = typeof logger === 'function' ? logger('lan-exec') : logger
    const method = scoped?.[level] ?? scoped?.info
    if (typeof method === 'function') method.call(scoped, line)
  }

  assertConfig(config)

  if (config.role === 'off') {
    log('info', 'mode is "off"; nothing mounted (pick origin or executor in the plugin settings)')
    return
  }

  if (looksWeak(config.token) || looksWeak(config.peerToken)) {
    log('warn', 'one of the configured credentials is shorter than 40 characters; prefer the 256-bit tokens setup.mjs mints')
  }

  // The data space is mounted for both roles: each end keeps a full copy.
  const store = createStore({ file: config.storeFile, maxBytes: config.maxStoreBytes, log })
  store.load()
  const stats = store.stat()
  log('info', `data space: ${stats.entries} entries, ${stats.bytes} bytes (limit ${stats.maxBytes})`)

  if (config.localTool) {
    ctx.effect(() => exposeLocalProgramTool({ ctx, config, store }))
  }

  if (config.role === 'executor') {
    const handle = createBridgeServer({
      config,
      store,
      deps: {
        getTools: () => ctx.tools,
        getAgents: () => ctx.get('agents'),
        log,
      },
    })
    ctx.effect(() => {
      void handle.start().catch((error) => {
        log('error', `failed to start: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => handle.stop()
    })
    log('info', `executor mode: listening on ${config.bind}:${config.port} (credential ${fingerprint(config.token)})`)
    return
  }

  const client = createBridgeClient({ config, ctx, store, log })
  ctx.effect(() => {
    client.start()
    return () => client.stop()
  })
  log('info', `origin mode: pairing with ${config.host}:${config.port} (credential ${fingerprint(config.token)})`)
}


