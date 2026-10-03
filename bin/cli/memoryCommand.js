import { CliError, CliUsageError } from './errors.js'
import { resolveLocalRuntimeIdentity } from './localIdentity.js'
import { commandOptionValue, commandPositiveInteger } from './commandPreflight.js'

const VALUE_FLAGS = new Map([
  ['--limit', 'limit'],
  ['--batch', 'batch'],
  ['--agent', 'agent'],
])
const BOOLEAN_FLAGS = new Set(['--all-agents'])
export const MEMORY_BOOLEAN_FLAGS = Object.freeze([...BOOLEAN_FLAGS])

function parseFlags(argv = []) {
  const options = {}
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    const equalAt = raw.indexOf('=')
    const key = raw.slice(0, equalAt >= 0 ? equalAt : undefined)
    if (seen.has(key)) throw new CliUsageError('CLI_OPTION_DUPLICATE', `${key} may only be specified once`)
    seen.add(key)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options.allAgents = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) {
      throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for memory reindex: ${raw}`)
    }
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = commandOptionValue(value, key).trim()
    options[VALUE_FLAGS.get(key)] = normalized
  }
  return options
}

export function parseMemoryArgs(argv = [], { help = false } = {}) {
  const [subcommand, ...rest] = argv
  if (!subcommand && help) return { subcommand: null, options: {} }
  if (subcommand !== 'reindex') {
    throw new CliUsageError('CLI_MEMORY_SUBCOMMAND_UNKNOWN', `unknown memory subcommand: ${subcommand || '(none)'}`)
  }
  const options = parseFlags(rest)
  if (options.allAgents && options.agent) throw new CliUsageError('CLI_MEMORY_SCOPE_CONFLICT', '--all-agents and --agent cannot be combined')
  if (options.agent === '__all__') throw new CliUsageError('CLI_MEMORY_SCOPE_INVALID', 'use --all-agents to select every Agent explicitly')
  options.batch = commandPositiveInteger(options.batch, { flag: '--batch', code: 'CLI_MEMORY_BATCH_INVALID', fallback: 8, max: 32 })
  options.limit = commandPositiveInteger(options.limit, { flag: '--limit', code: 'CLI_MEMORY_LIMIT_INVALID', fallback: 200, max: 2_000 })
  return { subcommand, options }
}

/**
 * `gugo memory reindex` — drain the memory-embedding backlog for the local user.
 *
 * No network is touched unless `MEMORY_EMBEDDINGS_ENABLED=1` and an endpoint is
 * configured; otherwise this reports the disabled code and exits non-zero so a
 * scripted run cannot mistake a no-op for a successful index.
 *
 * Scope is explicit because it used to be implicit: the default pass only sees
 * global memories, so an agent-scoped backlog was skipped while the command
 * still reported success. Use `--all-agents` for the whole user.
 */
export async function cmdMemory(argv, {
  stdout = process.stdout, cwd = process.cwd(), env = process.env,
  resolveIdentity = resolveLocalRuntimeIdentity, reindexMemory = null,
} = {}) {
  const { options } = parseMemoryArgs(argv)
  const { userId, runtimeEnv } = await resolveIdentity({ cwd, env, quietMissingDotEnv: true })
  const reindex = reindexMemory || (await import('../../server/services/memoryEmbeddingReindex.js')).reindexUserMemoryEmbeddings
  const result = await reindex({
    userId,
    // Default scope stays global-only (unchanged); `--all-agents` covers
    // agent-scoped memories too, and the report says which scope ran.
    agentId: options.allAgents ? '__all__' : (options.agent || null),
    env: runtimeEnv,
    batchSize: options.batch,
    maxTotal: options.limit,
    onProgress: ({ indexed, batches }) => {
      stdout.write(`${JSON.stringify({ event: 'progress', indexed, batches })}\n`)
    },
  })
  stdout.write(`${JSON.stringify({ event: 'done', ...result }, null, 2)}\n`)
  if (!result.ok) {
    throw new CliError(String(result.code || 'MEMORY_EMBEDDING_REINDEX_FAILED'),
      `memory reindex did not complete: ${result.code}`)
  }
  return 0
}
