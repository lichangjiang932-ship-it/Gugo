import { z } from 'zod'
const outcome = z.enum(['hit', 'miss', 'not_observed'])
export const promptCompilerDiagnosticsSchema = z.object({ version: z.literal(1),
  source: z.enum(['turn_preparation', 'turn_reuse', 'checkpoint_reuse']),
  blocks: z.object({ identity: outcome, ishiki: outcome, skills: outcome, sessions: outcome }).strict(),
}).strict()
/** @param {'turn_preparation'|'turn_reuse'|'checkpoint_reuse'} source
 * @returns {import('zod').infer<typeof promptCompilerDiagnosticsSchema>}
 */
export function compilerReuse(source) {
  return { version: 1, source, blocks: { identity: 'not_observed', ishiki: 'not_observed', skills: 'not_observed', sessions: 'not_observed' } }
}
