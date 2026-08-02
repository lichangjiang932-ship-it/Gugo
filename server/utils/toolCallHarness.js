/**
 * Agent 工具调用公共内核。
 *
 * OpenAI 兼容端点返回的 tool call 并不完全一致：id 可能缺失或重复，
 * arguments 可能是 JSON 字符串、对象，甚至损坏的 JSON。执行器必须把协议
 * 问题作为结构化工具错误回送给模型，而不是静默变成空对象或直接炸掉整条任务。
 *
 * 本模块保持纯函数/进程内状态，不做 IO，供 job / subagent 等运行时复用。
 */
import { randomUUID } from 'node:crypto'

/**
 * 单个工具结果喂回模型时的字符上限。
 *
 * ★ 6000 → 24000 并可配。6000 字符 ≈ 1500 token,一个稍大的源文件读回来
 * 就被砍掉大半 —— 模型基于残缺内容做判断,结论自然不可靠,
 * 而它并不知道自己看到的是截断过的。
 * 现代模型上下文普遍 128k+,这个上限完全没必要卡这么死。
 * 真正防上下文溢出的是 contextCompactionRuntime 的自动压缩。
 */
export const DEFAULT_TOOL_OUTPUT_CHARS = (() => {
  const raw = Number(process.env.TOOL_OUTPUT_MAX_CHARS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24_000
})()

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
export function normalizeToolCalls(rawCalls, { idFactory = createCallId } = {}) {
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
    return {
      id,
      name,
      args: parsed.args,
      argumentsText: parsed.argumentsText,
      parseError: parsed.ok ? null : parsed.error,
    }
  })
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

function validateSchema(value, schema, path, issues, depth = 0) {
  if (!schema || typeof schema !== 'object' || issues.length >= 8 || depth > 12) return

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.some((candidate) => {
      const candidateIssues = []
      validateSchema(value, candidate, path, candidateIssues, depth + 1)
      return candidateIssues.length === 0
    })
    if (!matched) issues.push(`${path} 不符合任一允许的参数形状`)
    return
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    issues.push(`${path} 应为 ${schema.type}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`)
    return
  }

  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) issues.push(`${path}.${key} 为必填参数`)
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) validateSchema(value[key], child, `${path}.${key}`, issues, depth + 1)
    }
  } else if (schema.type === 'array' && Array.isArray(value)) {
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
  const limit = Math.max(500, Number(maxChars) || DEFAULT_TOOL_OUTPUT_CHARS)
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
  return `${call?.name || '<missing>'}:${safeStringify(stableValue(args))}`
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

/**
 * 无进展熔断：同一调用反复出现，或工具连续失败时停止继续烧 token。
 *
 * @param {object} [options]
 * @param {number} [options.maxRepeatedCalls] 同一签名重复多少次算无进展
 * @param {number} [options.maxConsecutiveErrors] 连续多少次**真实执行失败**算熔断
 * @param {number} [options.maxAuthoringErrors] 连续多少次**参数写错**才熔断。
 *   给得比 maxConsecutiveErrors 宽松得多 —— 小模型需要更多次自我纠正的机会。
 */
export function createToolLoopGuard({
  maxRepeatedCalls = 3,
  maxConsecutiveErrors = 6,
  maxAuthoringErrors = 20,
} = {}) {
  const counts = new Map()
  let consecutiveErrors = 0
  let consecutiveAuthoringErrors = 0

  return {
    before(call) {
      const signature = callSignature(call)
      const count = (counts.get(signature) || 0) + 1
      counts.set(signature, count)
      if (count > maxRepeatedCalls) {
        const reason = `同一工具调用已重复 ${count} 次，未取得新进展`
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
    after(result) {
      const failed = result?.ok === false || (result?.error && result?.ok !== true)
      if (!failed) {
        consecutiveErrors = 0
        consecutiveAuthoringErrors = 0
        return { ok: true }
      }
      // 参数写错走单独的、宽松得多的计数器,不污染真实执行失败的熔断
      if (isModelAuthoringError(result)) {
        consecutiveAuthoringErrors += 1
        if (consecutiveAuthoringErrors >= maxAuthoringErrors) {
          return { ok: false, reason: `模型已连续 ${consecutiveAuthoringErrors} 次写出不合法的工具参数` }
        }
        return { ok: true }
      }
      consecutiveErrors += 1
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { ok: false, reason: `工具已连续失败 ${consecutiveErrors} 次` }
      }
      return { ok: true }
    },
    snapshot() {
      return { consecutiveErrors, consecutiveAuthoringErrors, uniqueCalls: counts.size }
    },
  }
}
