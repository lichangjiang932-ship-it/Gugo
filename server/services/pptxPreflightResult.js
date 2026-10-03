import { canonicalSideEffectArgsDigest } from './sideEffectExecutionSerialization.js'
import { PPTX_FULL_AUTHORING_PARAMETERS } from './builtinArtifactToolSpecs.js'
import { nativePptxPreflightDiagnostics, PPTX_PREFLIGHT_KIND } from './pptxPreflightDiagnostics.js'
import { normalizeToolError, redactSensitiveText } from '../utils/toolCallErrors.js'
import { validateToolCall } from '../utils/toolCallArguments.js'

export function nativePptxPreflightResult(error, args, toolCallId) {
  const diagnostics = nativePptxPreflightDiagnostics(error)
  if (!diagnostics) return null
  const fullInput = validateToolCall({ name: 'create_pptx', args }, [{
    function: { name: 'create_pptx', parameters: PPTX_FULL_AUTHORING_PARAMETERS },
  }]) === null
  const repairable = fullInput && diagnostics.geometry_repairable
  const baseDigest = fullInput ? canonicalSideEffectArgsDigest(args) : null
  return {
    ...normalizeToolError(error),
    hint: repairable
      ? 'Preserve all text, fonts, styles and slide count. Repair only the necessary x/y/w/h values using create_pptx with repair_from_tool_call_id, base_digest and edits. Do not resend or redesign the full deck. minimum_h is the preflight fit estimate at unchanged width/font; check neighbouring elements before choosing geometry.'
      : 'Correct the reported authoring content without dropping text or data. No output was written by this native preflight pass.',
    pptx_preflight: {
      kind: PPTX_PREFLIGHT_KIND, no_output: true, source_complete: fullInput,
      geometry_repairable: repairable, base_digest: baseDigest,
      ...(toolCallId ? { repair_from_tool_call_id: toolCallId } : {}),
      issue_count: diagnostics.issue_count, issues_truncated: diagnostics.truncated,
      issues: diagnostics.issues.map((issue) => ({ ...issue, message: redactSensitiveText(issue.message) })),
    },
  }
}
