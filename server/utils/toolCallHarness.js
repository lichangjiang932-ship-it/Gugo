/**
 * Agent 工具调用公共内核。
 *
 * OpenAI 兼容端点返回的 tool call 并不完全一致：id 可能缺失或重复，
 * arguments 可能是 JSON 字符串、对象，甚至损坏的 JSON。执行器必须把协议
 * 问题作为结构化工具错误回送给模型，而不是静默变成空对象或直接炸掉整条任务。
 *
 * 本模块保持纯函数/进程内状态，不做 IO，供 job / subagent 等运行时复用。
 */
import { createHash, randomUUID } from 'node:crypto'

/**
 * 单个工具结果喂回模型时的字符上限。
 *
 * ★ 6000 → 24000 并可配。6000 字符 ≈ 1500 token,一个稍大的源文件读回来
 * 就被砍掉大半 —— 模型基于残缺内容做判断,结论自然不可靠,
 * 而它并不知道自己看到的是截断过的。
 * 这个值只控制单个结果的上限；工具循环还会在下一次模型请求前，
 * 按真实上下文窗口为同批结果分配总预算。
 */
export const DEFAULT_TOOL_OUTPUT_CHARS = (() => {
  const raw = Number(process.env.TOOL_OUTPUT_MAX_CHARS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24_000
})()

const MIN_TOOL_OUTPUT_CHARS = 500
// Reserve most of the model window for instructions, history, tool-call
// protocol, and the next answer. At 0.75 chars per context token, four tool
// results in an 8k window share about 6k characters, while a 128k window still
// preserves the existing 24k-per-result ceiling for the same batch.
export const TOOL_OUTPUT_CONTEXT_CHARS_PER_TOKEN = 0.75

export function resolveToolResultMaxChars({
  contextWindow,
  resultCount = 1,
  maxChars = DEFAULT_TOOL_OUTPUT_CHARS,
} = {}) {
  const count = Math.max(1, Math.floor(Number(resultCount) || 1))
  const perResultCeiling = Math.max(
    MIN_TOOL_OUTPUT_CHARS,
    Math.floor(Number(maxChars) || DEFAULT_TOOL_OUTPUT_CHARS),
  )
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return perResultCeiling

  const batchBudget = Math.max(
    MIN_TOOL_OUTPUT_CHARS * count,
    Math.floor(window * TOOL_OUTPUT_CONTEXT_CHARS_PER_TOKEN),
  )
  return Math.max(
    MIN_TOOL_OUTPUT_CHARS,
    Math.min(perResultCeiling, Math.floor(batchBudget / count)),
  )
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function createCallId() {
  return `call-${randomUUID()}`
}

function toolError(code, error, extra = {}) {
  return {
    ok: false,
    code,
    error,
    retryable: true,
    ...extra,
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_ERROR_TEXT_CHARS = 2_000

function safeErrorText(value, fallback = '') {
  let text = String(value ?? fallback).slice(0, MAX_ERROR_TEXT_CHARS)
  // Tool/provider errors can contain request headers or URLs. Preserve the
  // actionable message while ensuring credentials never enter checkpoints,
  // turn events, model context, or the browser state.
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+/giu, '$1[REDACTED]')
  return text
}

function normalizedStatus(value) {
  const status = Number(value)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
}

/** Convert a thrown provider/adapter error into the public tool-result shape. */
export function normalizeToolError(error, {
  fallbackCode = 'tool_execution_failed',
  fallbackMessage = 'Tool execution failed.',
} = {}) {
  const source = error && typeof error === 'object' ? error : {}
  const status = normalizedStatus(source.status ?? source.statusCode)
  const retryable = typeof source.retryable === 'boolean'
    ? source.retryable
    : RETRYABLE_HTTP_STATUSES.has(status)
  const code = safeErrorText(source.code || fallbackCode, fallbackCode).slice(0, 160)
  const message = safeErrorText(source.message || error || fallbackMessage, fallbackMessage)
  const hint = source.hint == null ? '' : safeErrorText(source.hint)
  const errorPath = source.path == null ? '' : safeErrorText(source.path)
  const suggestGrantPath = source.suggestGrantPath == null
    ? ''
    : safeErrorText(source.suggestGrantPath)
  const requiredAccessMode = ['read_only', 'read_write'].includes(source.requiredAccessMode)
    ? source.requiredAccessMode
    : ''
  const causeCode = source.cause && typeof source.cause === 'object'
    ? safeErrorText(source.cause.code || '').slice(0, 160)
    : ''
  return {
    ok: false,
    code,
    error: message,
    retryable,
    ...(status ? { status } : {}),
    ...(hint ? { hint } : {}),
    ...(errorPath ? { path: errorPath } : {}),
    ...(suggestGrantPath ? { suggestGrantPath } : {}),
    ...(requiredAccessMode ? { requiredAccessMode } : {}),
    // A cause code is useful for routing, but nested messages/stacks are not
    // exposed because they frequently contain response bodies or credentials.
    ...(causeCode ? { cause: { code: causeCode } } : {}),
  }
}

const NON_SUBSTANTIVE_TOOL_NAMES = new Set([
  'manage_todos',
  'reflect',
  'request_clarification',
  'request_directory',
  'sleep_until',
])

/**
 * Tool executors share one explicit result contract. Legacy `{ error }`
 * objects remain failures, while empty or ambiguous values must never be
 * mistaken for successful execution.
 */
export function normalizeToolResult(result) {
  if (isPlainObject(result)) {
    if (result.ok === true) return result
    if (result.ok === false || result.error) {
      const normalized = normalizeToolError({
        code: result.code,
        message: result.error,
        status: result.status ?? result.statusCode,
        retryable: result.retryable,
        hint: result.hint,
        cause: result.cause,
      })
      return {
        ...result,
        ...normalized,
        ...(result.statusCode != null && normalized.status == null ? { statusCode: result.statusCode } : {}),
      }
    }
  }

  return toolError(
    'tool_result_invalid',
    'Tool executor returned an invalid result. Expected an object with ok: true or ok: false.',
    { retryable: false },
  )
}

export function isSafeToolRetry(metadata) {
  if (!metadata || typeof metadata !== 'object') return false
  if (metadata.isReadOnly === true) return true
  // External writes are never replayed automatically, even when their API
  // accepts an idempotency key. Their outcome can be visible to other people.
  return metadata.isIdempotent === true
    && metadata.riskClass !== 'external'
    && metadata.isDestructive !== true
}

function abortError(signal) {
  const error = new Error('Tool execution cancelled')
  error.name = 'AbortError'
  if (signal?.reason !== undefined) error.cause = signal.reason
  return error
}

async function abortableDelay(ms, signal) {
  if (signal?.aborted) throw abortError(signal)
  if (!(ms > 0)) return
  await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const onAbort = () => {
      finish(reject, abortError(signal))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Execute one already-approved tool with conservative transient retries.
 * Validation, approval, hooks, and audit remain outside this function and are
 * therefore not repeated. Only read-only or explicitly idempotent local tools
 * qualify; external writes and destructive tools always receive one attempt.
 */
export async function executeToolWithRetry({
  execute,
  metadata,
  signal,
  maxAttempts = 3,
  baseDelayMs = 120,
  delay = abortableDelay,
} = {}) {
  const attemptsLimit = isSafeToolRetry(metadata)
    ? Math.max(1, Math.min(3, Math.floor(Number(maxAttempts) || 1)))
    : 1
  let result = null
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    if (signal?.aborted) throw abortError(signal)
    try {
      result = normalizeToolResult(await execute({ attempt }))
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
      result = normalizeToolError(error)
    }
    if (result.ok === true) return attempt > 1 ? { ...result, attempts: attempt } : result
    if (result.retryable !== true || attempt >= attemptsLimit) {
      return attempt > 1 ? { ...result, attempts: attempt } : result
    }
    const waitMs = Math.max(0, Number(baseDelayMs) || 0) * (2 ** (attempt - 1))
    await delay(waitMs, signal)
  }
  return result
}

export function isSubstantiveToolCall(call) {
  const name = String(call?.name || '').trim()
  return Boolean(name) && !NON_SUBSTANTIVE_TOOL_NAMES.has(name)
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

/**
 * 统一 wire / 简写两种形状，并保证每个调用都有唯一 id。
 */
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
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${path}.${key}`, issues, depth + 1)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) addSchemaIssue(issues, `${path}.${key} 是未允许的额外参数`)
      }
    }
  } else if (Array.isArray(value) && (schema.type === 'array' || schema.items)) {
    value.slice(0, 200).forEach((item, index) => {
      validateSchema(item, schema.items, `${path}[${index}]`, issues, depth + 1)
    })
  }
}

/**
 * 在审批和执行前验证名称、JSON 与工具 schema。返回 null 表示可执行。
 */
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

export function buildAssistantToolCallsMessage(calls, content = '') {
  return {
    role: 'assistant',
    content: content || null,
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

function safeStringify(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item)
      if (item instanceof Error) {
        return { name: item.name, message: item.message, code: item.code, status: item.status }
      }
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
  } catch (error) {
    return JSON.stringify(toolError('tool_result_serialization_failed', error?.message || String(error), { retryable: false }))
  }
}

/** 始终返回合法 JSON；超长结果变为带长度和预览的说明对象。 */
export function serializeToolResult(value, { maxChars = DEFAULT_TOOL_OUTPUT_CHARS } = {}) {
  const limit = Math.max(MIN_TOOL_OUTPUT_CHARS, Number(maxChars) || DEFAULT_TOOL_OUTPUT_CHARS)
  const json = safeStringify(value) ?? 'null'
  if (json.length <= limit) return json

  let previewChars = Math.max(100, limit - 220)
  let clipped
  do {
    clipped = safeStringify({
      ok: value?.ok ?? true,
      truncated: true,
      _truncated: true,
      originalChars: json.length,
      _originalChars: json.length,
      preview: json.slice(0, previewChars),
      hint: '结果过长。请缩小查询范围、使用分页/offset，或只读取相关片段。',
    })
    previewChars -= 100
  } while (clipped.length > limit && previewChars > 100)
  return clipped.length <= limit
    ? clipped
    : safeStringify({ truncated: true, _truncated: true, originalChars: json.length, _originalChars: json.length })
}

export function buildToolResultMessage(call, result, options) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name || undefined,
    content: serializeToolResult(result, options),
  }
}

/**
 * Tool-produced images need to be visible to the next model response, not
 * embedded as an enormous base64 string inside JSON. Keep a compact tool
 * result for protocol pairing, then add the image as a normal multimodal user
 * message so native vision and vision-assist use the existing image path.
 *
 * Applies to browser_screenshot and any executor that returns an `image`
 * payload (image_transform, extract_frame, generate_image).
 */
export function buildToolResultMessages(call, result, options) {
  const image = result?.image ?? null
  const data = typeof image?.data === 'string' ? image.data.trim() : ''
  const mimeType = String(image?.mimeType || '').trim().toLowerCase()
  if (!data || !/^image\/(?:png|jpe?g|webp|gif)$/u.test(mimeType)) {
    return [buildToolResultMessage(call, result, options)]
  }
  const compactResult = {
    ...result,
    image: {
      captured: true,
      mimeType,
      ...(Number.isFinite(Number(image?.bytes)) ? { bytes: Number(image.bytes) } : {}),
    },
  }
  const inspectionText = call?.name === 'browser_screenshot'
    ? 'Browser screenshot captured by browser_screenshot. Inspect this image before continuing.'
    : `${call?.name || 'tool'} produced the image below. Inspect it to verify the result before continuing.`
  return [
    buildToolResultMessage(call, compactResult, options),
    {
      role: 'user',
      content: [
        { type: 'text', text: inspectionText },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } },
      ],
    },
  ]
}

/**
 * 有界并发映射，输出顺序始终与输入一致。
 * mapper 抛错时保持 Promise.all 语义向上抛，由调用方决定如何降级。
 */
export async function mapWithConcurrency(items, mapper, { concurrency = 4 } = {}) {
  const input = Array.isArray(items) ? items : []
  if (input.length === 0) return []
  const width = Math.max(1, Math.min(input.length, Math.floor(Number(concurrency) || 1)))
  const output = new Array(input.length)
  let cursor = 0

  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= input.length) return
      output[index] = await mapper(input[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function callSignature(call) {
  const args = call?.args ?? call?.argumentsText ?? ''
  // Checkpoints persist the last signature so a process restart cannot reset a
  // repeated-call fuse. Store only a digest: commands and tool arguments may
  // contain credentials or large inline file contents.
  return createHash('sha256')
    .update(`${call?.name || '<missing>'}:${safeStringify(stableValue(args))}`)
    .digest('hex')
}

function restoredCounter(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

/**
 * 「模型自己把参数写错了」这一类错误码。
 *
 * ★ 这类失败和「工具真的执行失败」性质完全不同:
 *   - 工具执行失败(文件不存在、命令返回非 0、网络不通)= 环境有问题,
 *     连续 6 次基本可以断定这条路走不通,该熔断。
 *   - 参数校验失败 = 模型输出的 JSON 不合 schema。小模型(7B 及以下)
 *     写 tool arguments 时出错是**家常便饭**,而这是可以自我纠正的 ——
 *     把 schema 错误回喂给它,下一轮往往就写对了。
 *
 * 原来两者一视同仁,于是一个本地小模型连着写错 6 次参数,整个 run 就被判
 * noProgress 然后 failed —— 明明它只是需要多试几次。
 */
const MODEL_AUTHORING_ERROR_CODES = new Set([
  'tool_arguments_validation_failed',
  'invalid_tool_arguments',
  'unknown_tool',
  'tool_arguments_parse_failed',
])

function isModelAuthoringError(result) {
  const code = String(result?.code || '')
  return MODEL_AUTHORING_ERROR_CODES.has(code)
}

function sameToolFailureAdvisory({ tool, count, level }) {
  const guidance = [
    'Analyze the concrete errors before another attempt. Do not keep guessing arguments; choose a materially different strategy.',
    'Stop varying the same approach. Change executor or workflow, verify a new hypothesis, or identify one specific missing prerequisite.',
    'You are approaching the hard no-progress limit. Use a fundamentally different path, request one concrete missing input, or finish with the verified partial result.',
  ][Math.min(Math.max(level, 1), 3) - 1]
  return {
    code: 'tool_failure_strategy_required',
    tool,
    count,
    level,
    content: 'Tool ' + tool + ' has failed ' + count + ' times without recovering. ' + guidance,
  }
}

/**
 * 无进展熔断：同一调用反复出现，或工具连续失败时停止继续烧 token。
 *
 * @param {object} [options]
 * @param {number} [options.maxRepeatedCalls] 同一签名重复多少次算无进展
 * @param {number} [options.maxConsecutiveErrors] 连续多少次**真实执行失败**算熔断
 * @param {number} [options.maxAuthoringErrors] 连续多少次**参数写错**才熔断。
 * @param {number} [options.maxSameToolFailures] 同一执行器真实失败多少次才硬熔断
 * @param {number[]} [options.sameToolFailureAdvisoryThresholds] 要求模型升级策略的失败次数
 *   给得比 maxConsecutiveErrors 宽松得多 —— 小模型需要更多次自我纠正的机会。
 */
export function createToolLoopGuard({
  maxRepeatedCalls = 3,
  maxConsecutiveErrors = 6,
  maxAuthoringErrors = 20,
  maxSameToolFailures = 20,
  sameToolFailureAdvisoryThresholds = [4, 8, 12],
  initialState = null,
} = {}) {
  const restored = initialState && typeof initialState === 'object' ? initialState : {}
  const sameToolFailureHardLimit = Number.isFinite(Number(maxSameToolFailures))
    ? Math.max(1, Math.floor(Number(maxSameToolFailures)))
    : 20
  const advisoryThresholds = [...new Set(
    Array.isArray(sameToolFailureAdvisoryThresholds)
      ? sameToolFailureAdvisoryThresholds
      : [],
  )]
    .filter((value) => Number.isInteger(value)
      && value >= 1
      && value < sameToolFailureHardLimit)
    .sort((left, right) => left - right)
  const restoreAdvisoryThresholds = (value) => new Map(
    Object.entries(value && typeof value === 'object' ? value : {})
      .map(([name, threshold]) => [
        String(name || '').trim(),
        restoredCounter(threshold),
      ])
      .filter(([name, threshold]) => (
        name && threshold > 0 && threshold < sameToolFailureHardLimit
      )),
  )
  const seenSignatures = new Set()
  const failedToolCounts = new Map(
    Object.entries(restored.failedTools && typeof restored.failedTools === 'object'
      ? restored.failedTools
      : {})
      .map(([name, count]) => [String(name || '').trim(), restoredCounter(count)])
      .filter(([name, count]) => name && count > 0),
  )
  const firedToolAdvisoryThresholds = restoreAdvisoryThresholds(
    restored.firedToolAdvisoryThresholds,
  )
  const pendingToolAdvisoryThresholds = restoreAdvisoryThresholds(
    restored.pendingToolAdvisoryThresholds,
  )
  for (const [name, threshold] of pendingToolAdvisoryThresholds) {
    if (threshold <= (firedToolAdvisoryThresholds.get(name) || 0)) {
      pendingToolAdvisoryThresholds.delete(name)
    }
  }
  let consecutiveErrors = restoredCounter(restored.consecutiveErrors)
  let consecutiveAuthoringErrors = restoredCounter(restored.consecutiveAuthoringErrors)
  let lastSignature = /^[a-f0-9]{64}$/u.test(String(restored.lastSignature || ''))
    ? String(restored.lastSignature)
    : null
  let repeatedCallStreak = lastSignature ? restoredCounter(restored.repeatedCallStreak) : 0

  return {
    before(call) {
      const signature = callSignature(call)
      seenSignatures.add(signature)
      if (signature === lastSignature) repeatedCallStreak += 1
      else {
        lastSignature = signature
        repeatedCallStreak = 1
      }
      if (repeatedCallStreak > maxRepeatedCalls) {
        const reason = `同一工具调用已连续重复 ${repeatedCallStreak} 次，未取得新进展`
        return {
          ok: false,
          reason,
          result: toolError('repeated_tool_call', reason, {
            retryable: false,
            hint: '请停止重复调用，改用已有结果收尾或换一种方法。',
          }),
        }
      }
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = `工具已连续失败 ${consecutiveErrors} 次`
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, { retryable: false }),
        }
      }
      if (consecutiveAuthoringErrors >= maxAuthoringErrors) {
        const reason = `模型已连续 ${consecutiveAuthoringErrors} 次写出不合法的工具参数`
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, {
            retryable: false,
            hint: '当前模型可能不擅长 function calling，可在 provider 设置里关闭该模型的工具支持，或换一个更大的模型。',
          }),
        }
      }
      return { ok: true }
    },
    after(result, call = null) {
      const normalized = normalizeToolResult(result)
      const failed = normalized.ok === false
      if (!failed) {
        // Reflection, planning, waiting, and clarification do not prove that
        // a failed execution path made progress. Keep the real error streak.
        if (!call || isSubstantiveToolCall(call)) {
          consecutiveErrors = 0
          consecutiveAuthoringErrors = 0
          lastSignature = null
          repeatedCallStreak = 0
        }
        return { ok: true }
      }
      // 参数写错走单独的、宽松得多的计数器,不污染真实执行失败的熔断
      if (isModelAuthoringError(normalized)) {
        consecutiveAuthoringErrors += 1
        if (consecutiveAuthoringErrors >= maxAuthoringErrors) {
          const reason = '模型已连续 ' + consecutiveAuthoringErrors + ' 次写出不合法的工具参数'
          return {
            ok: false,
            reason,
            result: toolError('tool_error_streak', reason, { retryable: false }),
          }
        }
        return { ok: true }
      }
      consecutiveErrors += 1
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = '工具已连续失败 ' + consecutiveErrors + ' 次'
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, { retryable: false }),
        }
      }
      return { ok: true }
    },
    afterCall(call, result) {
      const name = String(call?.name || '').trim()
      if (!name) return { ok: true }
      const normalized = normalizeToolResult(result)
      const failed = normalized.ok === false
      if (!failed) {
        // Success only proves recovery for this exact executor. In particular,
        // a reflect/request/sleep result must not erase another tool's history.
        if (isSubstantiveToolCall(call)) {
          failedToolCounts.delete(name)
          firedToolAdvisoryThresholds.delete(name)
          pendingToolAdvisoryThresholds.delete(name)
        }
        return { ok: true }
      }
      if (isModelAuthoringError(normalized)) return { ok: true }
      const count = (failedToolCounts.get(name) || 0) + 1
      failedToolCounts.set(name, count)
      if (count >= sameToolFailureHardLimit) {
        const reason = '工具 ' + name + ' 已连续失败 ' + count + ' 次，达到无进展硬上限'
        return {
          ok: false,
          reason,
          result: toolError('tool_no_progress_hard_limit', reason, {
            retryable: false,
            hint: '停止继续猜测参数；请基于已有结果简短收尾，或明确说明唯一缺失条件。',
          }),
        }
      }
      let threshold = 0
      let level = 0
      for (let index = 0; index < advisoryThresholds.length; index += 1) {
        if (count < advisoryThresholds[index]) break
        threshold = advisoryThresholds[index]
        level = index + 1
      }
      const knownThreshold = Math.max(
        firedToolAdvisoryThresholds.get(name) || 0,
        pendingToolAdvisoryThresholds.get(name) || 0,
      )
      if (threshold <= knownThreshold) return { ok: true }
      pendingToolAdvisoryThresholds.set(name, threshold)
      return { ok: true, advisory: sameToolFailureAdvisory({ tool: name, count, level }) }
    },
    pendingAdvisories() {
      return [...pendingToolAdvisoryThresholds.entries()].map(([tool, threshold]) => {
        const configuredIndex = advisoryThresholds.indexOf(threshold)
        const level = configuredIndex >= 0
          ? configuredIndex + 1
          : Math.max(1, advisoryThresholds.filter((value) => value <= threshold).length)
        return sameToolFailureAdvisory({
          tool,
          level,
          count: failedToolCounts.get(tool) || threshold,
        })
      })
    },
    commitPendingAdvisories() {
      for (const [tool, threshold] of pendingToolAdvisoryThresholds) {
        firedToolAdvisoryThresholds.set(
          tool,
          Math.max(firedToolAdvisoryThresholds.get(tool) || 0, threshold),
        )
      }
      pendingToolAdvisoryThresholds.clear()
    },
    snapshot() {
      return {
        consecutiveErrors,
        consecutiveAuthoringErrors,
        uniqueCalls: seenSignatures.size,
        repeatedCallStreak,
        lastSignature,
        failedTools: Object.fromEntries(failedToolCounts),
        firedToolAdvisoryThresholds: Object.fromEntries(firedToolAdvisoryThresholds),
        pendingToolAdvisoryThresholds: Object.fromEntries(pendingToolAdvisoryThresholds),
      }
    },
  }
}
