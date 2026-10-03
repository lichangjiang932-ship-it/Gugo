import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { isPlainObject, safeStringify, toolError } from './toolCallPrimitives.js'
import { cloneProviderReplay, geminiReplayParts } from '../adapters/providerReplayState.js'
import { measureToolJson, TOOL_ARGUMENT_LIMITS } from './toolSchemaBudget.js'
import { validateToolSchemaArguments, validateToolSchemaDefinition } from './toolJsonSchema.js'

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
      measureToolJson(rawArguments)
      return { ok: true, args: rawArguments, argumentsText: JSON.stringify(rawArguments) }
    } catch (error) {
      return {
        ok: false,
        args: null,
        argumentsText: '{}',
        error: toolError(error?.code || 'invalid_tool_arguments', '工具参数不是安全预算内可序列化的 JSON 对象。'),
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
  if (Buffer.byteLength(text, 'utf8') > TOOL_ARGUMENT_LIMITS.bytes) {
    return { ok: false, args: null, argumentsText: '{}',
      error: toolError('tool_arguments_budget_exceeded', '工具参数 JSON 超过安全大小限制。') }
  }
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
    measureToolJson(parsed)
    return { ok: true, args: parsed, argumentsText: text }
  } catch (error) {
    if (error?.code) {
      return { ok: false, args: null, argumentsText: text,
        error: toolError(error.code, '工具参数不是安全预算内的有限 JSON 对象。') }
    }
    const repaired = repairTruncatedJsonObject(text)
    if (repaired) {
      try { measureToolJson(repaired.args) } catch (failure) {
        return { ok: false, args: null, argumentsText: text,
          error: toolError(failure?.code || 'invalid_tool_arguments', '工具参数不是安全预算内的有限 JSON 对象。') }
      }
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
        '工具参数不是有效 JSON。',
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

function cloneSchemaValue(value) {
  return structuredClone(value)
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
      Object.defineProperty(output, key, { value: child.value, enumerable: true, configurable: true, writable: true })
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
  const schemaError = validateToolSchemaDefinition(spec.function?.parameters)
  if (schemaError) return { ...call, parseError: schemaError }
  const result = applySchemaDefaults(call.args, spec.function?.parameters)
  if (result.applied.length === 0) return call
  try { measureToolJson(result.value) } catch (error) {
    return { ...call, parseError: toolError(error?.code || 'invalid_tool_arguments', '工具默认参数展开超过安全校验预算。') }
  }
  return {
    ...call,
    args: result.value,
    argumentsText: safeStringify(result.value),
    argumentDefaults: result.applied,
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

  return validateToolSchemaArguments(call.args, spec.function?.parameters)
}

export function buildAssistantToolCallsMessage(calls, content = '', { reasoning = '', providerReplay: replayState = null } = {}) {
  const providerReplay = cloneProviderReplay(replayState)
  const message = {
    role: 'assistant',
    content: content || null,
    ...(providerReplay ? { providerReplay } : {}),
    // Replayed by default for OpenAI-compatible providers; Anthropic/Gemini keep it
    // stripped unless the deployment explicitly sets MODEL_REASONING_RETENTION=1.
    ...(!providerReplay && typeof reasoning === 'string' && reasoning.trim() ? { reasoning_content: reasoning } : {}),
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.argumentsText || '{}',
      },
    })),
  }
  // Validate before execution, not after a side effect has already occurred.
  // Provider-signed history must contain the model's original arguments;
  // schema defaults and approval edits belong to the execution record.
  if (providerReplay) geminiReplayParts(message, providerReplay)
  return message
}
