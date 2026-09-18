import { CliError, CliUsageError } from './errors.js'
import { resolveLocalUserId } from './localIdentity.js'

const VALUE_FLAGS = new Map([
  ['--limit', 'limit'],
  ['--batch', 'batch'],
  ['--agent', 'agent'],
])
const BOOLEAN_FLAGS = new Set(['--all-agents'])

function parseFlags(argv = []) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    const equalAt = raw.indexOf('=')
    const key = raw.slice(0, equalAt >= 0 ? equalAt : undefined)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options.allAgents = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) {
      throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for memory reindex: ${raw}`)
    }
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = String(value ?? '').trim()
    if (!normalized) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} requires a value`)
    options[VALUE_FLAGS.get(key)] = normalized
  }
  return options
}

function positiveInt(value, fallback, code) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(code, `${value} must be a positive integer`)
  }
  return parsed
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
export async function cmdMemory(argv, { stdout = process.stdout } = {}) {
  const [subcommand, ...rest] = argv
  if (subcommand !== 'reindex') {
    throw new CliUsageError('CLI_MEMORY_SUBCOMMAND_UNKNOWN', `unknown memory subcommand: ${subcommand || '(none)'}`)
  }
  const options = parseFlags(rest)
  const userId = await resolveLocalUserId()
  const { reindexUserMemoryEmbeddings } = await import('../../server/services/memoryEmbeddingReindex.js')
  if (options.allAgents && options.agent) {
    throw new CliUsageError('CLI_MEMORY_SCOPE_CONFLICT', '--all-agents and --agent cannot be combined')
  }
  const result = await reindexUserMemoryEmbeddings({
    userId,
    // Default scope stays global-only (unchanged); `--all-agents` covers
    // agent-scoped memories too, and the report says which scope ran.
    agentId: options.allAgents ? '__all__' : (options.agent || null),
    env: process.env,
    batchSize: positiveInt(options.batch, 8, 'CLI_MEMORY_BATCH_INVALID'),
    maxTotal: positiveInt(options.limit, 200, 'CLI_MEMORY_LIMIT_INVALID'),
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
