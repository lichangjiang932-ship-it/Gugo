import { z } from 'zod'
const tokens = z.number().int().nonnegative().nullable()
const name = z.string().min(1).max(500).nullable()
/** Numeric observations only; never prompt bodies, tool results, credentials or reasoning. */
export const modelContextUsageSchema = z.object({
  version: z.literal(1), stage: z.enum(['prepared', 'completed', 'retained']),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u).nullable(),
  physicalAttempt: z.number().int().positive().nullable(),
  modelName: name, providerId: name, configuredModelName: name, configuredProviderId: name,
  configRevision: z.number().int().positive().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  inputEstimatedTokens: tokens, inputTokens: tokens, retainedEstimatedTokens: tokens,
}).strict()
