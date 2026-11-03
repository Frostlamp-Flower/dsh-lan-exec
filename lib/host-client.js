/**
 * Origin side: the host that runs the session. It publishes one PTC-shaped tool
 * while the link to an executor is up, and runs the model's program locally
 * against stubs that forward each call over the authenticated channel.
 *
 * The tool exists only while the link does. Registration is an effect of a
 * successful `hello` and is disposed on any terminal disconnect, so a model
 * never sees a tool that cannot reach anything.
 *
 * @module dsh-lan-exec/origin
 */

import { randomUUID } from 'node:crypto'
import { exposeTool } from './tool.js'
import {
  createNonce,
  constantEquals,
  open,
  requestKey,
  responseProof,
  seal,
} from './wire.js'
import { assignBindings, renderDescription } from './sdk.js'
import { fingerprint } from './token.js'

/** Backoff ceiling between reconnect attempts, in milliseconds. */
const MAX_BACKOFF_MS = 30_000

/** Long-poll window used to learn about an executor-side close promptly. */
const POLL_WINDOW_MS = 20_000

/**
 * Normalize one base URL from config.
 * @param {object} config - plugin config.
 * @returns {string} origin without a trailing slash.
 */
function baseUrlOf(config) {
  const host = config.host
  const port = config.port
  if (typeof host !== 'string' || host.length === 0) throw new Error('origin mode needs `host`')
  return `http://${host}:${port}`
}

/**
 * Start the origin side.
 * @param {object} options - origin options.
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.store - replicated data space.
 * @param {(level: string, message: string) => void} options.log - logger.
 * @returns {{start: () => void, stop: () => Promise<void>, status: () => object}} handle.
 */
export function createBridgeClient({ config, ctx, store, log }) {
  const baseUrl = baseUrlOf(config)
  let stopped = false
  let connected = false
  let toolDisposer
  let toolSurfaceDigest = ''
  let remote = { tools: [], session: undefined }
  let bindings = new Map()
  let reconnectTimer
  let pollAbort
  let backoff = 1000
  let state = 'idle'

  /**
   * One authenticated request. The caller's credential rides the bearer header;
   * the executor's credential is verified from the proof header.
   * @param {string} method - method name.
   * @param {unknown} params - JSON parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<any>} the method result.
   */
  async function rpc(method, params, signal) {
    const nonce = createNonce()
    const key = requestKey(config.token, config.peerToken, nonce)
    const body = JSON.stringify({ method, ...seal(key, ['req', nonce, method], params) })
    const response = await fetch(`${baseUrl}/v1/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `DshLan ${config.token}`,
        'x-dshlan-nonce': nonce,
      },
      body,
      signal,
    })
    const text = await response.text()
    if (response.status === 401) throw Object.assign(new Error('the executor rejected this host\'s credential'), { fatal: true })
    if (response.status === 409) throw new Error('the executor saw a replayed nonce (check both machines\' clocks and retry)')
    const proof = String(response.headers.get('x-dshlan-proof') ?? '')
    if (!constantEquals(responseProof(config.peerToken, nonce, response.status, text), proof)) {
      throw Object.assign(new Error('the executor failed verification (bad response proof)'), { fatal: true })
    }
    if (response.status >= 410) {
      const reason = (() => {
        try {
          return open(key, ['res', nonce], JSON.parse(text))?.error?.message ?? 'closed'
        } catch {
          return 'closed'
        }
      })()
      throw Object.assign(new Error(`bridge closed: ${reason}`), { code: 'SESSION_CLOSED' })
    }
    if (!response.ok) throw new Error(`bridge request failed with HTTP ${response.status}`)
    const payload = open(key, ['res', nonce], JSON.parse(text))
    if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'unknown bridge error')
    return payload.result
  }

  /**
   * Bindings over the replicated store, handed to remote programs. Reads come
   * from the local mirror; writes go through the executor first so both copies
   * move together and a rejected write never lands here.
   * @returns {Record<string, Function>} store namespace.
   */
  function remoteStoreBindings() {
    const apply = async (op, key, value) => {
      const outcome = await rpc('store/apply', { op, key, value })
      try {
        store.mutate(op, key, value, outcome.rev)
      } catch (error) {
        // The executor accepted the write, so the mirrors must converge on it
        // even when the local copy was already in the target state.
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error
      }
      return outcome
    }
    return {
      create: (args) => apply('create', args?.key, args?.value),
      update: (args) => apply('update', args?.key, args?.value),
      delete: (args) => apply('delete', args?.key),
      read: async (args) => store.read(args?.key),
      list: async (args) => store.list(args?.prefix ?? ''),
      stat: async () => store.stat(),
    }
  }

  /**
   * Adopt the executor's copy of the data space.
   * @returns {Promise<void>} completion.
   */
  async function syncStore() {
    const snapshot = await rpc('store/sync', { since: 0 })
    const merged = store.merge(snapshot)
    if (merged.applied > 0) log('info', `data space: adopted ${merged.applied} entries from the executor`)
  }

  /**
   * Ask the executor what it can run and adopt that surface.
   * @returns {Promise<void>} completion.
   */
  async function connectSurface() {
    const hello = await rpc('hello', { name: config.name, version: config.version })
    remote = { tools: Array.isArray(hello.tools) ? hello.tools : [], session: hello.session }
    bindings = assignBindings(remote.tools)
    connected = true
    state = 'online'

    const storeLimit = hello?.limits?.maxStoreBytes
    if (Number.isFinite(storeLimit) && storeLimit !== store.stat().maxBytes) {
      store.setMaxBytes(storeLimit)
      log('info', `data space budget adopted from the executor: ${storeLimit} bytes`)
    }
    log('info', `paired with ${hello.serverName ?? 'executor'} at ${baseUrl}; ${remote.tools.length} remote tools`)
    await syncStore()
  }

  /**
   * Publish the bridge tool, or refresh its description when the surface moved.
   * @param {boolean} ptcPresentation - whether this deployment presents tools as PTC.
   */
  function publishTool(ptcPresentation) {
    const digest = remote.tools.map((tool) => `${tool.name}:${JSON.stringify(tool.parameters)}`).join('|')
    if (toolDisposer !== undefined && digest === toolSurfaceDigest) return
    toolSurfaceDigest = digest
    toolDisposer?.()
    toolDisposer = undefined

    const description = renderDescription({
      peerName: config.peerName,
      session: remote.session,
      tools: remote.tools,
      bindings,
      toolName: config.toolName,
      ptcPresentation,
    })
    toolDisposer = exposeTool({
      ctx,
      config,
      description,
      remote,
      bindings,
      store: remoteStoreBindings(),
      call: async (name, args, signal) => {
        const outcome = await rpc('tools/call', { name, arguments: args, callId: `lan-${randomUUID()}` }, signal)
        const text = Array.isArray(outcome?.content)
          ? outcome.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
          : ''
        if (outcome?.isError === true) throw new Error(text.length > 0 ? text : `remote tool "${name}" failed`)
        return outcome?.value !== undefined ? outcome.value : text
      },
    })
    log('info', `exposed tool "${config.toolName}" with ${remote.tools.length} remote tools`)
  }

  /** Remove the published tool. */
  function retractTool() {
    if (toolDisposer === undefined) return
    toolDisposer()
    toolDisposer = undefined
    toolSurfaceDigest = ''
  }

  /**
   * Whether the local composition presents tools through PTC (so the bridge is
   * reached from inside `run_code` rather than directly).
   * @returns {boolean} true when PTC is the effective presentation.
   */
  function ptcPresentation() {
    const tools = ctx.get('tools')
    try {
      return tools?.modeFor?.(undefined) === 'ptc'
    } catch {
      return false
    }
  }

  /** Keep the link honest with a long poll that does not renew the idle clock. */
  async function pollLoop() {
    while (connected && !stopped) {
      pollAbort = new AbortController()
      try {
        const result = await rpc('session/poll', { timeoutMs: POLL_WINDOW_MS }, pollAbort.signal)
        if (result?.alive === false) {
          log('warn', `executor closed the bridge (${result.reason ?? 'unknown'}); retracting the tool`)
          await disconnect(result.reason === 'idle-timeout' ? 'expired' : 'closed')
          return
        }
      } catch (error) {
        if (stopped) return
        if (error?.name === 'AbortError') return
        if (error?.code === 'SESSION_CLOSED') {
          await disconnect('expired')
          return
        }
        log('warn', `bridge poll failed: ${error instanceof Error ? error.message : String(error)}`)
        await disconnect('network')
        return
      }
    }
  }

  /**
   * Tear the link down, retract the tool, and optionally schedule a reconnect.
   * @param {'network'|'expired'|'closed'|'shutdown'} reason - why the link ended.
   */
  async function disconnect(reason) {
    connected = false
    retractTool()
    pollAbort?.abort()
    pollAbort = undefined
    if (stopped || reason === 'shutdown') return
    if (reason === 'expired') {
      state = 'expired'
      log('warn', `bridge expired after ${Math.round(config.idleTimeoutMs / 1000)}s without a completed call; not reconnecting automatically`)
      return
    }
    if (!config.autoReconnect) {
      state = 'offline'
      return
    }
    state = 'connecting'
    scheduleReconnect()
  }

  /** Arm the next connection attempt with bounded exponential backoff. */
  function scheduleReconnect() {
    if (stopped || reconnectTimer !== undefined) return
    const delay = backoff
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, delay)
    reconnectTimer.unref?.()
  }

  /** One connection attempt. */
  async function connect() {
    if (stopped || connected) return
    state = 'connecting'
    try {
      await connectSurface()
      backoff = 1000
      publishTool(ptcPresentation())
      void pollLoop()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(error?.fatal === true ? 'error' : 'warn', `bridge connect failed: ${message}`)
      if (error?.fatal === true || !config.autoReconnect) {
        state = 'offline'
        return
      }
      scheduleReconnect()
    }
  }

  return {
    start() {
      log('info', `origin "${config.name}" will pair with ${baseUrl} (token ${fingerprint(config.token)})`)
      void connect()
    },
    async stop() {
      stopped = true
      connected = false
      retractTool()
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      pollAbort?.abort()
      state = 'stopped'
    },
    status() {
      return { state, connected, remoteTools: remote.tools.length, executor: config.peerName, baseUrl }
    },
  }
}
