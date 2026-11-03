/**
 * Program worker: the isolated thread that evaluates a model-written program.
 *
 * The harness's PTC runtime runs each program in a fresh managed Node process.
 * A worker thread gives the same two properties this bridge depends on -- the
 * program never shares the host's realm, and a runaway program can be killed
 * outright (`worker.terminate()` works even inside a synchronous loop) -- while
 * staying inside the host process, which is what the plugin packaging allows.
 *
 * The worker owns no policy and no tools. Its only capability is a `call`
 * message to the parent, which answers with the result of one binding
 * invocation; the parent therefore stays the single place where approval,
 * sandbox and tool policy apply.
 *
 * Message protocol:
 *   parent -> worker : { type: 'run', code, timeoutMs }
 *   worker -> parent : { type: 'call', id, name, args }
 *   parent -> worker : { type: 'result', id, ok, value?, error? }
 *   worker -> parent : { type: 'done', value?, logs, error? }
 *
 * @module dsh-lan-exec/worker
 */

import { parentPort } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'

/** Type stripping happens here, so the parent only ever ships source text. */
const STRIP_PREFIX = 'async function __dsh_program__(tools, store, console) {\n'
const STRIP_SUFFIX = '\n}'

const pending = new Map()
let nextCallId = 1
const logs = []
let logBytes = 0
const MAX_LOG_BYTES = 256 * 1024

/**
 * Format one console argument for the captured log.
 * @param {unknown} value - logged value.
 * @returns {string} rendered text.
 */
function format(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/**
 * Capture one log line, bounded.
 * @param {unknown[]} args - console arguments.
 */
function log(...args) {
  if (logBytes >= MAX_LOG_BYTES) return
  const line = args.map(format).join(' ')
  logBytes += line.length
  logs.push(line)
}

/**
 * Ask the parent to invoke one binding.
 * @param {string} name - binding name.
 * @param {unknown} args - call arguments.
 * @returns {Promise<unknown>} the binding's value.
 */
function callParent(name, args) {
  const id = nextCallId++
  parentPort.postMessage({ type: 'call', id, name, args })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, name })
  })
}

/**
 * The `tools` proxy the program sees: every property is one binding call.
 * @returns {object} proxy.
 */
function toolsProxy() {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      return (args) => callParent(key, args ?? {})
    },
    has: () => true,
  })
}

/**
 * The `store` namespace; every method is one parent round trip.
 * @returns {Record<string, Function>} store namespace.
 */
function storeProxy() {
  return {
    create: (args) => callParent('store.create', args),
    update: (args) => callParent('store.update', args),
    read: (args) => callParent('store.read', args),
    delete: (args) => callParent('store.delete', args),
    list: (args) => callParent('store.list', args ?? {}),
    stat: () => callParent('store.stat', {}),
  }
}

/**
 * JSON-normalize a program result; `undefined` means "no value".
 * @param {unknown} value - raw value.
 * @returns {unknown} JSON value.
 */
function normalize(value) {
  if (value === undefined) return undefined
  const json = JSON.stringify(value)
  return json === undefined ? undefined : JSON.parse(json)
}

/**
 * Run one program body and report the outcome.
 * @param {{code: string}} message - run request.
 */
async function run({ code }) {
  let value
  let error
  try {
    const source = stripTypeScriptTypes(STRIP_PREFIX + code + STRIP_SUFFIX)
    const factory = new Function(`${source}\nreturn __dsh_program__`)
    const program = factory()
    value = normalize(await program(toolsProxy(), storeProxy(), {
      log,
      info: log,
      warn: log,
      error: log,
      debug: () => {},
    }))
  } catch (failure) {
    error = {
      kind: 'exception',
      message: failure instanceof Error ? failure.message : String(failure),
    }
  }
  parentPort.postMessage({
    type: 'done',
    ...(error === undefined ? { value } : { error }),
    logs,
  })
}

parentPort.on('message', (message) => {
  if (message?.type === 'result') {
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.ok === true) {
      waiter.resolve(message.value)
    } else {
      const error = new Error(message.error ?? `binding "${waiter.name}" failed`)
      error.name = 'ToolCallError'
      error.toolName = waiter.name
      waiter.reject(error)
    }
    return
  }
  if (message?.type === 'run') void run(message)
})

process.on('unhandledRejection', () => {})
// `stripTypeScriptTypes` still announces itself as experimental on every worker;
// one filtered listener keeps the host log readable without hiding other warnings.
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('stripTypeScriptTypes')) return
  console.warn(`${warning.name}: ${warning.message}`)
})
