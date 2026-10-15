import { z } from 'zod'
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u).nullable()
/** Actual physical route only. No endpoint URLs, keys, headers or prompt contents. */
export const modelRequestSourceSchema = z.object({
  version: z.literal(1), providerId: z.string().min(1).max(200).nullable(),
  endpointFingerprint: fingerprint, configFingerprint: fingerprint,
}).strict()
