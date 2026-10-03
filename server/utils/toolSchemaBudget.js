import { Buffer } from 'node:buffer'
import { isPlainObject } from './toolCallPrimitives.js'

export const TOOL_SCHEMA_LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 96, arrayItems: 2048 })
export const TOOL_ARGUMENT_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, nodes: 32768, depth: 64, arrayItems: 10000 })

export function schemaPolicyError(reason) {
  return Object.assign(new Error('Unsupported tool schema policy'), { code: 'tool_schema_unsupported', reason })
}

export function argumentBudgetError(reason = 'validation_work') {
  return Object.assign(new Error('Tool argument validation budget exceeded'), { code: 'tool_arguments_budget_exceeded', reason })
}

function invalidJson() {
  return Object.assign(new Error('Tool inputs must be finite, acyclic JSON data'), { code: 'invalid_tool_arguments' })
}

/** Bound traversal before JSON serialization, default expansion or validator execution. */
export function measureToolJson(value, limits = TOOL_ARGUMENT_LIMITS) {
  const stats = { bytes: 0, nodes: 0, depth: 0, maxArrayLength: 0 }
  const active = new WeakSet()
  const stack = [{ value, depth: 0 }]
  while (stack.length) {
    const entry = stack.pop()
    if (entry.exit) { active.delete(entry.value); continue }
    stats.nodes += 1
    stats.depth = Math.max(stats.depth, entry.depth)
    if (stats.nodes > limits.nodes || entry.depth > limits.depth) throw argumentBudgetError('json_structure')
    const current = entry.value
    if (typeof current === 'string') {
      if (current.length > limits.bytes) throw argumentBudgetError('json_bytes')
      stats.bytes += Buffer.byteLength(JSON.stringify(current), 'utf8')
    } else if (current === null || typeof current === 'boolean' || (typeof current === 'number' && Number.isFinite(current))) {
      stats.bytes += String(current).length
    } else {
      if (!Array.isArray(current) && !isPlainObject(current)) throw invalidJson()
      if (active.has(current)) throw invalidJson()
      if (Array.isArray(current)) {
        stats.maxArrayLength = Math.max(stats.maxArrayLength, current.length)
        if (current.length > limits.arrayItems) throw argumentBudgetError('array_items')
      }
      active.add(current)
      stack.push({ value: current, exit: true })
      const descriptors = Object.getOwnPropertyDescriptors(current)
      const keys = Object.keys(descriptors).filter((key) => key !== 'length' || !Array.isArray(current))
      if (keys.length + stats.nodes > limits.nodes) throw argumentBudgetError('json_structure')
      for (const key of keys) {
        const property = descriptors[key]
        if (!property.enumerable) continue
        if (!Object.hasOwn(property, 'value')) throw invalidJson()
        stats.bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 2
        stack.push({ value: property.value, depth: entry.depth + 1 })
      }
      stats.bytes += 2
    }
    if (stats.bytes > limits.bytes) throw argumentBudgetError('json_bytes')
  }
  return stats
}
