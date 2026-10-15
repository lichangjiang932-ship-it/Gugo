import { z } from 'zod'

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u).nullable()
const count = z.number().int().nonnegative()

/** Allowlisted wire metadata only. Actual cache usage belongs to provider response usage. */
export const modelWireDiagnosticsSchema = z.object({
  version: z.literal(1), stage: z.literal('wire'),
  comparisonScope: z.literal('same_owner_endpoint_model_config'), prefixKind: z.literal('leading_instructions'),
  available: z.boolean(), truncated: z.boolean(), bodyBytes: count,
  ownerScopeFingerprint: fingerprint, endpointFingerprint: fingerprint, modelFingerprint: fingerprint, configFingerprint: fingerprint,
  bodyFingerprint: fingerprint, prefixFingerprint: fingerprint, toolsFingerprint: fingerprint,
  identityComparable: z.boolean(), prefixBlocks: count, messageCount: count, toolCount: count,
  prefixComparable: z.boolean().optional(), prefixChanged: z.boolean().nullable().optional(),
  toolsChanged: z.boolean().nullable().optional(), bodyChanged: z.boolean().nullable().optional(),
}).strict()

/** Compare already-public prepared-wire metadata; never infer a KV cache hit.
 * @param {unknown} previous
 * @param {unknown} current
 */
export function compareModelWireDiagnostics(previous, current) {
  const unknown = { prefixComparable: false, prefixChanged: null, toolsChanged: null, bodyChanged: null }
  const a = modelWireDiagnosticsSchema.safeParse(previous), b = modelWireDiagnosticsSchema.safeParse(current)
  if (!a.success || !b.success) return unknown
  const left = a.data, right = b.data
  if (!left.available || !right.available || left.truncated || right.truncated || !left.identityComparable || !right.identityComparable) return unknown
  if (!(/** @type {const} */ (['ownerScopeFingerprint', 'endpointFingerprint', 'modelFingerprint', 'configFingerprint']))
    .every(key => left[key] !== null && left[key] === right[key])) return unknown
  /** @param {'prefixFingerprint'|'toolsFingerprint'|'bodyFingerprint'} key */
  const changed = key => left[key] !== null && right[key] !== null ? left[key] !== right[key] : null
  return { prefixComparable: left.prefixFingerprint !== null && right.prefixFingerprint !== null,
    prefixChanged: changed('prefixFingerprint'), toolsChanged: changed('toolsFingerprint'), bodyChanged: changed('bodyFingerprint') }
}
