import { resolvePptxRepairToolCall } from '../pptxRepairArguments.js'
import { PPTX_FULL_AUTHORING_PARAMETERS } from '../builtinArtifactToolSpecs.js'
import { PPTX_ELEMENT_SCHEMA } from '../pptxArtifactContract.js'
import { validateToolCall } from '../../utils/toolCallArguments.js'
import { knownFailedSideEffectOutcome } from './sideEffectExecution.js'

export function preparePptxRepairToolInput(s, call) {
  try {
    const resolved = resolvePptxRepairToolCall(call, {
      userId: s.job?.userId,
      sessionId: s.job?.origin === 'chat' ? s.job.sessionId || s.approvalSessionId : null,
      turnId: s.job?.id,
    })
    // Preserve the short model-authored argumentsText for protocol replay;
    // durable call/approval/execution args contain the full resolved data.
    if (resolved !== call) Object.assign(call, resolved)
    return null
  } catch (error) {
    if (error?.unsafeToReplay) throw error
    return s.d.normalizeToolError(error)
  }
}

export function withNativePptxPreflightReceipt(error, normalized) {
  const known = knownFailedSideEffectOutcome(error)
  return known?.pptx_preflight
    ? { ...normalized, hint: known.hint, pptx_preflight: known.pptx_preflight }
    : normalized
}

/** Repair envelopes are model inputs, never executable or hook-replacement inputs. */
export function pptxExecutionInputError(name, args, locale = 'zh') {
  if (name !== 'create_pptx') return null
  const issue = validateToolCall({ name, args }, [{
    function: { name, parameters: PPTX_FULL_AUTHORING_PARAMETERS },
  }])
  if (!issue) return null
  if (['repair_from_tool_call_id', 'base_digest', 'edits'].some((key) => Object.hasOwn(args || {}, key))) {
    return {
      ...issue,
      hint: 'Executable PPT input must contain complete native slides. Repair envelopes are expanded before pre-tool hooks; hooks and approvals must preserve complete authoring arguments, not reintroduce a short repair.',
    }
  }
  return refinePptxAuthoringIssue(issue, args, locale)
}

/** Refine diagnostics only; the complete strict schema remains the admission check. */
function refinePptxAuthoringIssue(issue, args, locale) {
  const hints = new Set(['Correct only the reported fields using the native authoring schema. Preserve all required words, fonts, styles and slide count.'])
  const issues = issue.issues.flatMap((message) => {
    const match = message.match(/^(\$\.slides\[(\d+)\]\.elements\[(\d+)\])(?:\s|$)/u)
    if (!match) return [message]
    const element = args?.slides?.[Number(match[2])]?.elements?.[Number(match[3])]
    const schema = PPTX_ELEMENT_SCHEMA.oneOf.find((branch) => branch.properties.type.const === element?.type)
    if (!schema) return [message]
    const detail = validateToolCall({ name: 'create_pptx', args: element }, [{
      function: { name: 'create_pptx', parameters: schema },
    }])
    if (!detail) return [message]
    if (element.type === 'shape' && !Object.hasOwn(element, 'shape')) {
      hints.add(`type="shape" requires an explicit shape value: ${schema.properties.shape.enum.join(', ')}. Choose the intended shape; no default is inferred.`)
    }
    if (element.type === 'shape' && Object.hasOwn(element, 'text')) {
      hints.add('type="shape" does not accept text. Omit an unintended empty text field; preserve any intended non-empty words in a separate editable type="text" element.')
    }
    return detail.issues.map((entry) => entry.replace(/^\$/u, match[1]))
  }).slice(0, 8)
  return { ...issue, issues, error: locale === 'zh'
    ? `工具参数校验失败：${issues.join('；')}`
    : `Tool argument validation failed: ${issues.join('; ')}`, hint: [...hints].join(' ') }
}
