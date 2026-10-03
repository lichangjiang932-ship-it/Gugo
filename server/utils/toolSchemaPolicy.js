import { isPlainObject } from './toolCallPrimitives.js'
import { schemaPolicyError } from './toolSchemaBudget.js'
import { assertSafeToolPattern } from './toolSchemaPatterns.js'

const MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SINGLE = ['additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contains']
const ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
const ANNOTATIONS = new Set(['_meta', 'example', 'enumNames', 'deprecationMessage'])

function children(schema) {
  if (!isPlainObject(schema)) return []
  const result = []
  for (const key of MAPS) if (isPlainObject(schema[key])) result.push(...Object.values(schema[key]))
  for (const key of SINGLE) if (Object.hasOwn(schema, key)) result.push(schema[key])
  for (const key of ARRAYS) if (Array.isArray(schema[key])) result.push(...schema[key])
  if (Array.isArray(schema.items)) result.push(...schema.items)
  else if (Object.hasOwn(schema, 'items')) result.push(schema.items)
  for (const value of Object.values(schema.dependencies || {})) if (!Array.isArray(value)) result.push(value)
  return result.filter((value) => typeof value === 'boolean' || isPlainObject(value))
}

function localTarget(root, reference, anchors) {
  if (typeof reference !== 'string' || !reference.startsWith('#')) throw schemaPolicyError('remote_ref')
  if (reference === '#') return root
  if (!reference.startsWith('#/')) {
    const target = anchors.get(reference.slice(1))
    if (!target) throw schemaPolicyError('unresolved_ref')
    return target
  }
  let target = root
  let segments
  try { segments = decodeURIComponent(reference.slice(2)).split('/') } catch { throw schemaPolicyError('invalid_ref') }
  for (const segment of segments) {
    const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw schemaPolicyError('unresolved_ref')
    target = target[key]
  }
  if (!isPlainObject(target) && typeof target !== 'boolean') throw schemaPolicyError('invalid_ref')
  return target
}

function assertNodePolicy(node, root, anchors) {
  if (!isPlainObject(node)) return
  for (const key of ['$dynamicRef', '$recursiveRef', '$async', '$data', '$vocabulary']) {
    if (Object.hasOwn(node, key)) throw schemaPolicyError('unsupported_vocabulary')
  }
  if (node !== root && Object.hasOwn(node, '$id')) throw schemaPolicyError('nested_id')
  if (Object.hasOwn(node, 'pattern')) assertSafeToolPattern(node.pattern)
  for (const pattern of Object.keys(node.patternProperties || {})) assertSafeToolPattern(pattern)
  if (typeof node.$anchor === 'string') {
    if (anchors.has(node.$anchor)) throw schemaPolicyError('duplicate_anchor')
    anchors.set(node.$anchor, node)
  }
  for (const key of Object.keys(node)) if (key.startsWith('x-') || ANNOTATIONS.has(key)) delete node[key]
}

/** Validate graph/regex policy before Ajv can compile or execute supplied code paths. */
export function prepareToolSchemaPolicy(root) {
  const pending = [root]
  const nodes = []
  const anchors = new Map()
  while (pending.length) {
    const node = pending.pop()
    if (!isPlainObject(node)) continue
    assertNodePolicy(node, root, anchors)
    nodes.push(node)
    pending.push(...children(node))
  }
  const active = new WeakSet()
  const costs = new WeakMap()
  const visit = (node) => {
    if (!isPlainObject(node)) return 1
    if (active.has(node)) throw schemaPolicyError('recursive_ref')
    if (costs.has(node)) return costs.get(node)
    active.add(node)
    let cost = 1
    const outgoing = children(node)
    if (Object.hasOwn(node, '$ref')) outgoing.push(localTarget(root, node.$ref, anchors))
    for (const target of outgoing) {
      cost += visit(target)
      if (cost > 20000) throw schemaPolicyError('reference_expansion')
    }
    active.delete(node)
    costs.set(node, cost)
    return cost
  }
  const expandedNodes = visit(root)
  return { expandedNodes, hasUniqueItems: nodes.some((node) => node.uniqueItems === true) }
}
