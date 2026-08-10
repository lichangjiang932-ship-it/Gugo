import { normalizeTurnIntentMode, shouldRequireExecution } from '../utils/executionIntent.js'
import { getToolMetadata } from './toolRegistry.js'

const ORCHESTRATION_TOOL_NAMES = new Set(['Agent', 'manage_todos'])
const ANSWER_RECOVERY_TOOL_NAMES = new Set(['request_clarification', 'request_directory'])

const EXPLICIT_READ_ONLY = /\b(?:read[- ]only|no[- ]write)\b|\b(?:do not|don't|never|without)\b.{0,24}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b|\u53ea\u8bfb|\u4ec5(?:\u67e5\u770b|\u5206\u6790|\u68c0\u67e5)|\u4e0d\u8981.{0,16}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u5220\u9664|\u79fb\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u6253\u8865\u4e01|\u6539\u52a8|\u53d8\u66f4|\u4fee\u590d)/i
const LOCAL_LAYOUT_WRITE_BOUNDARY = /\b(?:do not|don't|never)\s+write\s+(?:below|above|outside|past|beyond|within|inside|in|on)\b[^\r\n.!?]{0,80}\b(?:line|margin|box|area|region|field|space|page|section)\b[^\r\n.!?]*/gi
const SCOPED_READ_ONLY_VERIFIER = /(?:\b(?:separate|independent)\s+)?\bread[- ]only\b(?=\s+(?:(?:verification|validation|checker|validator|script|tool)\b|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))|(?:\u53e6\u5199|\u53e6\u5efa|\u5355\u72ec|\u72ec\u7acb|\u53e6\u5916)?\s*\u53ea\u8bfb(?=\s*(?:(?:\u9a8c\u8bc1|\u6821\u9a8c|\u68c0\u67e5)(?:\u811a\u672c|\u5668|\u7a0b\u5e8f|\u5de5\u5177)?|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))/gi

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
  return EXPLICIT_READ_ONLY.test(promptWithoutLayoutBoundaries)
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
  intentMode = 'auto',
  executionRequired = false,
} = {}) {
  if (isReadOnlyRequest(userPrompt)) return 'answer'
  const normalized = normalizeTurnIntentMode(intentMode)
  if (normalized === 'answer') return 'answer'
  if (normalized === 'execute') return 'execute'
  if (executionRequired) return 'execute'
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
  specs = [],
  intentMode = 'auto',
  executionRequired = false,
  userId = null,
  metadataResolver = getToolMetadata,
} = {}) {
  const capabilityMode = resolveChatCapabilityMode({
    prompt,
    userPrompt,
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
