import { PPTX_REPAIR_PARAMETERS } from './pptxArtifactContract.js'
import { PPTX_FULL_AUTHORING_PARAMETERS } from './builtinArtifactToolSpecs.js'
import { PPTX_PREFLIGHT_KIND } from './pptxPreflightDiagnostics.js'
import { readPptxRepairSource } from './pptxRepairSources.js'
import { canonicalSideEffectArgsDigest } from './sideEffectExecutionSerialization.js'
import { validateToolCall } from '../utils/toolCallArguments.js'

function invalid(code, message) {
  throw Object.assign(new TypeError(message), { code, retryable: true })
}

function validate(args, parameters, code) {
  const issue = validateToolCall({ name: 'create_pptx', args }, [{ function: { name: 'create_pptx', parameters } }])
  if (issue) invalid(code, issue.error)
}

function hasOutput(outcome) {
  return outcome?.artifactId || outcome?.artifact?.id || outcome?.artifacts?.length
    || outcome?.artifactIds?.length || outcome?.deliveryArtifactIds?.length
}

function provenPreflight(outcome, digest) {
  const proof = outcome?.pptx_preflight
  return outcome?.ok === false && outcome.retryable === true
    && ['PPTX_CONTENT_OVERFLOW', 'PPTX_CONTENT_INVALID'].includes(outcome.code)
    && !outcome.unsafeToReplay && !outcome.requiresUserVerification && !hasOutput(outcome)
    && !outcome.truncated && !outcome._truncated && !outcome.sourceOmittedFromHistory
    && proof?.kind === PPTX_PREFLIGHT_KIND && proof.no_output === true
    && proof.source_complete === true && proof.geometry_repairable === true
    && proof.base_digest === digest
}

function validatedSource(record, scope, request) {
  const unavailable = () => invalid('PPTX_REPAIR_SOURCE_UNAVAILABLE', 'The repair source is not a complete, same-turn, host-confirmed native preflight failure. Do not replay unknown, committed, compacted or cross-turn inputs.')
  if (!record || Object.keys(scope).some((key) => record.scope?.[key] !== scope[key])) unavailable()
  const ledger = record.ledger
  if (ledger?.owner_id !== scope.userId || ledger.session_id !== scope.sessionId || ledger.turn_id !== scope.turnId
    || ledger.tool_name !== 'create_pptx' || ledger.tool_call_id !== request.repair_from_tool_call_id
    || !Array.isArray(record.events) || !record.events.length) unavailable()
  if (['unknown', 'executing'].includes(ledger.status)) {
    throw Object.assign(new Error('The referenced PPT execution has an unknown outcome. Verify it before any repair; it is not a prewrite failure.'), {
      code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true, requiresUserVerification: true,
    })
  }
  if (ledger.status !== 'failed') unavailable()
  let source
  for (const event of record.events) {
    if (event.name !== 'create_pptx' || event.toolCallId !== request.repair_from_tool_call_id
      || event.modelOutputTruncated || event.truncated || event._truncated
      || !provenPreflight(event.result, request.base_digest)) unavailable()
    const args = event.args
    validate(args, PPTX_FULL_AUTHORING_PARAMETERS, 'PPTX_REPAIR_SOURCE_UNAVAILABLE')
    if (canonicalSideEffectArgsDigest(args) !== request.base_digest) {
      invalid('PPTX_REPAIR_BASE_MISMATCH', 'base_digest does not match the complete host authoring input. Use the exact digest and call ID from the same preflight receipt.')
    }
    source ||= args
  }
  if (ledger.args_digest !== request.base_digest || !provenPreflight(ledger.outcome, request.base_digest)) unavailable()
  return source
}

export function resolvePptxRepairArguments(request, scope, { readSource = readPptxRepairSource } = {}) {
  validate(request, PPTX_REPAIR_PARAMETERS, 'PPTX_REPAIR_ARGUMENTS_INVALID')
  if (!scope?.userId || !scope.sessionId || !scope.turnId) {
    invalid('PPTX_REPAIR_SCOPE_UNAVAILABLE', 'PPT geometry repair requires an authenticated current user, chat session and turn. Supply a full authoring call when that scope is unavailable.')
  }
  const source = validatedSource(readSource(scope, request.repair_from_tool_call_id), scope, request)
  const result = structuredClone(source)
  const seen = new Set()
  let changed = false
  for (const edit of request.edits) {
    const key = `${edit.slide_index}:${edit.element_index}`
    if (seen.has(key)) invalid('PPTX_REPAIR_ARGUMENTS_INVALID', 'Each slide/element target may occur only once in edits.')
    seen.add(key)
    const element = result.slides[edit.slide_index]?.elements?.[edit.element_index]
    if (!element) invalid('PPTX_REPAIR_TARGET_INVALID', `slides[${edit.slide_index}].elements[${edit.element_index}] is not an existing native element.`)
    for (const [name, value] of Object.entries(edit.set)) {
      changed ||= element[name] !== value
      element[name] = value
    }
  }
  if (!changed) invalid('PPTX_REPAIR_NO_CHANGE', 'The geometry edits do not change the failed input. Apply the necessary frame corrections from the preflight diagnostics.')
  validate(result, PPTX_FULL_AUTHORING_PARAMETERS, 'PPTX_REPAIR_ARGUMENTS_INVALID')
  return result
}

/** Expand only fresh/pending requests. Saved executing calls must already contain full arguments. */
export function resolvePptxRepairToolCall(call, scope, options) {
  if (call?.name !== 'create_pptx' || !Object.hasOwn(call.args || {}, 'repair_from_tool_call_id')) return call
  if (call.checkpointStatus === 'executing') {
    throw Object.assign(new Error('An executing PPT repair checkpoint lacks its resolved authoring arguments. Its output is unknown and must not be replayed.'), {
      code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true, requiresUserVerification: true,
    })
  }
  if (call.id === call.args.repair_from_tool_call_id) invalid('PPTX_REPAIR_ARGUMENTS_INVALID', 'A repair must use a fresh tool-call identity, not the failed source call ID.')
  return { ...call, args: resolvePptxRepairArguments(call.args, scope, options) }
}
