/**
 * The local program tool (`run_ts`): what PTC mode's `run_code` does, worded
 * the same way, available in every presentation mode - plus the shared store.
 *
 * PTC mode reserves `run_code` and only exposes it while that presentation is
 * active; other modes have no program tool at all. This one closes that gap
 * with the same contract: an async TypeScript function body whose `tools.*`
 * calls go through the normal tool pipeline, and whose output is only what the
 * program prints or returns.
 *
 * @module dsh-lan-exec/local-tool
 */

import { randomUUID } from 'node:crypto'
import { renderOutcome, resolve as resolveProgram, run as runProgram } from './ptc-program.js'
import { renderToolsDeclaration } from './ptc-types.js'
import { storeBindings } from './store.js'

/** Same argument guidance PTC mode publishes for `run_code`. */
const DESCRIPTION_PARAM_DESCRIPTION =
  'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; "Read failing test and its fixture".'

/**
 * Turn one local tool call into its canonical JSON value.
 * @param {object} ctx - plugin context.
 * @param {string} name - local tool name.
 * @param {unknown} args - call arguments.
 * @param {any} agent - session scope the call runs in.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<unknown>} the tool's value, or its rendered text for tools without one.
 */
async function callLocalTool(ctx, name, args, agent, signal) {
  const result = await ctx.tools.execute({
    callId: `local-${randomUUID()}`,
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal,
    // Nested dispatch: not a model-direct call, so PTC-mode agents still allow it.
    parent: { kind: 'lan-exec-local' },
  })
  if (result?.isError === true) {
    const message = Array.isArray(result.content)
      ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      : 'tool failed'
    throw new Error(message.length > 0 ? message : 'tool failed')
  }
  if (result?.value !== undefined) return result.value
  const text = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : ''
  return text
}

/**
 * Build the model-facing description: PTC's `run_code` prose, the local tool
 * declarations, and the shared-store contract.
 * @param {object} options - description inputs.
 * @param {Array<object>} options.schemas - local tool schemas.
 * @param {object} options.storeStats - current store statistics.
 * @param {string} options.peerName - paired host label.
 * @returns {string} description.
 */
function describe({ schemas, storeStats, peerName }) {
  const declaration = renderToolsDeclaration(schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  })))

  return [
    'Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations below. Only what you print or return is program output - curate it.',
    '',
    'This deployment also mounts a shared data space, replicated on the paired LAN host:',
    '`store.create({ key, value })` fails when the key already exists, `store.update({ key, value })` requires it to exist,',
    '`store.read({ key })`, `store.delete({ key })`, `store.list({ prefix? })` and `store.stat()`. Keys are strings.',
    `Current usage: ${storeStats.entries} entries, ${storeStats.bytes} of ${storeStats.maxBytes} bytes. Both hosts keep the same copy.`,
    `The other end of the pair is ${peerName}.`,
    '',
    '```ts',
    'interface ToolArgsMap {',
    '}',
    'declare const tools: {',
    '  [name: string]: (args: Record<string, unknown>) => Promise<unknown>',
    '}',
    'declare const store: {',
    '  create(args: { key: string; value: unknown }): Promise<{ rev: number; key: string }>',
    '  update(args: { key: string; value: unknown }): Promise<{ rev: number; key: string }>',
    '  read(args: { key: string }): Promise<unknown>',
    '  delete(args: { key: string }): Promise<{ rev: number; key: string }>',
    '  list(args?: { prefix?: string }): Promise<Array<{ key: string; bytes: number; rev: number; updatedAt: number }>>',
    '  stat(): Promise<{ rev: number; entries: number; bytes: number; maxBytes: number }>',
    '}',
    '```',
    '',
    'Local tools declared by this deployment (program-only bindings; they are not separately callable model tools here):',
    '',
    '```ts',
    declaration,
    '```',
  ].join('\n')
}

/**
 * Publish the local program tool.
 * @param {object} options - tool options.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - replicated store.
 * @returns {() => void} disposer.
 */
export function exposeLocalProgramTool({ ctx, config, store }) {
  const schemas = ctx.tools
    .schemas(undefined)
    .filter((schema) => schema.name !== config.localToolName && schema.name !== 'run_code')

  const definition = {
    name: config.localToolName,
    description: describe({ schemas, storeStats: store.stat(), peerName: config.peerName }),
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The program: the body of an async TypeScript function.',
        },
        description: {
          type: 'string',
          description: DESCRIPTION_PARAM_DESCRIPTION,
        },
      },
      required: ['code', 'description'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const program = typeof args?.code === 'string' ? args.code : ''
      if (program.trim().length === 0) throw new Error('`code` must be a non-empty TypeScript program')

      const agent = exec?.agent
      const visible = ctx.tools
        .schemas(agent)
        .filter((schema) => schema.name !== config.localToolName && schema.name !== 'run_code')
      const functions = Object.create(null)
      for (const schema of visible) {
        functions[schema.name] = async (callArgs) => callLocalTool(ctx, schema.name, callArgs, agent, exec?.signal)
      }

      const spec = resolveProgram({
        program,
        bindings: [
          { global: 'tools', functions },
          { global: 'store', functions: storeBindings(store) },
        ],
        cwd: agent?.session?.cwd ?? process.cwd(),
        timeoutMs: config.callTimeoutMs,
      })
      const outcome = await runProgram(spec, { signal: exec?.signal })
      return renderOutcome(outcome)
    },
  }
  return ctx.tools.register(definition)
}
