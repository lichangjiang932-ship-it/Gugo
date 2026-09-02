import { randomUUID } from 'node:crypto'

import { isPlainObject, safeStringify, toolError } from './toolCallPrimitives.js'

function createCallId() {
  return `call-${randomUUID()}`
}

/**
 * Repair only structurally truncated JSON objects. This deliberately refuses
 * to guess unfinished strings, values, keys, paths, commands, or trailing
 * commas; it may only append missing `}` / `]` tokens after a complete value.
 */
export function repairTruncatedJsonObject(rawText) {
  const text = String(rawText ?? '').trim()
  if (!text.startsWith('{')) return null

  const expectedClosers = []
  let inString = false
  let escaped = false
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      expectedClosers.push('}')
    } else if (character === '[') {
      expectedClosers.push(']')
    } else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) return null
    }
  }

  if (inString || escaped || expectedClosers.length === 0) return null
  const lastCharacter = text.at(-1)
  if (!lastCharacter || [':', ',', '{', '['].includes(lastCharacter)) return null

  const repairedText = text + [...expectedClosers].reverse().join('')
  try {
    const args = JSON.parse(repairedText)
    if (!isPlainObject(args)) return null
    return {
      args,
      argumentsText: repairedText,
      addedClosers: expectedClosers.length,
    }
  } catch {
    return null
  }
}

export function parseToolArguments(rawArguments) {
  if (rawArguments == null || rawArguments === '') {
    return { ok: true, args: {}, argumentsText: '{}' }
  }

  if (isPlainObject(rawArguments)) {
    try {
      return { ok: true, args: rawArguments, argumentsText: JSON.stringify(rawArguments) }
    } catch (error) {
      return {
        ok: false,
        args: null,
        argumentsText: '{}',
        error: toolError('invalid_tool_arguments', `工具参数无法序列化：${error?.message || String(error)}`),
      }
    }
  }

  if (typeof rawArguments !== 'string') {
    return {
      ok: false,
      args: null,
      argumentsText: '{}',
      error: toolError('invalid_tool_arguments', '工具参数必须是 JSON 对象。'),
    }
  }

  const text = rawArguments.trim() || '{}'
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        args: null,
        argumentsText: text,
        error: toolError('invalid_tool_arguments', '工具参数 JSON 的顶层必须是对象。'),
      }
    }
    return { ok: true, args: parsed, argumentsText: text }
  } catch (error) {
    const repaired = repairTruncatedJsonObject(text)
    if (repaired) {
      return {
        ok: true,
        args: repaired.args,
        argumentsText: repaired.argumentsText,
        repair: {
          kind: 'closed_truncated_json',
          addedClosers: repaired.addedClosers,
        },
      }
    }
    return {
      ok: false,
      args: null,
      argumentsText: text,
      error: toolError(
        'invalid_tool_arguments',
        `工具参数不是有效 JSON：${error?.message || String(error)}`,
        { hint: '请修正 JSON 后重新调用该工具，不要重复发送相同参数。' },
      ),
    }
  }
}

/** 统一 wire / 简写两种形状，并保证每个调用都有唯一 id。 */
export function normalizeToolCalls(rawCalls, { idFactory = createCallId, toolSpecs = [] } = {}) {
  if (!Array.isArray(rawCalls)) return []
  const usedIds = new Set()

  return rawCalls.map((rawCall) => {
    const raw = rawCall && typeof rawCall === 'object' ? rawCall : {}
    let id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || usedIds.has(id)) {
      do { id = idFactory() } while (!id || usedIds.has(id))
    }
    usedIds.add(id)

    const name = String(raw.function?.name || raw.name || '').trim()
    const parsed = parseToolArguments(raw.function?.arguments ?? raw.arguments)
    return applyToolSchemaDefaults({
      id,
      name,
      args: parsed.args,
      argumentsText: parsed.argumentsText,
      argumentRepair: parsed.repair || null,
      parseError: parsed.ok ? null : parsed.error,
    }, toolSpecs)
  })
}

function cloneSchemaValue(value, depth = 0) {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((item) => cloneSchemaValue(item, depth + 1))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneSchemaValue(item, depth + 1)]),
    )
  }
  return value
}

function applySchemaDefaults(value, schema, path = '$', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) {
    return { value, applied: [] }
  }

  let nextValue = value
  const applied = []
  if (nextValue === undefined && Object.hasOwn(schema, 'default')) {
    nextValue = cloneSchemaValue(schema.default)
    applied.push(path)
  }

  // Defaults inside anyOf/oneOf are intentionally ignored: choosing a branch
  // would infer model intent. Only unambiguous property defaults are applied.
  if (isPlainObject(nextValue)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    let output = nextValue
    for (const [key, childSchema] of Object.entries(properties)) {
      const childPath = `${path}.${key}`
      const hasValue = Object.hasOwn(nextValue, key)
      if (!hasValue && !Object.hasOwn(childSchema || {}, 'default')) continue
      const child = applySchemaDefaults(
        hasValue ? nextValue[key] : undefined,
        childSchema,
        childPath,
        depth + 1,
      )
      if (child.applied.length === 0) continue
      if (output === nextValue) output = { ...nextValue }
      output[key] = child.value
      applied.push(...child.applied)
    }
    nextValue = output
  } else if (Array.isArray(nextValue) && schema.items && typeof schema.items === 'object') {
    let output = nextValue
    for (let index = 0; index < nextValue.length; index += 1) {
      const child = applySchemaDefaults(
        nextValue[index],
        schema.items,
        `${path}[${index}]`,
        depth + 1,
      )
      if (child.applied.length === 0) continue
      if (output === nextValue) output = [...nextValue]
      output[index] = child.value
      applied.push(...child.applied)
    }
    nextValue = output
  }

  return { value: nextValue, applied }
}

/**
 * Apply only defaults explicitly declared by a tool's JSON Schema. Required
 * business values such as paths and commands are never guessed.
 */
export function applyToolSchemaDefaults(call, toolSpecs = []) {
  if (!call || call.parseError || !isPlainObject(call.args)) return call
  const spec = toolSpecs.find((item) => item?.function?.name === call.name)
  if (!spec) return call
  const result = applySchemaDefaults(call.args, spec.function?.parameters)
  if (result.applied.length === 0) return call
  return {
    ...call,
    args: result.value,
    argumentsText: safeStringify(result.value),
    argumentDefaults: result.applied,
  }
}

function typeMatches(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function addSchemaIssue(issues, message) {
  if (issues.length < 8) issues.push(message)
}

function validateSchema(value, schema, path, issues, depth = 0) {
  if (!schema || typeof schema !== 'object' || issues.length >= 8 || depth > 12) return

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((candidate) => {
      const candidateIssues = []
      validateSchema(value, candidate, path, candidateIssues, depth + 1)
      return candidateIssues.length === 0
    })
    if (!matched) addSchemaIssue(issues, `${path} 不符合任一允许的参数形状`)
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.some((candidate) => {
      const candidateIssues = []
      validateSchema(value, candidate, path, candidateIssues, depth + 1)
      return candidateIssues.length === 0
    })
    if (!matched) addSchemaIssue(issues, `${path} 不符合任一允许的参数形状`)
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    addSchemaIssue(issues, `${path} 应为 ${schema.type}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    addSchemaIssue(issues, `${path} 必须是 ${schema.enum.join(' / ')} 之一`)
    return
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      addSchemaIssue(issues, `${path} 不能小于 ${schema.minimum}`)
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      addSchemaIssue(issues, `${path} 不能大于 ${schema.maximum}`)
    }
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
      addSchemaIssue(issues, `${path} 必须大于 ${schema.exclusiveMinimum}`)
    }
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {
      addSchemaIssue(issues, `${path} 必须小于 ${schema.exclusiveMaximum}`)
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      addSchemaIssue(issues, `${path} 长度不能小于 ${schema.minLength}`)
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      addSchemaIssue(issues, `${path} 长度不能大于 ${schema.maxLength}`)
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) {
          addSchemaIssue(issues, `${path} 不符合要求的格式`)
        }
      } catch {
        addSchemaIssue(issues, `${path} 的 pattern 定义无效`)
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      addSchemaIssue(issues, `${path} 至少需要 ${schema.minItems} 项`)
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      addSchemaIssue(issues, `${path} 最多允许 ${schema.maxItems} 项`)
    }
  }

  const objectSchema = schema.type === 'object'
    || Array.isArray(schema.required)
    || (schema.properties && typeof schema.properties === 'object')
    || schema.additionalProperties === false
  if (objectSchema && isPlainObject(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) addSchemaIssue(issues, `${path}.${key} 为必填参数`)
    }
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {}
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateSchema(value[key], child, `${path}.${key}`, issues, depth + 1)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          addSchemaIssue(issues, `${path}.${key} 是未允许的额外参数`)
        }
      }
    }
  } else if (Array.isArray(value) && (schema.type === 'array' || schema.items)) {
    value.slice(0, 200).forEach((item, index) => {
      validateSchema(item, schema.items, `${path}[${index}]`, issues, depth + 1)
    })
  }
}

/** 在审批和执行前验证名称、JSON 与工具 schema。返回 null 表示可执行。 */
export function validateToolCall(call, toolSpecs = [], { allowUnknown = false } = {}) {
  if (!call?.name) {
    return toolError('missing_tool_name', '工具名为空，无法执行。')
  }
  if (call.parseError) return call.parseError

  const spec = toolSpecs.find((item) => item?.function?.name === call.name)
  if (!spec) {
    if (allowUnknown) return null
    return toolError(
      'unknown_tool',
      `未知工具：${call.name}`,
      { availableTools: toolSpecs.map((item) => item?.function?.name).filter(Boolean).slice(0, 50) },
    )
  }

  const issues = []
  validateSchema(call.args, spec.function?.parameters, '$', issues)
  if (issues.length > 0) {
    return toolError(
      'tool_arguments_validation_failed',
      `工具参数校验失败：${issues.join('；')}`,
      { issues, hint: '请按工具参数定义修正后重新调用。' },
    )
  }
  return null
}

export function buildAssistantToolCallsMessage(calls, content = '', { reasoning = '' } = {}) {
  return {
    role: 'assistant',
    content: content || null,
    // Replayed by default for OpenAI-compatible providers; Anthropic/Gemini keep it
    // stripped unless the deployment explicitly sets MODEL_REASONING_RETENTION=1.
    ...(typeof reasoning === 'string' && reasoning.trim() ? { reasoning_content: reasoning } : {}),
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.argumentsText || '{}',
      },
    })),
  }
}
