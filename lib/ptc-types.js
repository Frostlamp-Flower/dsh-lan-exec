/**
 * JSON-Schema -> TypeScript projection, adapted from the harness's own PTC
 * renderer (`dsh-tools/src/ts-types.ts`).
 *
 * The upstream renderer guards every node with `assertSupportedJsonSchema`
 * before rendering. The bridge cannot import that internal module, so this copy
 * validates defensively while rendering and degrades to `unknown` instead of
 * throwing: a hostile or unusual schema must never break tool registration.
 *
 * @module dsh-lan-exec/ptc-types
 */

/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Render an object key: bare when it is a valid identifier, quoted otherwise.
 * @param {string} name - key text.
 * @returns {string} key source.
 */
function renderKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/**
 * One `indent`-deep line prefix (two spaces per level).
 * @param {number} indent - indentation depth.
 * @returns {string} prefix.
 */
function pad(indent) {
  return '  '.repeat(indent)
}

/**
 * A one-line JSDoc block for a schema description.
 * @param {unknown} description - schema description.
 * @param {number} indent - indentation depth.
 * @returns {string[]} zero or one line.
 */
export function docLines(description, indent) {
  if (typeof description !== 'string' || description.length === 0) return []
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/**
 * Render a validated scalar `const`/`enum`, falling back to the broad type.
 * @param {any} node - schema node.
 * @param {string} type - declared scalar type.
 * @returns {string} type source.
 */
function renderConstrainedScalar(node, type) {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const)
  if (Object.hasOwn(node, 'enum')) return node.enum.map((value) => JSON.stringify(value)).join(' | ')
  return broad
}

/**
 * Map one JSON-Schema node to a TypeScript type literal. Supports the construct
 * set the tool registry can emit and returns `unknown` for anything malformed or
 * unsupported, without throwing.
 * @param {any} schema - JSON-Schema node.
 * @param {number} [indent] - indentation level for nested object members.
 * @param {number} [depth] - recursion guard.
 * @returns {string} TypeScript type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema, indent = 0, depth = 0) {
  try {
    const node = schema && typeof schema === 'object' ? schema : {}
    if (depth > 8) return 'unknown'
    if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
      const parts = node.oneOf.map((part) => jsonSchemaToTs(part, indent, depth + 1))
      return parts.length === 1 ? parts[0] : `(${parts.join(' | ')})`
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      return renderConstrainedScalar(node, node.type ?? 'string')
    }
    if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const)

    const type = Array.isArray(node.type) ? node.type[0] : node.type
    switch (type) {
      case 'string':
        return 'string'
      case 'number':
      case 'integer':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'null':
        return 'null'
      case 'array': {
        const items = jsonSchemaToTs(node.items, indent, depth + 1)
        return items.includes(' | ') || items.includes('&') ? `(${items})[]` : `${items}[]`
      }
      case 'object':
      case undefined: {
        const properties = node.properties && typeof node.properties === 'object' ? node.properties : undefined
        if (properties === undefined || Object.keys(properties).length === 0) {
          return node.additionalProperties === false ? 'Record<string, never>' : 'Record<string, unknown>'
        }
        const required = new Set(Array.isArray(node.required) ? node.required : [])
        const members = []
        for (const [key, value] of Object.entries(properties)) {
          const optional = required.has(key) ? '' : '?'
          members.push(`${pad(indent + 1)}${renderKey(key)}${optional}: ${jsonSchemaToTs(value, indent + 1, depth + 1)}`)
        }
        return `{\n${members.join('\n')}\n${pad(indent)}}`
      }
      default:
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

/** Portable JSON alias carried next to the generated declarations. */
export const JSON_VALUE_ALIAS =
  'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'

/**
 * Render the complete `tools` declaration for one remote tool set.
 *
 * The interface pair (`ToolArgsMap`/`ToolOutputMap`) plus the keyed `declare
 * const tools` is the same shape the model already reads in PTC mode, so a
 * program written against `run_code` transfers without relearning.
 *
 * @param {Array<{name: string, description?: string, parameters?: any, output?: any}>} tools - remote schemas, already keyed by binding name.
 * @returns {string} TypeScript declaration source.
 */
export function renderToolsDeclaration(tools) {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const argsMembers = []
  const outputMembers = []
  for (const tool of sorted) {
    argsMembers.push(...docLines(tool.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(tool.name)}: ${jsonSchemaToTs(tool.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(tool.name)}: ${jsonSchemaToTs(tool.output, 1)};`)
  }
  const argsMap = `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`
  const outputMap = `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')
  return `${JSON_VALUE_ALIAS}\n\n${declaration}`
}
