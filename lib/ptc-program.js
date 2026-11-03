/**
 * Program execution for the bridge tools, built the way the harness's PTC
 * runtime builds it: a fresh isolated runtime per program, a message channel for
 * binding calls, and structured results back to the caller.
 *
 * The contract is deliberately the same shape as the seam `run_code` uses:
 *
 *   resolve({ program, bindings, cwd, timeoutMs }) -> spec
 *   run(spec) -> { value, logs, error }
 *
 * The type-stripping wrapper, the `function-body` syntax, log capture, the
 * `ToolCallError` rejection, and the failure kinds are copied from that runtime
 * so a model sees the same behavior it knows from `run_code`.
 *
 * @module dsh-lan-exec/ptc-program
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))

/** Default wall-clock budget for one program. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Upper bound accepted for one program. */
export const MAX_TIMEOUT_MS = 600_000

/**
 * Clamp a requested budget into the supported range.
 * @param {unknown} value - requested milliseconds.
 * @param {number} fallback - default when omitted.
 * @returns {number} positive finite budget.
 */
export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined || value === null) return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(Math.max(1, Math.floor(numeric)), MAX_TIMEOUT_MS)
}

/**
 * Validate a binding namespace list, mirroring the seam's portability rules.
 * @param {unknown} bindings - candidate namespaces.
 * @returns {Array<{global: string, functions: Record<string, Function>}>} validated namespaces.
 */
export function validateBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error('bindings must be a non-empty array')
  const seen = new Set()
  return bindings.map((namespace) => {
    const name = namespace?.global
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid binding global ${JSON.stringify(name)}`)
    }
    if (seen.has(name)) throw new Error(`duplicate binding global "${name}"`)
    seen.add(name)
    if (name === 'console' || name === '__dsh_program__') throw new Error(`binding global "${name}" is reserved`)
    const functions = namespace?.functions
    if (functions === null || typeof functions !== 'object') throw new Error(`binding "${name}" needs a functions object`)
    for (const [key, value] of Object.entries(functions)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid binding name "${key}" in "${name}"`)
      if (typeof value !== 'function') throw new Error(`binding "${name}.${key}" is not a function`)
    }
    return { global: name, functions }
  })
}

/**
 * Resolve one request into a runnable spec.
 * @param {{program: string, bindings: unknown, cwd?: string, timeoutMs?: number}} request - caller inputs.
 * @returns {{program: string, bindings: Array<{global: string, functions: Record<string, Function>}>, cwd: string, timeoutMs: number}} resolved spec.
 */
export function resolve(request) {
  if (typeof request?.program !== 'string') throw new Error('program must be a string')
  const cwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : process.cwd()
  return {
    program: request.program,
    bindings: validateBindings(request.bindings),
    cwd,
    timeoutMs: clampTimeout(request.timeoutMs),
  }
}

/**
 * Flatten namespaces into the wire names the worker uses: `tools.foo` is
 * addressed as `foo`, every other namespace as `<global>.<name>`.
 * @param {Array<{global: string, functions: Record<string, Function>}>} bindings - namespaces.
 * @returns {Map<string, Function>} flat handler map.
 */
function flatten(bindings) {
  const handlers = new Map()
  for (const namespace of bindings) {
    for (const [name, fn] of Object.entries(namespace.functions)) {
      handlers.set(namespace.global === 'tools' ? name : `${namespace.global}.${name}`, fn)
    }
  }
  return handlers
}

/**
 * Run one program in a fresh worker thread.
 * @param {{program: string, bindings: Array<{global: string, functions: Record<string, Function>}>, cwd: string, timeoutMs: number}} spec - resolved spec.
 * @param {{signal?: AbortSignal}} [options] - caller cancellation.
 * @returns {Promise<{value?: unknown, logs: string[], error?: {kind: string, message: string}}>} program outcome.
 */
export async function run(spec, options = {}) {
  const handlers = flatten(spec.bindings)
  const logs = []

  let worker
  try {
    worker = new Worker(WORKER_PATH, { argv: [] })
  } catch (error) {
    return { logs, error: { kind: 'worker-exit', message: `could not start the program worker: ${error.message}` } }
  }

  let settled = false
  let timer
  const finish = (resolve, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    void worker.terminate()
    resolve(value)
  }

  let resolveOutcome
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve
  })

  const onAbort = () => finish(resolveOutcome, { logs, error: { kind: 'abort', message: 'program aborted by the caller' } })
  options.signal?.addEventListener('abort', onAbort, { once: true })

  timer = setTimeout(() => {
    finish(resolveOutcome, { logs, error: { kind: 'timeout', message: `execution deadline reached (${spec.timeoutMs}ms)` } })
  }, spec.timeoutMs)
  timer.unref?.()

  worker.on('message', (message) => {
    if (message?.type === 'call') {
      const handler = handlers.get(message.name)
      if (handler === undefined) {
        worker.postMessage({ type: 'result', id: message.id, ok: false, error: `unknown binding "${message.name}"` })
        return
      }
      Promise.resolve()
        .then(() => handler(message.args))
        .then((value) => worker.postMessage({ type: 'result', id: message.id, ok: true, value: value ?? null }))
        .catch((error) => worker.postMessage({
          type: 'result',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      return
    }
    if (message?.type === 'done') {
      for (const entry of Array.isArray(message.logs) ? message.logs : []) logs.push(String(entry))
      finish(resolveOutcome, {
        logs,
        ...(message.error === undefined ? { value: message.value } : { error: message.error }),
      })
    }
  })

  worker.on('error', (error) => {
    finish(resolveOutcome, { logs, error: { kind: 'worker-exit', message: `program worker failed: ${error.message}` } })
  })
  worker.on('exit', (code) => {
    finish(resolveOutcome, { logs, error: { kind: 'worker-exit', message: `program worker exited (${code}) before reporting a result` } })
  })

  worker.postMessage({ type: 'run', code: spec.program })
  return outcome
}

/**
 * Render one program outcome as the text the model receives, mirroring the
 * `run_code` result format: printed lines first, then the returned value.
 * @param {{value?: unknown, logs: string[], error?: {kind: string, message: string}}} result - program outcome.
 * @returns {string} model-facing text.
 */
export function renderOutcome(result) {
  const body = []
  body.push(...(result.logs ?? []))
  if (result.value !== undefined) {
    // A string result is the program's answer as written; quoting it would make
    // every text-returning program look like JSON.
    body.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
  }
  const text = body.join('\n')
  if (result.error === undefined) return text.length > 0 ? text : '(program completed with no output)'
  const message = `Error: program failed (${result.error.kind}): ${result.error.message}`
  return text.length > 0 ? `${message}\n\nCaptured output:\n${text}` : message
}
