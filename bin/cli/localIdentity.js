/**
 * Resolve the local runtime identity for offline (headless) CLI commands.
 *
 * The goal, memory and interactive commands all need the same thing: boot the
 * local storage layout, open the database and read the local auth session. It
 * lives here so those commands cannot drift apart in how they bind a user.
 */
import { CliError } from './errors.js'
import { assertCliRuntimeDirectory } from './runtimeSelection.js'

export async function resolveLocalRuntimeIdentity({ cwd = process.cwd(), env = process.env, quietMissingDotEnv = false } = {}) {
  assertCliRuntimeDirectory(cwd)
  const { applyRuntimeStorageBootstrap } = await import('../../server/utils/runtimeEnv.js')
  const runtimeEnv = applyRuntimeStorageBootstrap({ cwd, env, warnOnMissingDotEnv: !quietMissingDotEnv })
  const { getDb } = await import('../../server/db.js')
  getDb()
  const { bootstrapAuth } = await import('../../server/adapters/authAccount.js')
  const session = bootstrapAuth({ token: '', env: runtimeEnv })
  if (!session?.authenticated || !session?.user?.id) {
    throw new CliError('AUTH_REQUIRED', 'could not establish the local runtime identity')
  }
  return Object.freeze({ userId: String(session.user.id), runtimeEnv })
}

/** Compatibility convenience for callers that only need the bound owner. */
export async function resolveLocalUserId(options) {
  return (await resolveLocalRuntimeIdentity(options)).userId
}
