/**
 * Model-facing presentation of one connected peer.
 *
 * The tool set is rendered with the vendored PTC declaration renderer
 * (`ptc-types.js`), so the block a model reads here has the same shape as the
 * one it already reads inside `run_code`. Only the prose differs: it has to say
 * that the program runs against another machine and that the source stays home.
 *
 * @module dsh-lan-exec/sdk
 */

import { renderToolsDeclaration } from './ptc-types.js'

/**
 * A portability-safe binding name for one remote tool: the program namespace
 * accepts only `[A-Za-z_][A-Za-z0-9_]*`, so `mcp__fs.read` becomes
 * `mcp__fs_read`. Collisions are resolved by {@link assignBindings}.
 * @param {string} name - wire tool name.
 * @returns {string} candidate binding name.
 */
export function bindingName(name) {
  let out = String(name).replace(/[^A-Za-z0-9_]/g, '_')
  if (out.length === 0) out = 'tool'
  if (!/^[A-Za-z_]/.test(out)) out = '_' + out
  return out
}

/**
 * Assign a collision-free binding name to every remote tool.
 * @param {Array<{name: string}>} tools - remote schemas.
 * @returns {Map<string, string>} wire name to binding name.
 */
export function assignBindings(tools) {
  const used = new Set()
  const map = new Map()
  for (const tool of tools) {
    const base = bindingName(tool.name)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) candidate = `${base}_${suffix++}`
    used.add(candidate)
    map.set(tool.name, candidate)
  }
  return map
}

/**
 * Rewrite remote schemas onto their binding names so the declaration renderer
 * sees the names the program will actually use.
 * @param {Array<{name: string, description?: string, parameters?: any, output?: any}>} tools - remote schemas.
 * @param {Map<string, string>} bindings - wire name to binding name.
 * @returns {Array<object>} schemas keyed by binding name.
 */
function boundSchemas(tools, bindings) {
  return tools
    .filter((tool) => bindings.has(tool.name))
    .map((tool) => ({ ...tool, name: bindings.get(tool.name) }))
}

/**
 * Build the model-facing description of the bridge tool.
 *
 * The text answers the questions the model cannot infer from the schema: where
 * calls execute, what actually travels over the network, which namespace the
 * program can reach, and - when the session presents tools through PTC - that
 * this tool is reached from inside `run_code`, one level down.
 *
 * @param {object} input - description inputs.
 * @param {string} input.peerName - remote host label.
 * @param {{id?: string, title?: string, cwd?: string}} [input.session] - remote session calls run in.
 * @param {Array<{name: string, description?: string, parameters?: any, output?: any}>} input.tools - remote schemas.
 * @param {Map<string, string>} input.bindings - wire name to binding name.
 * @param {string} input.toolName - this bridge tool's own registered name.
 * @param {boolean} input.ptcPresentation - whether the local agent presents tools as PTC.
 * @returns {string} tool description.
 */
export function renderDescription({ peerName, session, tools, bindings, toolName, ptcPresentation }) {
  const target = session?.title ? `${peerName} (remote session "${session.title}")` : peerName
  const declaration = renderToolsDeclaration(boundSchemas(tools, bindings))
  const count = tools.length

  const nesting = ptcPresentation
    ? [
        'This session presents tools through PTC: `run_code` is the only directly callable tool, and this bridge is',
        `one of the tools that program may call. Reach it as \`await tools.${toolName}({ code, description })\`, then`,
        'write the remote program inside that `code` string. The two layers are independent: the outer program runs',
        'here, the inner one runs on the peer.',
      ]
    : ['Call this tool directly with `code` and `description`, the same shape `run_code` uses.']

  return [
    `Run a TypeScript program whose tool calls are forwarded to ${target}, another DeepSeek Harness host on this LAN.`,
    '',
    'What crosses the network: each individual tool call - tool name, JSON arguments, and the result. The program',
    'source never leaves this machine. The peer receives calls, not code, and never sees this program, your reasoning,',
    'or the local conversation.',
    '',
    ...nesting,
    '',
    `Inside the remote program you can call only the ${count} tool${count === 1 ? '' : 's'} declared below. Local tools`,
    '(read, write, edit, bash/pwsh, web, subagents, jobs, ...) are NOT available inside it - they stay available to',
    'you as ordinary tools, outside it. Paths inside the program are paths on the peer, not on this machine.',
    '',
    'Program rules:',
    '- `await tools.name(args)` calls a remote tool and resolves to its typed result.',
    '- A failed remote call rejects with `ToolCallError`; `try/catch` it to continue.',
    '- Independent calls MAY overlap with `Promise.all`; calls that mutate run in submission order.',
    '- `return` and/or `console.log(...)` produce output. Only printed or returned text reaches you.',
    '- The peer applies its own approval, sandbox and filesystem policy to every forwarded call, exactly as if its',
    '  user had invoked that tool there. A call the peer denies fails; it does not fall back to running locally.',
    '',
    'The program also gets `store`, the data space both hosts replicate:',
    '`store.create({ key, value })` (fails when the key exists), `store.update({ key, value })`, `store.read({ key })`,',
    '`store.delete({ key })`, `store.list({ prefix? })`, `store.stat()`. Keys are strings.',
    '',
    'Remote tool bindings (program-only; they are not separately callable model tools):',
    '',
    '```ts',
    declaration,
    '```',
  ].join('\n')
}
