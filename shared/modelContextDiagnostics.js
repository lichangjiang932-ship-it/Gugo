// @ts-check
import { z } from 'zod'

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u)
const memoryDiagnostics = z.object({
  failed: z.boolean(), touchFailed: z.boolean(), linkedCount: z.number().int().nonnegative(),
  semantic: z.object({
    code: z.string().max(96).nullable(), coverage: z.string().max(32).nullable(),
    truncated: z.boolean(), scanned: z.number().int().nonnegative(),
    candidateTruncated: z.boolean().optional(),
  }).strict().optional(),
  lexical: z.object({
    code: z.string().max(96).nullable(), coverage: z.string().max(32).nullable(),
    truncated: z.boolean(), scanned: z.number().int().nonnegative(), candidateTruncated: z.boolean().optional(),
    index: z.object({ complete: z.boolean(), coverage: z.string().max(32).nullable(), code: z.string().max(96).nullable() }).strict().optional(),
  }).strict().optional(),
  embedding: z.object({ status: z.enum(['ready', 'disabled', 'skipped', 'degraded']), code: z.string().max(96),
    space: z.string().regex(/^memspace:v\d+:[a-f0-9]{32}$/u).optional(), dimensions: z.number().int().positive().optional() }).strict().optional(),
}).strict()

/** Bounded observations only: never raw prompts, tool arguments, credentials or reasoning. */
export const modelContextDiagnosticsSchema = z.object({
  version: z.literal(1), stage: z.literal('pre_compaction'),
  comparisonScope: z.literal('within_turn'),
  stablePrefixFingerprint: fingerprint.nullable(), contextFingerprint: fingerprint,
  toolsFingerprint: fingerprint, stableBlockCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(), toolCount: z.number().int().nonnegative(),
  prefixComparable: z.boolean(), stablePrefixChanged: z.boolean().nullable(), toolsChanged: z.boolean().nullable(),
  memory: memoryDiagnostics.optional(),
}).strict()
