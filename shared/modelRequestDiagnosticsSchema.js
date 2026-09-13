// @ts-check
import { z } from 'zod'

/** Public error evidence; no private response snapshot or recovery authority. */
export const modelRequestDiagnosticsSchema = z.object({
  code: z.literal('MODEL_REQUEST_OUTCOME_UNKNOWN'),
  upstreamCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  transportPhase: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u).optional(),
  timeoutPhase: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u).optional(),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  partialContentChars: z.number().int().min(0).max(128_000),
  contentRetained: z.boolean(),
}).strict()
