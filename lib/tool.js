/**
 * The single model-facing tool of the controlling side.
 *
 * It is shaped like `run_code` - `{ code, description }` - because the model
 * already knows how to write programs that call tools. What differs is only
 * where the bindings lead: every `tools.*(args)` stub forwards over the bridge
 * instead of into the local registry.
 *
 * @module dsh-lan-exec/tool
 */

import { resolve as resolveProgram, run as runProgram, renderOutcome } from './ptc-program.js'

/**
 * Publish the bridge tool into the local registry.
 * @param {object} options - tool options.
 * @param {object} options.ctx - plugin context (must own `tools`).
 * @param {object} options.config - resolved plugin config.
 * @param {string} options.description - generated model-facing description.
 * @param {Array<object>} options.remote - remote wire schemas.
 * @param {Map<string, string>} options.bindings - wire name to binding name.
 * @param {Record<string, Function>} [options.store] - shared-store binding functions.
 * @param {(name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>} options.call - one forwarded call.
 * @returns {() => void} disposer that unregisters the tool.
 */
export function exposeTool({ ctx, config, description, remote, bindings, store, call }) {
  const definition = {
    name: config.toolName,
    description,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The body of an async TypeScript program whose tool calls are forwarded to the paired host. Use `return` and/or `console.log(...)` for output.',
        },
        description: {
          type: 'string',
          description: 'A short summary of what this remote program does, shown to the user.',
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

      const functions = Object.create(null)
      for (const [wireName, binding] of bindings) {
        functions[binding] = async (callArgs) => call(wireName, callArgs, exec?.signal)
      }

      const spec = resolveProgram({
        program,
        bindings: [
          { global: 'tools', functions },
          ...(store === undefined ? [] : [{ global: 'store', functions: store }]),
        ],
        cwd: exec?.agent?.session?.cwd ?? process.cwd(),
        timeoutMs: config.callTimeoutMs,
      })
      const outcome = await runProgram(spec, { signal: exec?.signal })
      return renderOutcome(outcome)
    },
  }

  return ctx.tools.register(definition)
}
