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
