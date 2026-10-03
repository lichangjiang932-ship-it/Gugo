// @ts-check
import { z } from 'zod'
import { modelRequestDiagnosticsSchema } from './modelRequestDiagnosticsSchema.js'

export const toolFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  status: z.number().int().min(100).max(599).optional(),
  retryable: z.boolean(),
  hint: z.string().optional(),
  attempts: z.number().int().positive().optional(),
}).strict()
export const terminalReasonSchema = z.string().min(1).max(2_000)
export const terminalNextActionSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]{0,79}$/u)
const taskVerificationCheckSchema = z.object({
  status: z.enum(['failed', 'indeterminate', 'rerun_required', 'stale']),
  kind: z.enum(['test', 'lint', 'build', 'check', 'typecheck']),
  cwd: z.string().min(1).max(1_000),
  commandScope: z.string().max(1_000),
  coverage: z.enum(['cwd', 'targeted']),
  code: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u),
  failures: z.number().int().min(0).max(5),
  requiredEpoch: z.number().int().nonnegative(),
  mutationTargets: z.array(z.string().min(1).max(2_000)).max(16).optional(),
  diagnostic: z.string().min(1).max(1_200).optional(),
}).strict()
export const taskVerificationSchema = z.object({
  version: z.literal(1),
  maxFailures: z.number().int().min(1).max(5),
  consecutiveFailures: z.number().int().min(0).max(5),
  checks: z.array(taskVerificationCheckSchema).min(1).max(64),
}).strict()

/**
 * Read-only completion-policy diagnostic. It reports the policy id, how many
 * attempts a turn used and whether the policy was exhausted. It never carries
 * control authority and is bounded so a terminal event stays small.
 */
const completionPolicyEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/u),
  attempts: z.number().int().nonnegative().max(1_000_000),
  limit: z.number().int().positive().max(1_000_000).nullable(),
  exhausted: z.boolean(),
}).strict()
export const completionPoliciesSchema = z.array(completionPolicyEntrySchema).max(16).optional()
export const turnFailureSchema = toolFailureSchema.extend({
  // New terminal projections are code-only. `message` and `hint` remain
  // optional solely so clients can replay events written by older runtimes.
  message: z.string().min(1).optional(),
  hint: z.string().optional(),
  reason: terminalReasonSchema.optional(),
  nextAction: terminalNextActionSchema.optional(),
  manualRetryable: z.boolean().optional(),
  incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
  missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
  taskVerification: taskVerificationSchema.optional(),
  modelRequestDiagnostics: modelRequestDiagnosticsSchema.optional(),
  persistence: z.object({
    failedEventCount: z.number().int().nonnegative(),
    blockedEventCount: z.number().int().nonnegative(),
    failedEventTypes: z.array(z.string().min(1)).max(32),
    firstFailedSequence: z.number().int().nonnegative().optional(),
    lastFailedSequence: z.number().int().nonnegative().optional(),
    failedAt: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict()
