/**
 * 文件产物意图的单一判断源。
 *
 * ★ 背景(2026-07-31 事故):用户让 agent「修复量化交易平台的页面刷新 bug」,
 *   62 步跑完后唯一产物是一份 4 页 PPT,标题还是模型的开场白。
 *   根因不是模型犯傻,是系统在推它:
 *     1. create_pptx / create_docx / create_xlsx 无条件出现在 job 工具集里;
 *     2. 系统提示词常驻「不要把内容写成纯文本回答」+ 7 条 PPT 排版铁律;
 *     3. 判断「用户要不要文件」的关键词散落在 jobWorkflow 和前端两处,各判各的。
 *
 * 这里把「用户到底要不要文件产物」收敛成唯一判断源,同时驱动三个决策点:
 *   - toolLoopRuntime.selectToolSpecs → the model never sees disallowed artifact tools
 *   - jobRuntime 系统提示词分支     → 不给代码任务注入 PPT 排版规则(软约束)
 *   - jobWorkflow.shouldCompileDocx → finalize 自动编译走同一套关键词
 *
 * 语义与前端 src/lib/chatFlowGuards.js 的 filterToolNamesForSkill 保持一致:
 * 文件工具默认不可见,只有明确的产物技能或明确的产物关键词才解锁。
 */

/** 会写出可下载文件的工具。默认对模型不可见。 */
export const FILE_ARTIFACT_TOOLS = Object.freeze([
  'generate_image',
  'render_pdf_pages',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_html_app',
  'create_pdf',
])

import {
  detectArtifactIntent as detectSharedArtifactIntent,
  isArtifactRevisionRequest,
  isExplicitCodeSnippetRequest,
  isPdfToImageConversionRequest,
  parseArtifactSkillId,
  resolveArtifactDeliveryTarget,
  resolveArtifactDeliveryTargets,
  resolveArtifactRevisionMode,
  stripRemoteUrlReferences,
} from '../../shared/artifactIntent.js'

export {
  isArtifactRevisionRequest,
  isExplicitCodeSnippetRequest,
  resolveArtifactDeliveryTarget,
  resolveArtifactDeliveryTargets,
  resolveArtifactRevisionMode,
  stripRemoteUrlReferences,
}

const ARTIFACT_TYPE_BY_TOOL = Object.freeze({
  create_pptx: 'pptx',
  create_docx: 'docx',
  create_xlsx: 'xlsx',
  create_html_app: 'html',
  create_pdf: 'pdf',
  generate_image: 'image',
  render_pdf_pages: 'image',
})
const CONTINUABLE_ARTIFACT_TYPES = new Set(Object.values(ARTIFACT_TYPE_BY_TOOL))

function parseObject(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function callName(call) {
  return String(call?.function?.name || call?.name || '').trim()
}

function callArguments(call) {
  return parseObject(call?.function?.arguments ?? call?.argumentsText ?? call?.arguments ?? call?.args) || {}
}

function artifactType(value, fallback = '') {
  const explicit = String(value?.type || fallback || '').trim().toLowerCase().replace(/^\./, '')
  const normalized = explicit === 'ppt' ? 'pptx' : explicit === 'doc' ? 'docx' : explicit === 'xls' ? 'xlsx' : explicit
  if (CONTINUABLE_ARTIFACT_TYPES.has(normalized)) return normalized
  const filename = String(value?.filename || '')
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : ''
  return CONTINUABLE_ARTIFACT_TYPES.has(extension) ? extension : null
}

/**
 * Return only artifacts produced by the immediately preceding user→assistant
 * turn. Older requests are intentionally ignored so file tools do not leak
 * into unrelated later conversation.
 */
export function findAdjacentDeliveredArtifacts(messages = []) {
  const history = Array.isArray(messages) ? messages : []
  let currentUserIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') { currentUserIndex = index; break }
  }
  if (currentUserIndex <= 0) return []
  let previousUserIndex = -1
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') { previousUserIndex = index; break }
  }
  if (previousUserIndex < 0) return []

  return findDeliveredArtifactsBetween(history, previousUserIndex + 1, currentUserIndex)
}

function findDeliveredArtifactsBetween(history, startIndex, endIndex) {
  const turnMessages = history.slice(startIndex, endIndex)
  const calls = new Map()
  let selectedIds = null
  for (const message of turnMessages) {
    const persistedSelection = message?.role === 'assistant'
      && Object.hasOwn(message?.modelContext || {}, 'deliveryArtifactIds')
      ? message.modelContext.deliveryArtifactIds
      : undefined
    if (Array.isArray(persistedSelection)) selectedIds = persistedSelection.map(String)
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const id = String(call?.id || '').trim()
      const name = callName(call)
      if (!id || !name) continue
      const args = callArguments(call)
      if (name === 'set_deliverables') {
        if (Array.isArray(args.artifact_ids)) selectedIds = args.artifact_ids.map(String)
        continue
      }
      calls.set(id, { id, name, args })
    }
  }

  const artifacts = []
  const seen = new Set()
  for (const message of turnMessages) {
    if (message?.role !== 'tool') continue
    const call = calls.get(String(message.tool_call_id || message.toolCallId || '').trim())
    if (!call) continue
    const result = parseObject(message.content)
    if (!result || result.ok === false) continue
    const candidates = Array.isArray(result.artifacts) && result.artifacts.length > 0
      ? result.artifacts
      : result.artifactId
        ? [{ id: result.artifactId, filename: result.filename, type: result.type, url: result.url }]
        : []
    for (const candidate of candidates) {
      const id = String(candidate?.id || '').trim()
      const type = artifactType(candidate, ARTIFACT_TYPE_BY_TOOL[call.name])
      if (!id || !type || seen.has(id)) continue
      seen.add(id)
      artifacts.push({
        id,
        type,
        filename: String(candidate?.filename || result.filename || '').trim(),
        url: String(candidate?.url || result.url || '').trim(),
        toolName: call.name,
        ...((candidate?.localPath || candidate?.outputPath || candidate?.path
          || result.localPath || result.outputPath || result.path)
          ? {
              localPath: String(candidate?.localPath || candidate?.outputPath || candidate?.path
                || result.localPath || result.outputPath || result.path).trim(),
            }
          : {}),
      })
    }
  }
  // A successful generator result is still a draft until the turn explicitly
  // selects it for delivery. Failed/interrupted turns frequently contain such
  // results; inheriting them would revive stale file requirements on the next
  // user message. Persisted deliveryArtifactIds provide the compatibility
  // receipt for compacted histories that no longer contain set_deliverables.
  if (!Array.isArray(selectedIds)) return []
  const selected = new Set(selectedIds)
  return artifacts.filter((artifact) => selected.has(artifact.id))
}

const CONTINUATION_STATUS_QUESTION = /^(?:(?:请|先|那|那么|现在)\s*)?(?:(?:遇到|出现|发生)(?:了)?\s*(?:什么|哪些)?\s*(?:问题|错误|异常|阻塞)|(?:有|还有|到底有)\s*(?:什么|哪些)?\s*(?:问题|错误|异常)|(?:为什么|为何|怎么|哪里)\s*(?:会)?\s*(?:失败|报错|卡住|停止|中断|没(?:有)?完成|未完成)|(?:现在|当前)?\s*(?:是什么|什么)\s*(?:状态|进度)|(?:完成|做好|成功)(?:了)?\s*(?:吗|没有)|what\s+(?:went\s+wrong|failed)|why\s+(?:did\s+it\s+fail|is\s+it\s+stuck)|what(?:'s|\s+is)\s+the\s+(?:status|problem))(?:[了呢吗]?\s*[?？。.!！]*)$/i
const CONTINUATION_RETRY_PROMPT = /^(?:继续|接着|重试|再试一次|继续处理|继续完成|continue|retry|try\s+again)[\s。.!！]*$/i

function trustedLocalDeliveryPath(value = {}) {
  for (const candidate of [value.localPath, value.outputPath, value.path]) {
    const raw = String(candidate || '').trim()
    if (/^(?:[a-z]:[\\/]|\/)/i.test(raw)) return raw
  }
  return ''
}

function findSuccessfulLocalArtifactsBetween(history, startIndex, endIndex) {
  const turnMessages = history.slice(startIndex, endIndex)
  const calls = new Map()
  for (const message of turnMessages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const rawCall of message.tool_calls) {
      const id = String(rawCall?.id || '').trim()
      const name = callName(rawCall)
      if (!id || !ARTIFACT_TYPE_BY_TOOL[name]) continue
      calls.set(id, { name })
    }
  }

  const artifacts = []
  const seen = new Set()
  for (const message of turnMessages) {
    if (message?.role !== 'tool') continue
    const call = calls.get(String(message.tool_call_id || message.toolCallId || '').trim())
    const result = parseObject(message.content)
    if (!call || !result || result.ok === false) continue
    const candidates = Array.isArray(result.artifacts) && result.artifacts.length > 0
      ? result.artifacts
      : result.artifactId
        ? [result]
        : []
    for (const candidate of candidates) {
      const id = String(candidate?.id || candidate?.artifactId || result.artifactId || '').trim()
      const type = artifactType(candidate, ARTIFACT_TYPE_BY_TOOL[call.name])
      const localPath = trustedLocalDeliveryPath(candidate) || trustedLocalDeliveryPath(result)
      if (!id || !type || !localPath || seen.has(id)) continue
      seen.add(id)
      artifacts.push({
        id,
        type,
        filename: String(candidate?.filename || result.filename || '').trim(),
        url: String(candidate?.url || result.url || '').trim(),
        toolName: call.name,
        localPath,
        continuationOnly: true,
      })
    }
  }
  return artifacts
}

function isTransparentContinuationPrompt(prompt = '') {
  const text = String(prompt || '').trim()
  return CONTINUATION_STATUS_QUESTION.test(text)
    || CONTINUATION_RETRY_PROMPT.test(text)
    || isArtifactRevisionRequest(text, { hasPriorArtifact: true })
}

/**
 * Resolve the active artifact across a short continuation chain. A status
 * question or failed revision must not erase the last trusted file target,
 * while an unrelated explanatory/new-topic turn remains a hard boundary.
 * Successful local generator results may be recovered from an incomplete
 * turn because their concrete output path is stronger evidence than a draft
 * artifact row without a delivery receipt.
 */
export function findContinuableArtifactTargets(messages = [], prompt = '') {
  if (!isArtifactRevisionRequest(prompt, { hasPriorArtifact: true })) return []
  const history = Array.isArray(messages) ? messages : []
  let currentUserIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') { currentUserIndex = index; break }
  }
  if (currentUserIndex <= 0) return []

  let turnEnd = currentUserIndex
  for (let searchIndex = currentUserIndex - 1; searchIndex >= 0;) {
    let previousUserIndex = -1
    for (let index = searchIndex; index >= 0; index -= 1) {
      if (history[index]?.role === 'user') { previousUserIndex = index; break }
    }
    if (previousUserIndex < 0) break

    const delivered = findDeliveredArtifactsBetween(history, previousUserIndex + 1, turnEnd)
    if (delivered.length > 0) return delivered
    const localDeliveries = findSuccessfulLocalArtifactsBetween(history, previousUserIndex + 1, turnEnd)
    if (localDeliveries.length > 0) return localDeliveries

    if (!isTransparentContinuationPrompt(history[previousUserIndex]?.content)) break
    turnEnd = previousUserIndex
    searchIndex = previousUserIndex - 1
  }
  return []
}

const REFERENCE_TOKEN_CHARACTER = /[\p{L}\p{N}._-]/u
const FILENAME_ACTION_PREFIX = /(?:修改|编辑|更新|调整|优化|完善|重做|替换|覆盖|打开|读取|检查|选择|针对|继续|处理|文件(?:是|为)?|名为|叫做|revise|edit|update|modify|open|read|inspect|select)\s*$/iu
const FILENAME_LABEL_SUFFIX = /^(?:的|文件|页面|网页|原版|版本)/u

function hasExactReference(text, reference, { filename = false } = {}) {
  const needle = String(reference || '').trim().toLowerCase()
  if (!needle) return false
  let offset = 0
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset)
    if (index < 0) return false
    const before = index > 0 ? text[index - 1] : ''
    const afterIndex = index + needle.length
    const after = afterIndex < text.length ? text[afterIndex] : ''
    const beforeIsBoundary = !before
      || !REFERENCE_TOKEN_CHARACTER.test(before)
      || (filename && FILENAME_ACTION_PREFIX.test(text.slice(0, index)))
    const afterIsBoundary = !after
      || !REFERENCE_TOKEN_CHARACTER.test(after)
      || (filename && FILENAME_LABEL_SUFFIX.test(text.slice(afterIndex)))
    if (beforeIsBoundary && afterIsBoundary) return true
    offset = index + 1
  }
  return false
}

/**
 * Recover a delivered artifact from an older turn only when the current user
 * explicitly names its exact managed ID or complete filename. This lets a
 * user retry an in-place revision after a failed assistant turn without
 * making unrelated historical artifacts implicit context for every request.
 */
export function findExplicitlyReferencedDeliveredArtifacts(messages = [], prompt = '') {
  const history = Array.isArray(messages) ? messages : []
  const referenceText = stripRemoteUrlReferences(prompt).trim().toLowerCase()
  if (!referenceText) return []

  let currentUserIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') { currentUserIndex = index; break }
  }
  if (currentUserIndex <= 0) return []

  const matches = []
  const seen = new Set()
  let turnEnd = currentUserIndex
  for (let searchIndex = currentUserIndex - 1; searchIndex >= 0;) {
    let previousUserIndex = -1
    for (let index = searchIndex; index >= 0; index -= 1) {
      if (history[index]?.role === 'user') { previousUserIndex = index; break }
    }
    if (previousUserIndex < 0) break

    const artifacts = findDeliveredArtifactsBetween(history, previousUserIndex + 1, turnEnd)
    for (const artifact of artifacts) {
      const id = String(artifact?.id || '').trim()
      const filename = String(artifact?.filename || '').trim()
      const explicitlyNamed = hasExactReference(referenceText, id)
        || hasExactReference(referenceText, filename, { filename: true })
      if (!explicitlyNamed || seen.has(id)) continue
      seen.add(id)
      matches.push(artifact)
    }

    turnEnd = previousUserIndex
    searchIndex = previousUserIndex - 1
  }
  return matches
}

/** 从 `/ppt 帮我讲讲 X` 这类提示词里取技能 id;与 jobRuntime.parseSkillPrompt 同规则。 */
export function parseSkillIdFromPrompt(prompt = '') {
  return parseArtifactSkillId(prompt)
}

/**
 * 判断用户是否明确要某类文件产物。
 *
 * @param {string} prompt 用户原始提示词(保留 `/ppt` 这类前缀)
 * @param {object} [options]
 * @param {string|null} [options.skillId] 已解析出的技能 id;不传则从 prompt 自行解析
 * @returns {{pptx:boolean, docx:boolean, xlsx:boolean, html:boolean, pdf:boolean, image:boolean}}
 */
export function detectArtifactIntent(prompt = '', options = {}) {
  return detectSharedArtifactIntent(prompt, options)
}

/**
 * 本次任务允许模型看到的文件工具集合。没有明确意图时返回空集 ——
 * 模型的工具列表里根本不会出现 create_pptx,也就无从"顺手"生成 PPT。
 *
 * @returns {Set<string>}
 */
export function allowedArtifactTools(prompt = '', options = {}) {
  const intent = detectArtifactIntent(prompt, options)
  const allowed = new Set()
  if (intent.pptx) allowed.add('create_pptx')
  if (intent.docx) allowed.add('create_docx')
  if (intent.xlsx) allowed.add('create_xlsx')
  if (intent.html) allowed.add('create_html_app')
  if (intent.pdf) allowed.add('create_pdf')
  if (intent.image) {
    const revisesRenderedPdfPage = Array.isArray(options?.priorArtifacts)
      && options.priorArtifacts.some((artifact) => artifact?.toolName === 'render_pdf_pages')
      && isArtifactRevisionRequest(prompt, { hasPriorArtifact: true })
    if (isPdfToImageConversionRequest(prompt) || revisesRenderedPdfPage) allowed.add('render_pdf_pages')
    else allowed.add('generate_image')
  }
  return allowed
}

export function isFileArtifactTool(name) {
  return FILE_ARTIFACT_TOOLS.includes(name)
}

/** 用户是否要了任何一种文件产物。用于 finalize 阶段的交付对账。 */
export function expectsFileArtifact(prompt = '', options = {}) {
  const intent = detectArtifactIntent(prompt, options)
  return intent.pptx || intent.docx || intent.xlsx || intent.html || intent.pdf || intent.image
}
