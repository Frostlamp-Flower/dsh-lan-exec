import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, resolveConfig, assertConfig } from '../lib/index.js'
import { generateToken, fingerprint } from '../lib/token.js'
import { jsonSchemaToTs } from '../lib/ptc-types.js'
import { run as runProgram, resolve as resolveProgram, renderOutcome } from '../lib/ptc-program.js'
import { assignBindings } from '../lib/sdk.js'
import { createStore } from '../lib/store.js'

/** Minimal host fake: a tool registry plus inert agent/logger services. */
function createHost({ tools = [], agentless = false } = {}) {
  const registry = new Map()
  const effects = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: {
      register(definition) {
        assert.equal(registry.has(definition.name), false, `duplicate tool ${definition.name}`)
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      schemas() {
        return [...registry.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }))
      },
      get(name) {
        return registry.get(name)
      },
      async execute(exec) {
        const definition = registry.get(exec.name)
        if (definition === undefined) return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] }
        try {
          const value = await definition.execute(exec.arguments, { signal: exec.signal, agent: exec.agent })
          return { value, content: definition.output.render(exec.arguments, value), isError: false }
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }
        }
      },
    },
    get(name) {
      if (name !== 'agents') return undefined
      if (agentless) return { list: () => [], get: () => undefined }
      return {
        list: () => [{ id: 'sess-1', session: { id: 'sess-1', title: 'Test session', cwd: process.cwd() } }],
        get: () => undefined,
      }
    },
    effect(fn) {
      effects.push(fn())
    },
    async close() {
      for (const dispose of effects.reverse()) {
        if (typeof dispose === 'function') await dispose()
      }
    },
  }
  for (const tool of tools) ctx.tools.register(tool)
  return ctx
}

/** Unique loopback port per test. */
function port() {
  return 45000 + Math.floor(Math.random() * 10000)
}

/** One throwaway data-space file. */
function storeFile(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `lan-exec-${label}-`)), 'store.json')
}

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function echoTool() {
  return {
    name: 'echo',
    description: 'Echo the argument back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      return `echo:${args.text}`
    },
  }
}

function failingTool() {
  return {
    name: 'boom',
    description: 'Always throws',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      throw new Error('remote exploded')
    },
  }
}

/** Bring up one paired server/client pair. */
function pair({ idleTimeoutMs, serverTools = [echoTool(), failingTool()], clientConfig = {} } = {}) {
  const portNumber = port()
  const serverToken = generateToken()
  const clientToken = generateToken()
  const serverCtx = createHost({ tools: serverTools })
  const clientCtx = createHost()
  const serverStoreFile = storeFile('server')
  const clientStoreFile = storeFile('client')

  apply(serverCtx, {
    role: 'server',
    port: portNumber,
    bind: '127.0.0.1',
    token: serverToken,
    peerToken: clientToken,
    name: 'peer-host',
    storeFile: serverStoreFile,
    localTool: false,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
  })
  apply(clientCtx, {
    role: 'client',
    host: '127.0.0.1',
    port: portNumber,
    token: clientToken,
    peerToken: serverToken,
    name: 'local-host',
    peerName: 'peer-host',
    toolName: 'remote_run',
    storeFile: clientStoreFile,
    localTool: false,
    ...clientConfig,
  })

  return {
    serverCtx,
    clientCtx,
    portNumber,
    serverStoreFile,
    clientStoreFile,
    async close() {
      await clientCtx.close()
      await serverCtx.close()
    },
  }
}

test('tokens are 256-bit, prefixed and fingerprinted without revealing the secret', () => {
  const token = generateToken()
  assert.match(token, /^dshlan_[A-Za-z0-9_-]{43}$/)
  assert.equal(fingerprint(token).length, 10)
  assert.notEqual(generateToken(), generateToken())
})

test('json schema renders as a TypeScript type', () => {
  const text = jsonSchemaToTs({
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['path'],
  })
  assert.match(text, /path: string/)
  assert.match(text, /limit\?: number/)
  assert.match(text, /tags\?: string\[\]/)
})

test('binding names are portable and collision free', () => {
  const map = assignBindings([{ name: 'read-file' }, { name: 'read.file' }, { name: '9lives' }])
  assert.deepEqual([...map.values()], ['read_file', 'read_file_2', '_9lives'])
})

test('program runs against forwarded bindings and reports logs plus value', async () => {
  const calls = []
  const spec = resolveProgram({
    program: 'console.log("starting"); const a = await tools.echo({ text: "hi" }); return { a, n: 2 as number }',
    bindings: [{ global: 'tools', functions: { echo: async (args) => { calls.push(args); return `echo:${args.text}` } } }],
    cwd: process.cwd(),
  })
  const result = await runProgram(spec)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ text: 'hi' }])
  assert.deepEqual(result.logs, ['starting'])
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { a: 'echo:hi', n: 2 })
  assert.equal(renderOutcome(result).includes('starting'), true)
})

test('a rejected binding surfaces as a ToolCallError inside the program', async () => {
  const spec = resolveProgram({
    program: 'try { await tools.boom({}); return "no" } catch (e) { return `${e.name}:${e.message}` }',
    bindings: [{ global: 'tools', functions: { boom: async () => { throw new Error('remote exploded') } } }],
    cwd: process.cwd(),
  })
  const result = await runProgram(spec)
  assert.equal(result.value, 'ToolCallError:remote exploded')
})

test('the data space enforces create/update semantics and survives a reload', () => {
  const file = storeFile('unit')
  const store = createStore({ file, maxBytes: 4096 })
  store.load()
  store.mutate('create', 'alpha', { n: 1 })
  assert.throws(() => store.mutate('create', 'alpha', { n: 2 }), /already exists/)
  assert.deepEqual(store.read('alpha'), { n: 1 })
  store.mutate('update', 'alpha', { n: 3 })
  assert.deepEqual(store.read('alpha'), { n: 3 })
  assert.throws(() => store.mutate('update', 'missing', 1), /does not exist/)
  assert.deepEqual(store.list('').map((row) => row.key), ['alpha'])

  const again = createStore({ file, maxBytes: 4096 })
  again.load()
  assert.deepEqual(again.read('alpha'), { n: 3 })

  again.mutate('delete', 'alpha')
  assert.throws(() => again.read('alpha'), /does not exist/)
})

test('config validation rejects a self-pairing and the reserved name', () => {
  const selfPaired = resolveConfig({ role: 'client', host: '127.0.0.1', token: 'a'.repeat(48), peerToken: 'a'.repeat(48) })
  assert.throws(() => assertConfig(selfPaired), /different credentials/)
  const reserved = resolveConfig({ role: 'client', host: '127.0.0.1', token: 'a'.repeat(48), peerToken: 'b'.repeat(48), toolName: 'run_code' })
  assert.throws(() => assertConfig(reserved), /reserved/)
})

test('end to end: the tool appears while paired, forwards calls and retracts', async () => {
  const fixed = pair()
  try {
    await waitFor(() => fixed.clientCtx.tools.get('remote_run') !== undefined, { label: 'tool registration' })

    const definition = fixed.clientCtx.tools.get('remote_run')
    assert.match(definition.description, /never leaves this machine/)
    assert.match(definition.description, /echo: \{\s*text: string\s*\};/)
    assert.match(definition.description, /store\.create/)

    const result = await definition.execute(
      { code: 'const first = await tools.echo({ text: "one" }); const second = await tools.echo({ text: "two" }); return [first, second]', description: 'two echoes' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(JSON.parse(result), ['echo:one', 'echo:two'])

    const failure = await definition.execute(
      { code: 'try { await tools.boom({}); return "unreachable" } catch (error) { return error.name }', description: 'boom' },
      { signal: new AbortController().signal },
    )
    assert.equal(failure, 'ToolCallError')

    const stored = await definition.execute(
      { code: 'await store.create({ key: "lan/one", value: { hello: "world" } }); return await store.read({ key: "lan/one" })', description: 'store round trip' },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(JSON.parse(stored), { hello: 'world' })
  } finally {
    await fixed.close()
  }
  assert.equal(fixed.clientCtx.tools.get('remote_run'), undefined)
})

test('both ends persist the same data space', async () => {
  const fixed = pair()
  try {
    await waitFor(() => fixed.clientCtx.tools.get('remote_run') !== undefined, { label: 'tool registration' })
    await fixed.clientCtx.tools.get('remote_run').execute(
      { code: 'await store.create({ key: "shared", value: [1, 2, 3] })', description: 'write a shared entry' },
      { signal: new AbortController().signal },
    )
    const serverCopy = JSON.parse(fs.readFileSync(fixed.serverStoreFile, 'utf8'))
    const clientCopy = JSON.parse(fs.readFileSync(fixed.clientStoreFile, 'utf8'))
    assert.deepEqual(serverCopy.entries.shared.value, [1, 2, 3])
    assert.deepEqual(clientCopy.entries.shared.value, [1, 2, 3])
  } finally {
    await fixed.close()
  }
})

test('a wrong credential never exposes the tool', async () => {
  const portNumber = port()
  const serverCtx = createHost({ tools: [echoTool()] })
  const clientCtx = createHost()
  try {
    apply(serverCtx, {
      role: 'server',
      port: portNumber,
      bind: '127.0.0.1',
      token: generateToken(),
      peerToken: generateToken(),
      name: 'peer-host',
      storeFile: storeFile('server'),
      localTool: false,
    })
    apply(clientCtx, {
      role: 'client',
      host: '127.0.0.1',
      port: portNumber,
      token: generateToken(),
      peerToken: generateToken(),
      name: 'local-host',
      autoReconnect: false,
      storeFile: storeFile('client'),
      localTool: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(clientCtx.tools.get('remote_run'), undefined)
  } finally {
    await clientCtx.close()
    await serverCtx.close()
  }
})

test('idle timeout closes the session and retracts the tool', async () => {
  const fixed = pair({ idleTimeoutMs: 400 })
  try {
    await waitFor(() => fixed.clientCtx.tools.get('remote_run') !== undefined, { label: 'tool registration' })
    await waitFor(() => fixed.clientCtx.tools.get('remote_run') === undefined, { timeoutMs: 6000, label: 'idle retraction' })
  } finally {
    await fixed.close()
  }
})

test('the local program tool runs TypeScript against local tools and the store', async () => {
  const ctx = createHost({ tools: [echoTool()] })
  try {
    apply(ctx, {
      role: 'client',
      host: '127.0.0.1',
      port: 9,
      token: generateToken(),
      peerToken: generateToken(),
      name: 'local-host',
      autoReconnect: false,
      storeFile: storeFile('local'),
    })
    const definition = ctx.tools.get('run_ts')
    assert.ok(definition, 'run_ts is registered')
    assert.match(definition.description, /shared data space/)
    assert.match(definition.description, /store\.create/)

    const output = await definition.execute(
      {
        code: 'const echoed = await tools.echo({ text: "local" }); await store.create({ key: "local/one", value: echoed }); return await store.read({ key: "local/one" })',
        description: 'local program',
      },
      { signal: new AbortController().signal, agent: ctx.get('agents').list()[0] },
    )
    assert.equal(output, 'echo:local')
  } finally {
    await ctx.close()
  }
})


