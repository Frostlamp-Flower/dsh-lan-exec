/**
 * Executor side: the host that runs the real session. It accepts one
 * authenticated request at a time from a paired origin, executes forwarded tool
 * calls through `ctx.tools.execute`, and therefore applies this host's own
 * approval, sandbox and filesystem policy -- exactly as if its user had invoked
 * that tool locally.
 *
 * Auth follows the harness habit: every request carries the caller's credential
 * as a bearer token, and every response carries a proof computed with this
 * host's credential. No handshake state, no token exchange, no long-lived
 * session secret.
 *
 * @module dsh-lan-exec/server
 */

import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  constantEquals,
  hmac,
  open,
  requestKey,
  responseProof,
  seal,
} from './wire.js'
import { fingerprint } from './token.js'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Longest hold for one `session/poll`, in milliseconds. */
const MAX_POLL_MS = 25_000

/** How long a nonce is remembered, in milliseconds. */
const NONCE_TTL_MS = 120_000

/**
 * Read a JSON body with a hard size cap.
 * @param {http.IncomingMessage} request - incoming request.
 * @returns {Promise<unknown>} parsed JSON.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return undefined
  return JSON.parse(text)
}

/**
 * Write one sealed response with its proof header.
 * @param {http.ServerResponse} response - response.
 * @param {number} status - HTTP status.
 * @param {Buffer} key - per-request key.
 * @param {string} nonce - request nonce.
 * @param {string} executorToken - this host's credential.
 * @param {unknown} payload - JSON payload.
 */
function sendSealed(response, status, key, nonce, executorToken, payload) {
  const body = JSON.stringify(seal(key, ['res', nonce], payload))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-dshlan-proof': responseProof(executorToken, nonce, status, body),
  })
  response.end(body)
}

/**
 * Select the session whose permission context forwarded calls run under.
 * @param {{getAgents: () => any}} deps - service accessors.
 * @param {string} requested - configured session id or `auto`.
 * @returns {any} the agent, or undefined when no session is live.
 */
function resolveAgent({ getAgents }, requested) {
  const agents = getAgents()
  if (agents === undefined) return undefined
  if (requested !== 'auto' && requested !== '') {
    const pinned = typeof agents.get === 'function' ? agents.get(requested) : undefined
    if (pinned !== undefined) return pinned
  }
  const live = typeof agents.list === 'function' ? agents.list() : []
  return live.length > 0 ? live[0] : undefined
}

/**
 * Project one visible tool definition onto the wire schema the origin caches.
 * @param {any} schema - `ctx.tools.schemas()` row.
 * @returns {{name: string, description: string, parameters: any}} wire schema.
 */
function wireSchema(schema) {
  return {
    name: String(schema.name),
    description: typeof schema.description === 'string' ? schema.description : '',
    parameters: schema.parameters ?? { type: 'object', properties: {} },
  }
}

/**
 * Describe the live sessions the origin may target.
 * @param {{getAgents: () => any}} deps - service accessors.
 * @returns {Array<{id: string, title?: string, cwd?: string}>} session summaries.
 */
function listSessions(deps) {
  const agents = deps.getAgents()
  const list = agents !== undefined && typeof agents.list === 'function' ? agents.list() : []
  return list.slice(0, 32).map((agent) => ({
    id: String(agent?.id ?? agent?.session?.id ?? ''),
    ...(agent?.session?.title ? { title: String(agent.session.title) } : {}),
    ...(agent?.session?.cwd ? { cwd: String(agent.session.cwd) } : {}),
  }))
}

/**
 * Start the executor.
 * @param {object} options - executor options.
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - replicated data space.
 * @param {{getTools: Function, getAgents: Function, log: Function}} options.deps - host services.
 * @returns {{start: () => Promise<{port: number, host: string}>, stop: () => Promise<void>, describe: () => object}} handle.
 */
export function createBridgeServer({ config, deps, store }) {
  const log = deps.log
  const peers = new Map()
  const nonces = new Map()
  /** @type {http.Server | undefined} */
  let server
  let closing = false

  /**
   * @param {any} agent - live agent.
   * @returns {{id?: string, title?: string, cwd?: string} | undefined} session summary.
   */
  function sessionOf(agent) {
    if (agent === undefined) return undefined
    const session = agent.session
    return {
      ...(session?.id ? { id: String(session.id) } : {}),
      ...(session?.title ? { title: String(session.title) } : {}),
      ...(session?.cwd ? { cwd: String(session.cwd) } : {}),
    }
  }

  /**
   * Snapshot the tool surface for one agent scope.
   * @returns {{tools: Array<object>, session: object | undefined}} the snapshot.
   */
  function snapshotTools() {
    const tools = deps.getTools()
    const agent = resolveAgent(deps, config.session)
    const schemas = typeof tools.schemas === 'function' ? tools.schemas(agent) : []
    const filtered = schemas.filter((schema) => !config.hideTools.includes(schema.name) && schema.name !== config.localToolName)
    return { tools: filtered.map(wireSchema), session: sessionOf(agent) }
  }

  /**
   * One peer record, keyed by the credential fingerprint.
   * @param {string} name - peer name reported by the caller.
   * @returns {any} peer state.
   */
  function peerOf(name) {
    const id = fingerprint(config.peerToken)
    let peer = peers.get(id)
    if (peer === undefined) {
      peer = { id, name: name || 'origin', waiters: new Set(), activeCalls: 0, idleTimer: undefined, closed: false, reason: 'closed', lastSeen: Date.now() }
      peers.set(id, peer)
    }
    peer.lastSeen = Date.now()
    return peer
  }

  /**
   * Arm the idle deadline. It starts only after the last forwarded call has
   * settled, so a long-running call is never cut off by the idle rule.
   * @param {any} peer - peer state.
   */
  function armIdle(peer) {
    if (peer.idleTimer !== undefined) clearTimeout(peer.idleTimer)
    if (config.idleTimeoutMs <= 0) return
    peer.idleTimer = setTimeout(() => {
      log('warn', `origin ${peer.name} idle for ${Math.round(config.idleTimeoutMs / 1000)}s; closing the bridge`)
      closePeer(peer, 'idle-timeout')
    }, config.idleTimeoutMs)
    peer.idleTimer.unref?.()
  }

  /**
   * Drop one peer and wake every waiter with the reason.
   * @param {any} peer - peer state.
   * @param {string} reason - close reason.
   */
  function closePeer(peer, reason) {
    if (peer.closed) return
    peer.closed = true
    peer.reason = reason
    if (peer.idleTimer !== undefined) clearTimeout(peer.idleTimer)
    for (const waiter of peer.waiters) waiter(reason)
    peer.waiters.clear()
    peers.delete(peer.id)
    log('info', `bridge to ${peer.name} closed (${reason})`)
  }

  /**
   * Run one forwarded tool call through the local pipeline.
   * @param {any} peer - peer state.
   * @param {{name: string, arguments: unknown, callId?: string}} call - forwarded call.
   * @param {AbortSignal} signal - cancellation signal.
   * @returns {Promise<{content: unknown, isError?: boolean, value?: unknown}>} the model-facing result.
   */
  async function executeForwarded(peer, call, signal) {
    const tools = deps.getTools()
    const agent = resolveAgent(deps, config.session)
    if (agent === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'the paired host has no live session to execute this call in; open a session there and retry' }],
      }
    }
    const definition = typeof tools.get === 'function' ? tools.get(call.name, agent) : undefined
    if (definition === undefined) {
      return { isError: true, content: [{ type: 'text', text: `unknown remote tool "${call.name}"` }] }
    }
    if (config.allowedTools.length > 0 && !config.allowedTools.includes(call.name)) {
      return { isError: true, content: [{ type: 'text', text: `remote tool "${call.name}" is not on this bridge's allow list` }] }
    }

    const callId = typeof call.callId === 'string' && call.callId.length > 0 ? call.callId : `lan-${randomUUID()}`
    const result = await tools.execute({
      callId,
      name: call.name,
      arguments: call.arguments,
      agent,
      signal,
      // `parent` marks this as a nested sub-dispatch: it is not a model-direct
      // call, so a PTC-mode session still lets any visible tool run.
      parent: { kind: 'lan-exec', peer: peer.id },
    })
    return {
      content: result.content,
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.isError === true || result.value === undefined ? {} : { value: result.value }),
    }
  }

  /**
   * Dispatch one authenticated RPC frame.
   * @param {any} peer - peer state.
   * @param {string} method - RPC method.
   * @param {any} params - decoded parameters.
   * @param {AbortSignal} signal - cancellation signal.
   * @returns {Promise<any>} method result.
   */
  async function dispatch(peer, method, params, signal) {
    switch (method) {
      case 'ping':
        return { ok: true, at: Date.now() }
      case 'hello': {
        const snapshot = snapshotTools()
        peer.name = typeof params?.name === 'string' && params.name.length > 0 ? params.name.slice(0, 120) : peer.name
        peer.closed = false
        armIdle(peer)
        log('info', `origin ${peer.name} connected from ${peer.address ?? 'unknown'}`)
        return {
          v: PROTOCOL_VERSION,
          serverName: config.name,
          serverVersion: config.version,
          tools: snapshot.tools,
          session: snapshot.session,
          sessions: listSessions(deps),
          limits: {
            idleTimeoutMs: config.idleTimeoutMs,
            maxResultBytes: config.maxResultBytes,
            maxStoreBytes: store?.stat().maxBytes,
          },
        }
      }
      case 'tools/list': {
        const snapshot = snapshotTools()
        return { tools: snapshot.tools, session: snapshot.session, sessions: listSessions(deps) }
      }
      case 'tools/call': {
        if (typeof params?.name !== 'string' || params.name.length === 0) throw new Error('tools/call needs a tool name')
        const started = Date.now()
        peer.activeCalls += 1
        if (peer.idleTimer !== undefined) {
          clearTimeout(peer.idleTimer)
          peer.idleTimer = undefined
        }
        try {
          const outcome = await executeForwarded(peer, { name: params.name, arguments: params.arguments, callId: params.callId }, signal)
          return { ...outcome, elapsedMs: Date.now() - started }
        } finally {
          peer.activeCalls -= 1
          if (peer.activeCalls === 0 && !peer.closed) armIdle(peer)
        }
      }
      case 'session/poll': {
        if (peer.closed) return { alive: false, reason: peer.reason }
        const waitMs = Math.min(Math.max(1, Number(params?.timeoutMs) || MAX_POLL_MS), MAX_POLL_MS)
        const reason = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            peer.waiters.delete(waiter)
            resolve(undefined)
          }, waitMs)
          timer.unref?.()
          const waiter = (why) => {
            clearTimeout(timer)
            resolve(why)
          }
          peer.waiters.add(waiter)
          signal.addEventListener('abort', () => waiter('aborted'), { once: true })
        })
        return reason === undefined ? { alive: true } : { alive: false, reason }
      }
      case 'session/info':
        return { session: sessionOf(resolveAgent(deps, config.session)), sessions: listSessions(deps) }
      case 'store/apply': {
        if (store === undefined) throw new Error('this host mounted no data space')
        if (!['create', 'update', 'delete'].includes(params?.op)) throw new Error(`unknown store operation "${params?.op}"`)
        const outcome = store.mutate(params.op, params.key, params.value)
        return { ...outcome, digest: store.digest() }
      }
      case 'store/sync': {
        if (store === undefined) throw new Error('this host mounted no data space')
        return { ...store.export(Number(params?.since) || 0), digest: store.digest() }
      }
      case 'store/stat': {
        if (store === undefined) throw new Error('this host mounted no data space')
        return { ...store.stat(), digest: store.digest() }
      }
      default:
        throw new Error(`unknown method "${method}"`)
    }
  }

  /**
   * Authenticate and answer one request.
   * @param {http.IncomingMessage} request - request.
   * @param {http.ServerResponse} response - response.
   */
  async function handleRpc(request, response) {
    const authorization = String(request.headers.authorization ?? '')
    const token = authorization.startsWith('DshLan ') ? authorization.slice(7).trim() : ''
    if (token.length === 0 || !constantEquals(config.peerToken, token)) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"bad-credential"}')
      return
    }
    const nonce = String(request.headers['x-dshlan-nonce'] ?? '')
    if (nonce.length < 16 || nonce.length > 128) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"error":"bad-nonce"}')
      return
    }
    const now = Date.now()
    for (const [seen, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(seen)
    if (nonces.has(nonce)) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end('{"error":"replayed-nonce"}')
      return
    }

    const key = requestKey(token, config.token, nonce)
    let body
    try {
      body = await readJson(request)
    } catch {
      sendSealed(response, 400, key, nonce, config.token, { ok: false, error: { message: 'malformed body' } })
      return
    }
    const method = String(body?.method ?? '')
    let params
    try {
      params = open(key, ['req', nonce, method], body)
    } catch {
      sendSealed(response, 400, key, nonce, config.token, { ok: false, error: { message: 'unreadable envelope' } })
      return
    }
    if (method !== 'ping') nonces.set(nonce, now)

    const peer = peerOf(String(params?.name ?? ''))
    peer.address = request.socket.remoteAddress ?? peer.address
    const controller = new AbortController()
    const onClose = () => {
      if (!response.writableEnded) controller.abort()
    }
    response.on('close', onClose)
    try {
      const result = await dispatch(peer, method, params, controller.signal)
      sendSealed(response, 200, key, nonce, config.token, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `rpc ${method} failed: ${message}`)
      sendSealed(response, 200, key, nonce, config.token, { ok: false, error: { message } })
    } finally {
      response.off('close', onClose)
    }
  }

  return {
    /**
     * Bind the listener.
     * @returns {Promise<{port: number, host: string}>} bound address.
     */
    async start() {
      server = http.createServer((request, response) => {
        if (closing) {
          response.writeHead(503)
          response.end()
          return
        }
        if (request.method !== 'POST' || request.url !== '/v1/rpc') {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end('{"error":"not-found"}')
          return
        }
        void handleRpc(request, response).catch((error) => {
          log('error', `request failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) {
            response.writeHead(500)
            response.end()
          }
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.bind, () => {
          server.off('error', reject)
          resolve(undefined)
        })
      })
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : config.port
      log('info', `bridge listening on ${config.bind}:${port} as "${config.name}" (token ${fingerprint(config.token)})`)
      return { port, host: config.bind }
    },
    /**
     * Stop the listener and drop every peer.
     * @returns {Promise<void>} completion.
     */
    async stop() {
      closing = true
      for (const peer of [...peers.values()]) closePeer(peer, 'shutdown')
      if (server === undefined) return
      const instance = server
      server = undefined
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve(undefined)
        }
        const timer = setTimeout(finish, 2000)
        timer.unref?.()
        instance.close(() => {
          clearTimeout(timer)
          finish()
        })
        instance.closeAllConnections?.()
      })
    },
    describe() {
      return { peers: peers.size, bound: server !== undefined }
    },
  }
}

/**
 * Stable digest of the advertised tool surface, used by the origin to decide
 * whether its cached description is stale.
 * @param {Array<object>} tools - wire schemas.
 * @returns {string} short digest.
 */
export function toolSurfaceDigest(tools) {
  const canonical = JSON.stringify(tools.map((tool) => [tool.name, tool.parameters]))
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 12)
}
