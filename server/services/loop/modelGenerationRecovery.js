import { normalizeModelUsage } from '../../../shared/modelUsage.js'
import { normalizePublicModelRequestDiagnostics } from '../../../shared/turnEventProjection.js'

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u
const FINGERPRINT = /^[a-f0-9]{64}$/u
const MAX_PARTIAL_TEXT_CHARS = 128_000

/** Diagnostic projection only. This is never evidence that a request is replayable. */
export function snapshotInterruptedModelRequest(invocation, error) {
  if (!REQUEST_ID.test(String(invocation?.id || ''))
    || !FINGERPRINT.test(String(invocation?.fingerprint || ''))
    || (error?.modelRequestId && error.modelRequestId !== invocation.id)) return null
  const previous = normalizeStoredModelRequestDiagnostics(invocation.modelRequestDiagnostics, invocation)
  const partial = snapshotPartialGeneration(error?.partialGeneration)
  const combined = partial && snapshotPartialGeneration({ ...partial,
    content: mergeGenerationText(previous?.partialGeneration?.content || '', partial.content) })
  const partialGeneration = combined || previous?.partialGeneration || null
  return normalizeStoredModelRequestDiagnostics({
    version: 1,
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    modelRequestId: invocation.id,
    fingerprint: invocation.fingerprint,
    billingUnknown: true,
    upstreamCode: error?.upstreamCode || error?.cause?.code,
    upstreamStatus: error?.upstreamStatus ?? error?.cause?.status ?? error?.cause?.statusCode,
    transportPhase: error?.transportPhase,
    timeoutPhase: error?.timeoutPhase || error?.cause?.timeoutPhase,
    timeoutMs: error?.timeoutMs ?? error?.cause?.timeoutMs,
    ...(partialGeneration ? { partialGeneration } : {}),
  }, invocation)
}

export function normalizeStoredModelRequestDiagnostics(value, invocation) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.code !== 'MODEL_REQUEST_OUTCOME_UNKNOWN' || value.billingUnknown !== true
    || value.modelRequestId !== invocation?.id || value.fingerprint !== invocation?.fingerprint) return null
  const partialGeneration = snapshotPartialGeneration(value.partialGeneration)
  const reason = normalizePublicModelRequestDiagnostics(value)
  delete reason.partialContentChars
  delete reason.contentRetained
  return { version: 1, ...reason, modelRequestId: invocation.id, fingerprint: invocation.fingerprint,
    billingUnknown: true, ...(partialGeneration ? { partialGeneration } : {}) }
}

export function publicModelRequestDiagnostics(value) {
  const partialGeneration = snapshotPartialGeneration(value?.partialGeneration)
  return normalizePublicModelRequestDiagnostics({
    ...value,
    ...(value?.version === 1 ? { partialContentChars: partialGeneration?.content.length || 0,
      contentRetained: Boolean(partialGeneration?.content) } : {}),
  })
}

/** Preserve bounded plain text separately from incomplete tool-call arguments. */
export function snapshotPartialGeneration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.content !== 'string' || value.content.length > MAX_PARTIAL_TEXT_CHARS) return null
  const usage = normalizeModelUsage(value.usage)
  return { content: value.content, ...(usage ? { usage } : {}), streamed: true }
}

export function mergeGenerationText(prefix, next) {
  if (!prefix) return next
  if (!next || prefix.startsWith(next)) return prefix
  if (next.startsWith(prefix)) return next
  for (let overlap = Math.min(prefix.length, next.length, 2048); overlap > 0; overlap -= 1) {
    if (prefix.endsWith(next.slice(0, overlap))) return prefix + next.slice(overlap)
  }
  return prefix + next
}
