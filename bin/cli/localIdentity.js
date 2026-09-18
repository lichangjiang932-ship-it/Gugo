/**
 * Resolve the local runtime identity for offline (headless) CLI commands.
 *
 * The goal, memory and interactive commands all need the same thing: boot the
 * local storage layout, open the database and read the local auth session. It
 * lives here so those commands cannot drift apart in how they bind a user.
 */
import { CliError } from './errors.js'

export async function resolveLocalUserId({ cwd = process.cwd(), env = process.env } = {}) {
  const { applyRuntimeStorageBootstrap } = await import('../../server/utils/runtimeEnv.js')
  applyRuntimeStorageBootstrap({ cwd, env })
  const { getDb } = await import('../../server/db.js')
  getDb()
  const { bootstrapAuth } = await import('../../server/adapters/authAccount.js')
  const session = bootstrapAuth({ token: '', env })
  if (!session?.authenticated || !session?.user?.id) {
    throw new CliError('AUTH_REQUIRED', 'could not establish the local runtime identity')
  }
  return String(session.user.id)
}
