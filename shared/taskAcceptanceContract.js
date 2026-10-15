// @ts-check
import { z } from 'zod'
const text = z.string().trim().min(1).max(1000)
const command = z.object({ kind: z.literal('command'), command: text, cwd: text, tools: z.array(text).max(16).optional() }).strict()
const file = z.object({ kind: z.literal('file'), path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/iu) }).strict()
const artifact = z.object({ kind: z.literal('artifact'), artifactId: text, type: text.optional() }).strict()
const manual = z.object({ kind: z.literal('manual') }).strict()
const verification = z.object({ kind: z.literal('verification'), checkKind: z.enum(['test', 'lint', 'build', 'check', 'typecheck']), cwd: text }).strict()
/** Explicit versioned acceptance. Notes and arbitrary successful tools cannot satisfy it. */
export const taskAcceptanceContractSchema = z.object({ kind: z.literal('contract'), version: z.literal(1),
  checks: z.array(z.discriminatedUnion('kind', [command, file, artifact, manual, verification])).min(1).max(16),
}).strict()

/** @param {unknown} value */
export function parseTaskAcceptanceContract(value) {
  return taskAcceptanceContractSchema.parse(value)
}
