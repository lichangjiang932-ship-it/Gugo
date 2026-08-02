import { translateKey } from '../i18n/translations.js'

function localized(key, lang = 'zh', vars = {}) {
  const raw = translateKey(`toolRuntime.${key}`, lang)
  return String(raw).replace(/\{(\w+)\}/g, (_, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`
  ))
}

const SKILL_ARTIFACT_TYPES = {
  ppt: 'pptx',
  htmlppt: 'html',
  doc: 'docx',
  excel: 'xlsx',
}

const HTMLPPT_BLOCKED_TOOLS = new Set([
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_html_app',
  'create_react_component',
  'create_mermaid',
  'create_chart',
  'create_svg',
])

const FILE_ARTIFACT_TOOLS = new Set([
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_html_app',
])

const FILE_ARTIFACT_TOOL_BY_SKILL = {
  ppt: 'create_pptx',
  doc: 'create_docx',
  excel: 'create_xlsx',
  webpage: 'create_html_app',
}

// 只有明确无副作用的工具可以在模型流尚未结束时启动。未知/MCP/写入工具
// 必须等 canonical tool_calls 批次，避免 provider failover 造成重复副作用。
const STREAMING_SAFE_TOOLS = new Set([
  'read_file', 'list_directory', 'grep_code', 'find_symbol', 'list_imports',
  'git_status', 'git_diff', 'git_log', 'web_search', 'fetch_url',
  'browser_state', 'browser_snapshot', 'browser_console', 'browser_screenshot',
  'connected_app_list', 'notion_search', 'notion_fetch_page',
  'github_search_repositories', 'github_get_file',
])

const CONFIG_ERROR_PATTERNS = [
  /后端模型未配置/,
  /缺少\s+MODEL_/,
  /MODEL_(?:BASE_URL|NAME|API_KEY)/,
  /API Key 无效|API Key .*权限/,
  /端点不可达/,
  /模型或端点不存在/,
  /模型名称无效/,
]

let fallbackCallSequence = 0

function newToolCallId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `call-${uuid}`
  fallbackCallSequence += 1
  return `call-${Date.now()}-${fallbackCallSequence}`
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function canonicalArguments(raw) {
  if (raw && typeof raw === 'object') {
    try { return JSON.stringify(stableValue(raw)) } catch { return '{}' }
  }
  const text = typeof raw === 'string' ? raw : '{}'
  try { return JSON.stringify(stableValue(JSON.parse(text || '{}'))) } catch { return text }
}

/** 兼容不同上游形状，并保证同一批调用 id 唯一。 */
export function normalizeChatToolCalls(rawCalls = [], { idFactory = newToolCallId } = {}) {
  if (!Array.isArray(rawCalls)) return []
  const usedIds = new Set()
  return rawCalls.map((rawCall) => {
    const raw = rawCall && typeof rawCall === 'object' ? rawCall : {}
    let id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || usedIds.has(id)) {
      do { id = idFactory() } while (!id || usedIds.has(id))
    }
    usedIds.add(id)
    const rawArguments = raw.function?.arguments ?? raw.arguments ?? '{}'
    let argsText
    if (typeof rawArguments === 'string') argsText = rawArguments || '{}'
    else {
      try { argsText = JSON.stringify(rawArguments ?? {}) } catch { argsText = '{}' }
    }
    const name = String(raw.function?.name || raw.name || '').trim()
    return {
      id,
      name,
      arguments: argsText,
      // ★ 空名字的调用不该被真的派发出去。
      //
      // 小模型偶尔会吐出 tool_calls 但没有 function.name(或者名字被流式
      // 分片截断)。原来这里让 name 变成 '' 然后照样往下派发,
      // 执行层拿到空名字要么找不到工具报个看不懂的错、要么(更糟)
      // 绕过按名字做的审批门控。标记出来,让调用方直接回喂模型让它重写。
      invalid: !name,
    }
  })
}

export function isStreamingSafeToolCall(call) {
  const name = String(call?.name || call?.function?.name || '').trim()
  if (!STREAMING_SAFE_TOOLS.has(name)) return false
  if (name !== 'fetch_url') return true
  let args = call?.arguments ?? call?.function?.arguments ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}') } catch { return false }
  }
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(args?.method || 'GET').toUpperCase())
}

/** 聊天侧无进展熔断，避免无限模式一直重复烧模型调用。 */
/** 从工具结果里判断这是不是「这个工具在本环境根本不可用」。 */
function isToolUnavailableResult(result) {
  if (result?.ok !== false) return false
  const text = typeof result.content === 'string' ? result.content : ''
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    if (parsed?.retryable === false) return true
    return /HTTP 404|\u672a\u6ce8\u518c|\u540e\u7aef\u8def\u7531\u7f3a\u5931/.test(String(parsed?.error || ''))
  } catch {
    return /HTTP 404|\u672a\u6ce8\u518c|\u540e\u7aef\u8def\u7531\u7f3a\u5931/.test(text)
  }
}

export function createChatToolLoopGuard({ maxRepeatedCalls = 4, maxConsecutiveErrors = 6, maxUnavailableCalls = 2, lang = 'zh' } = {}) {
  const counts = new Map()
  // ★ 按**工具名**记不可用次数,而不是按「名字+参数」。
  //
  // 原来的 counts 用完整参数做 key,所以模型每次换个 path 重试都算"新调用",
  // 永远撞不到重复上限。实测日志里 grep_code 因为后端漏注册路由连着 404 六次,
  // 每次参数都不同 —— 熔断器从头到尾没响过,模型就一直在原地撞墙。
  const unavailable = new Map()
  let consecutiveErrors = 0
  return {
    before(call) {
      const name = call?.name || '<missing>'
      const deadCount = unavailable.get(name) || 0
      if (deadCount >= maxUnavailableCalls) {
        return {
          ok: false,
          reason: localized('unavailable', lang, { name, count: deadCount }),
        }
      }
      const signature = `${name}:${canonicalArguments(call?.arguments)}`
      const count = (counts.get(signature) || 0) + 1
      counts.set(signature, count)
      if (count > maxRepeatedCalls) {
        return { ok: false, reason: localized('repeated', lang, { count }) }
      }
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { ok: false, reason: localized('consecutiveErrors', lang, { count: consecutiveErrors }) }
      }
      return { ok: true }
    },
    /**
     * @param {object} result 工具执行结果
     * @param {object} [call] 产生这个结果的调用。**必须传** —— 并行工具调用时
     *   before/after 会交错，靠模块内的 lastCallName 记名字会记错工具。
     */
    after(result, call) {
      consecutiveErrors = result?.ok === false ? consecutiveErrors + 1 : 0
      const name = call?.name || ''
      if (name && isToolUnavailableResult(result)) {
        unavailable.set(name, (unavailable.get(name) || 0) + 1)
      }
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { ok: false, reason: localized('consecutiveErrors', lang, { count: consecutiveErrors }) }
      }
      return { ok: true }
    },
  }
}

/**
 * 截断工具结果但不把原本合法的 JSON 切成语法残片。
 *
 * ★ 默认 6000 → 24000,和后端 DEFAULT_TOOL_OUTPUT_CHARS 对齐。
 * 6000 字符 ≈ 1500 token,读一个稍大的源文件就被砍掉大半,
 * 模型拿着残缺内容做判断却不知道自己看的是截断版。
 */
export function clipChatToolContent(content, maxChars = 24_000, lang = 'zh') {
  const text = String(content ?? '')
  const limit = Math.max(500, Number(maxChars) || 6000)
  if (text.length <= limit) return text

  let previewChars = Math.max(100, limit - 220)
  let clipped
  do {
    clipped = JSON.stringify({
      truncated: true,
      _truncated: true,
      originalChars: text.length,
      preview: text.slice(0, previewChars),
      hint: localized('clippedHint', lang),
    })
    previewChars -= 100
  } while (clipped.length > limit && previewChars > 100)
  return clipped.length <= limit
    ? clipped
    : JSON.stringify({ truncated: true, _truncated: true, originalChars: text.length })
}

export function artifactTypeForSkill(skillId) {
  return SKILL_ARTIFACT_TYPES[skillId] || undefined
}

export function filterToolNamesForSkill(toolNames = [], skillId = '') {
  const names = Array.from(toolNames || []).filter((name) => typeof name === 'string')
  if (skillId === 'htmlppt' || skillId === 'axippt') {
    return names.filter((name) => !HTMLPPT_BLOCKED_TOOLS.has(name))
  }

  // 文件工具只能由对应的明确产物技能解锁。通用/代码/调研任务即使在
  // 设置里打开了 create_pptx,模型也看不到它,不能再把修 bug 误做成 PPT。
  const allowedFileTool = FILE_ARTIFACT_TOOL_BY_SKILL[skillId] || null
  return names.filter((name) => !FILE_ARTIFACT_TOOLS.has(name) || name === allowedFileTool)
}

/**
 * Tool specs are the capability boundary for one chat turn. Providers should
 * not return calls for tools that were not declared, but smaller/local models
 * occasionally do. Never execute such hallucinated calls.
 */
export function validateChatToolCallAllowed(call, allowedToolNames = [], lang = 'zh') {
  const name = String(call?.name || call?.function?.name || '').trim()
  if (!name) return { ok: true }
  const allowed = allowedToolNames instanceof Set
    ? allowedToolNames
    : new Set(Array.from(allowedToolNames || []))
  if (allowed.has(name)) return { ok: true }
  return {
    ok: false,
    code: 'undeclared_tool_call',
    reason: localized('undeclared', lang, { name }),
  }
}

export function buildAssistantToolCallsMessage(toolCalls = []) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    })),
  }
}

/**
 * 产物工具跑完后是否直接结束整轮对话。
 *
 * ★ 以前只要产出任何 artifact 就 break —— 于是模型刚生成完文件,
 * 循环立刻中断,它没有机会说「我改了什么、为什么改、还有什么问题」。
 * 用户看到的就是:一堆工具调用 + 一个凭空出现的文件,零解释。
 *
 * 产物永远不能代替文字答复。即使用户明确要 PPT/文档,文件生成后也必须
 * 再给一段文字说明结果、内容和验证情况。
 *
 * @param {object} artifact
 * @param {object} [context]
 * @param {boolean} [context.artifactWasRequested] 用户是否明确要这类产物(有 skillId 即视为要)
 */
export function shouldStopAfterArtifactTool(artifact, { artifactWasRequested = false } = {}) {
  void artifact
  void artifactWasRequested
  return false
}

export function shouldForceChatTextWrapUp({ completedToolCalls = 0, sawTextThisRound = false } = {}) {
  return Number(completedToolCalls) > 0 && sawTextThisRound !== true
}

export function buildChatFailureMessage(message = '') {
  const detail = String(message || '模型代理调用失败。')
  const base = `\n\n模型调用失败：${detail}`
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return `${base}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。`
  }
  return base
}

/**
 * 把工具调用名翻译成人话。
 * 只覆盖高频工具,认不出来的直接用原名 —— 原名也比没有强。
 */
const TOOL_LABEL_KEYS = Object.freeze({
  read_file: 'readFile',
  write_file: 'writeFile',
  apply_patch: 'applyPatch',
  list_dir: 'listDirectory',
  code_search: 'codeSearch',
  bash_exec: 'bashExec',
  git_status: 'gitStatus',
  git_diff: 'gitDiff',
  git_commit: 'gitCommit',
  git_push: 'gitPush',
  web_search: 'webSearch',
  fetch_url: 'fetchUrl',
  create_docx: 'createDocx',
  create_pptx: 'createPptx',
  create_xlsx: 'createXlsx',
})

function toolLabel(name, lang) {
  const key = TOOL_LABEL_KEYS[name]
  return key ? localized(`labels.${key}`, lang) : (name || localized('labels.unknown', lang))
}

/**
 * 模型收尾失败时,**本地**合成一份「到底做了什么」的说明。
 *
 * ★ 为什么必须有这个:原来收尾调用失败就只留一句
 * 「工具执行已完成。模型未返回详细文字总结，请重试生成说明。」——
 * 用户跑了几十步工具、等了几分钟,最后拿到的是一句正确的废话:
 * 没说改了什么、没说哪里没做完、也没给任何可操作的下一步。
 *
 * 这些信息其实**全都在前端手里**(每个工具调用的名字、参数、成功与否
 * 都已经渲染在执行过程里了),不需要再问模型一次。模型不肯说,
 * 我们自己按事实说。
 *
 * @param {object} params
 * @param {Array} params.toolCalls 本轮执行过的工具调用 [{name, arguments, ok, error}]
 * @param {object|null} params.artifact 产出的文件(如有)
 * @param {string} params.finishReason 最后一次模型调用的终止原因
 * @returns {string} markdown 文本
 */
export function buildToolRunSummary({ toolCalls = [], artifact = null, finishReason = null, lang = 'zh' } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  const succeeded = calls.filter((call) => call?.ok !== false)
  const failed = calls.filter((call) => call?.ok === false)

  const lines = []

  // 为什么没有正文 —— 这是用户最想知道的
  if (finishReason === 'length') {
    lines.push(`> ⚠ ${localized('summary.outputBudget', lang)}`)
    lines.push(`> ${localized('summary.reasoningBudget', lang)}`)
  } else {
    lines.push(`> ⚠ ${localized('summary.noText', lang)}`)
  }
  lines.push('')

  // 按工具归类统计,而不是流水账 —— 读了 40 个文件不需要列 40 行
  if (succeeded.length) {
    const byName = new Map()
    for (const call of succeeded) {
      const name = call?.name || ''
      byName.set(name, (byName.get(name) || 0) + 1)
    }
    lines.push(`**${localized('summary.completed', lang)}**`)
    for (const [name, count] of byName) {
      lines.push(`- ${toolLabel(name, lang)}${count > 1 ? ` × ${count}` : ''}`)
    }
    lines.push('')
  }

  // 写操作单独列出来 —— 「改了哪些文件」是最需要交代的事
  const mutations = succeeded.filter((call) => (
    ['write_file', 'apply_patch', 'git_commit', 'git_push'].includes(call?.name)
  ))
  if (mutations.length) {
    lines.push(`**${localized('summary.changes', lang)}**`)
    for (const call of mutations.slice(0, 20)) {
      let target
      try {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {})
        target = args.path || args.file || args.message || ''
      } catch {
        target = ''
      }
      lines.push(`- ${toolLabel(call.name, lang)}${target ? `：\`${target}\`` : ''}`)
    }
    if (mutations.length > 20) lines.push(`- ${localized('summary.more', lang, { count: mutations.length - 20 })}`)
    lines.push('')
  }

  if (failed.length) {
    lines.push(`**${localized('summary.failed', lang)}**`)
    for (const call of failed.slice(0, 10)) {
      let reason
      try {
        const parsed = typeof call.error === 'string' ? JSON.parse(call.error) : call.error
        reason = parsed?.error || parsed?.message || ''
      } catch {
        reason = String(call.error || '').slice(0, 120)
      }
      lines.push(`- ${toolLabel(call.name, lang)}${reason ? `：${reason}` : ''}`)
    }
    if (failed.length > 10) lines.push(`- ${localized('summary.moreFailed', lang, { count: failed.length - 10 })}`)
    lines.push('')
  }

  if (artifact) {
    lines.push(`**${localized('summary.artifact', lang)}**：${artifact.title || localized('summary.file', lang)}（${artifact.type}）`)
    lines.push('')
  }

  // 明确告诉用户「这不是完成品」以及下一步怎么办
  lines.push(`**${localized('summary.next', lang)}**`)
  if (failed.length) {
    lines.push(`- ${localized('summary.incomplete', lang)}`)
  }
  lines.push(`- ${localized('summary.unverified', lang)}`)
  lines.push(`- ${localized('summary.askSummary', lang)}`)

  return lines.join('\n')
}

export function getVisibleModelErrorMessage(error, t) {
  if (error?.code === 'EMPTY_MODEL_RESPONSE_LENGTH') return t('errors.emptyModelResponseLength')
  if (error?.code === 'EMPTY_MODEL_RESPONSE') return t('errors.emptyModelResponse')
  return error?.message || String(error || '')
}
