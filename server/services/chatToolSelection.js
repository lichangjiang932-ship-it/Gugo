import {
  hasMutationExecutionIntent,
  normalizeTurnIntentMode,
  shouldRequireExecution,
} from '../utils/executionIntent.js'
import { getToolMetadata } from './toolRegistry.js'

const ORCHESTRATION_TOOL_NAMES = new Set(['Agent', 'manage_todos'])
const ANSWER_RECOVERY_TOOL_NAMES = new Set(['request_clarification', 'request_directory'])

const EXPLICIT_READ_ONLY = /\b(?:read[- ]only|no[- ]write)\b|\b(?:do not|don't|never|without)\b.{0,24}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b|\u53ea\u8bfb|\u4ec5(?:\u67e5\u770b|\u5206\u6790|\u68c0\u67e5)|\u4e0d\u8981.{0,16}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u5220\u9664|\u79fb\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u6253\u8865\u4e01|\u6539\u52a8|\u53d8\u66f4|\u4fee\u590d)/i
const LOCAL_LAYOUT_WRITE_BOUNDARY = /\b(?:do not|don't|never)\s+write\s+(?:below|above|outside|past|beyond|within|inside|in|on)\b[^\r\n.!?]{0,80}\b(?:line|margin|box|area|region|field|space|page|section)\b[^\r\n.!?]*/gi
const SCOPED_READ_ONLY_VERIFIER = /(?:\b(?:separate|independent)\s+)?\bread[- ]only\b(?=\s+(?:(?:verification|validation|checker|validator|script|tool)\b|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))|(?:\u53e6\u5199|\u53e6\u5efa|\u5355\u72ec|\u72ec\u7acb|\u53e6\u5916)?\s*\u53ea\u8bfb(?=\s*(?:(?:\u9a8c\u8bc1|\u6821\u9a8c|\u68c0\u67e5)(?:\u811a\u672c|\u5668|\u7a0b\u5e8f|\u5de5\u5177)?|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))/gi
const GLOBAL_READ_ONLY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,48}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b[^\r\n.!?;]{0,32}\b(?:any|all)\s+(?:files?|documents?|artifacts?)\b|\b(?:read[- ]only|no[- ]write)\b[^\r\n.!?;]{0,32}\b(?:entire|whole|all)\s+(?:project|repository|repo|workspace)\b|\b(?:entire|whole)\s+(?:project|repository|repo|workspace)\b[^\r\n.!?;]{0,32}\b(?:read[- ]only|no[- ]write)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u5220\u9664|\u79fb\u52a8|\u91cd\u547d\u540d)[^\r\n\u3002\uff1b]{0,24}(?:\u4efb\u4f55|\u6240\u6709)(?:\u6587\u4ef6|\u6587\u6863|\u4ea7\u7269)|(?:\u6574\u4e2a|\u5168\u90e8)(?:\u9879\u76ee|\u4ed3\u5e93|\u5de5\u4f5c\u533a)[^\r\n\u3002\uff1b]{0,24}(?:\u53ea\u8bfb|\u4ec5\u67e5\u770b|\u4ec5\u5206\u6790|\u4e0d\u8981\u4fee\u6539)/i
const SCOPED_SOURCE_READ_ONLY_BOUNDARY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,40}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b[^\r\n.!?;]{0,24}\b(?:the\s+|this\s+)?(?:source|input|original)\s+(?:pdf|file|document|image)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u8986\u76d6|\u5220\u9664|\u79fb\u52a8|\u91cd\u547d\u540d)[^\r\n\u3002\uff1b]{0,24}(?:\u6e90|\u8f93\u5165|\u539f\u59cb)(?:\s*PDF|\u6587\u4ef6|\u6587\u6863|\u56fe\u7247)/i
const SCOPED_CONTENT_PRESERVATION_BOUNDARY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,40}\b(?:change|modify|edit|rewrite|alter)\b[^\r\n.!?;]{0,24}\b(?:the\s+|this\s+)?(?:article(?:'s)?(?:\s+(?:content|text|wording))?|body(?:\s+(?:content|text))?|copy|wording|text\s+content)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,24}(?:\u4fee\u6539|\u7f16\u8f91|\u6539\u52a8|\u53d8\u66f4|\u6539\u5199)[^\r\n\u3002\uff1b]{0,20}(?:(?:\u8fd9\u7bc7|\u8be5\u7bc7|\u539f\u59cb|\u6e90)?\u6587\u7ae0(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u6b63\u6587(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u539f\u6587(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u6587\u672c\u5185\u5bb9|\u6587\u5b57\u5185\u5bb9|\u6587\u6848|\u63aa\u8f9e)/i
const SCOPED_CONTENT_FIDELITY_BOUNDARY = /\b(?:preserve|keep|retain)\b[^\r\n.!?;]{0,80}\b(?:article|body|text|wording|content)\b[^\r\n.!?;]{0,80}\b(?:do not|don't|never)\b[^\r\n.!?;]{0,32}\b(?:change|modify|edit|polish|delete|remove|add|rewrite|alter)\b[^\r\n.!?;]{0,32}\b(?:content|text|wording|paragraphs?|spelling|grammar|punctuation)\b|(?:\u4fdd\u7559|\u4fdd\u6301)[^\r\n\u3002\uff1b]{0,80}(?:\u6587\u7ae0|\u6b63\u6587|\u539f\u6587)[^\r\n\u3002\uff1b]{0,80}(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u6da6\u8272|\u5220\u51cf|\u589e\u52a0|\u6539\u5199)[^\r\n\u3002\uff1b]{0,24}(?:\u5185\u5bb9|\u6587\u5b57|\u6bb5\u843d|\u62fc\u5199|\u8bed\u6cd5|\u6807\u70b9)/i
const EXECUTION_CONTINUATION = /^(?:continue(?:\s+(?:with\s+)?(?:it|this|the\s+(?:work|changes?|implementation)))?|go\s+ahead|proceed|approved?|i\s+(?:approve|authorize\s+you)(?:\s+to\s+(?:continue|proceed|execute|make\s+the\s+changes?))?|\u7ee7\u7eed(?:\u6267\u884c|\u5904\u7406|\u4fee\u6539|\u5b8c\u6210|\u505a|\u4e0b\u53bb)?(?:\u5427)?|\u6211(?:\u540c\u610f|\u6279\u51c6|\u6388\u6743\u7ed9\u4f60)(?:[\s,\uff0c]*(?:\u7ee7\u7eed|\u6267\u884c|\u4fee\u6539|\u5904\u7406|\u64cd\u4f5c))?|\u6388\u6743\u7ed9\u4f60(?:[\s,\uff0c]*(?:\u7ee7\u7eed|\u6267\u884c|\u4fee\u6539|\u5904\u7406|\u64cd\u4f5c))?)[.!?\u3002\uff01\uff1f\s]*$/i

// Code generation and execution requests get the execution toolset even when
// no file target is named. Otherwise the model receives read-only tools only
// and tells the user "this environment has no code execution tools" although
// bash_exec / run_command are available and approval-gated.
const CODE_EXECUTION_INTENT = new RegExp(
  [
    // 中文:写/生成/实现/创建/修复 + 代码/脚本/函数/程序/工具/接口/爬虫 或语言名
    '(?:(?:\u5199|\u7f16\u5199|\u751f\u6210|\u5b9e\u73b0|\u521b\u5efa|\u4fee\u590d|\u5e2e\u6211\u5199|\u505a\u4e00\u4e2a?)[^\r\n\u3002\uff01\uff1f!?,\uff0c;\uff1b]{0,12}(?:\u4ee3\u7801|\u811a\u672c|\u51fd\u6570|\u7a0b\u5e8f|\u5de5\u5177|\u63a5\u53e3|\u722c\u866b|python|javascript|bash|shell))',
    // 中文:运行/执行/测试/跑 + 代码/脚本/命令/程序
    '(?:(?:\u8fd0\u884c|\u6267\u884c|\u6d4b\u8bd5|\u8dd1\u4e00\u4e0b|\u8dd1|\u8bd5\u8bd5|\u9a8c\u8bc1)[^\r\n\u3002\uff01\uff1f!?,\uff0c;\uff1b]{0,8}(?:\u4ee3\u7801|\u811a\u672c|\u547d\u4ee4|\u7a0b\u5e8f|python|script|code))',
    // 英文:write/create/generate/implement/build + code/script/function/program
    '(?:\\b(?:write|create|generate|implement|build|code)\\b[^\r\n.!?]{0,30}\\b(?:code|script|function|program|python|javascript|bash|shell)\\b)',
    // 英文:run/execute/test/try + code/script/command/program
    '(?:\\b(?:run|execute|test|try)\\b[^\r\n.!?]{0,12}\\b(?:code|script|command|program|python)\\b)',
  ].join('|'),
  'i',
)

function toolName(spec) {
  return String(spec?.function?.name || '').trim()
}

function isReadOnlyRequest(userPrompt) {
  // Printed forms commonly contain local layout instructions such as
  // "Do not write below this line". They constrain where generated content
  // may be placed; they are not a request to keep the entire file read-only.
  // Likewise, a "read-only verifier" describes one validation component in
  // an otherwise mutating workflow. It must not downgrade the whole turn.
  // A separate whole-request boundary such as "do not modify the file" is
  // intentionally left intact and still wins below.
  const promptWithoutLayoutBoundaries = String(userPrompt || '')
    .replace(LOCAL_LAYOUT_WRITE_BOUNDARY, ' ')
    .replace(SCOPED_READ_ONLY_VERIFIER, ' ')
  if (!EXPLICIT_READ_ONLY.test(promptWithoutLayoutBoundaries)) return false
  if (GLOBAL_READ_ONLY.test(promptWithoutLayoutBoundaries)) return true

  // Only a boundary explicitly scoped to a single source/input/original may
  // coexist with a separate output mutation. Other explicit read-only wording
  // remains a whole-request boundary, even when a proposed fix is discussed.
  if (SCOPED_SOURCE_READ_ONLY_BOUNDARY.test(promptWithoutLayoutBoundaries)
    || SCOPED_CONTENT_PRESERVATION_BOUNDARY.test(promptWithoutLayoutBoundaries)
    || SCOPED_CONTENT_FIDELITY_BOUNDARY.test(promptWithoutLayoutBoundaries)) {
    return !hasMutationExecutionIntent(promptWithoutLayoutBoundaries)
  }
  return true
}

function shouldInheritExecutionIntent(userPrompt, previousUserPrompt) {
  const current = String(userPrompt || '').trim()
  const previous = String(previousUserPrompt || '').trim()
  if (!current || !previous || current.length > 120 || !EXECUTION_CONTINUATION.test(current)) return false
  // A prior global/read-only instruction remains authoritative. A short reply
  // can confirm an existing user-authored work order, but cannot create one.
  if (isReadOnlyRequest(previous)) return false
  return shouldRequireExecution({ intentMode: 'auto', text: previous })
}

function stableUniqueSpecs(specs) {
  const byName = new Map()
  for (const spec of Array.isArray(specs) ? specs : []) {
    const name = toolName(spec)
    if (name) byName.set(name, spec)
  }
  return [...byName.values()]
    .sort((left, right) => toolName(left).localeCompare(toolName(right), 'en'))
}

function readOnlyMetadata(name, { userId, metadataResolver }) {
  try {
    return metadataResolver(name, { args: {}, userId })?.isReadOnly === true
  } catch {
    // Unknown or malformed dynamic tools fail closed in answer/read-only mode.
    return false
  }
}

/**
 * Choose one of two stable capability sets, then let the model select the
 * concrete tool. This avoids brittle per-capability keyword routing while
 * keeping write/exec/external schemas out of answer-only requests.
 */
export function resolveChatCapabilityMode({
  prompt = '',
  userPrompt = prompt,
  previousUserPrompt = '',
  intentMode = 'auto',
  executionRequired = false,
} = {}) {
  if (isReadOnlyRequest(userPrompt)) return 'answer'
  const normalized = normalizeTurnIntentMode(intentMode)
  if (normalized === 'answer') return 'answer'
  if (normalized === 'execute') return 'execute'
  if (executionRequired) return 'execute'
  if (shouldInheritExecutionIntent(userPrompt, previousUserPrompt)) return 'execute'
  if (CODE_EXECUTION_INTENT.test(String(userPrompt || ''))) return 'execute'
  return shouldRequireExecution({ intentMode: normalized, text: userPrompt }) ? 'execute' : 'answer'
}

/**
 * Permissions/configuration are applied before this function. It only removes
 * capabilities; it never recreates a disabled tool. Answer mode retains tools
 * whose registered metadata is genuinely read-only, excluding orchestration
 * because delegated agents may perform mutations outside this local filter.
 */
export function selectChatToolSpecs({
  prompt = '',
  userPrompt = prompt,
  previousUserPrompt = '',
  specs = [],
  intentMode = 'auto',
  executionRequired = false,
  userId = null,
  metadataResolver = getToolMetadata,
} = {}) {
  const capabilityMode = resolveChatCapabilityMode({
    prompt,
    userPrompt,
    previousUserPrompt,
    intentMode,
    executionRequired,
  })
  const stableSpecs = stableUniqueSpecs(specs)
  if (capabilityMode === 'execute') return stableSpecs
  return stableSpecs.filter((spec) => {
    const name = toolName(spec)
    return !ORCHESTRATION_TOOL_NAMES.has(name)
      && (ANSWER_RECOVERY_TOOL_NAMES.has(name)
        || readOnlyMetadata(name, { userId, metadataResolver }))
  })
}
