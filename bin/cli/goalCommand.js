import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { CliError, CliUsageError } from './errors.js'
import { resolveLocalUserId } from './localIdentity.js'
import { assertCommandPositionals, commandOptionValue, commandPositiveInteger } from './commandPreflight.js'
import { normalizeStepAcceptance } from '../../server/services/goalPlanEvidence.js'

const SUBCOMMANDS = new Set(['create', 'list', 'show', 'approve', 'rewrite', 'step', 'prune'])
const STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped'])
const PLAN_STATUSES = new Set(['awaiting_approval', 'approved', 'completed', 'blocked', 'cancelled', 'superseded'])
const MAX_STEPS_BYTES = 1024 * 1024
const MAX_STEPS = 64
export const GOAL_COMMAND_FLAGS = Object.freeze({
  create: Object.freeze(['--steps', '--steps-file', '--objective', '--session-id', '--no-approval']),
  list: Object.freeze(['--status', '--limit', '--session-id']),
  show: Object.freeze([]), approve: Object.freeze(['--expect-version']),
  rewrite: Object.freeze(['--steps', '--steps-file', '--objective', '--no-approval', '--expect-version']),
  step: Object.freeze(['--status', '--turn', '--tool-call', '--note', '--manual-confirm', '--confirmed-by', '--expect-version']),
  prune: Object.freeze(['--keep']),
})

const VALUE_FLAGS = new Map([
  ['--steps', 'steps'],
  ['--steps-file', 'stepsFile'],
  ['--objective', 'objective'],
  ['--session-id', 'sessionId'],
  ['--status', 'status'],
  ['--limit', 'limit'],
  ['--turn', 'turn'],
  ['--tool-call', 'toolCall'],
  ['--note', 'note'],
  ['--confirmed-by', 'confirmedBy'],
  ['--expect-version', 'expectVersion'],
  ['--keep', 'keep'],
])
const BOOLEAN_FLAGS = new Map([
  ['--no-approval', 'noApproval'],
  ['--manual-confirm', 'manualConfirm'],
])
export const GOAL_BOOLEAN_FLAGS = Object.freeze([...BOOLEAN_FLAGS.keys()])

function parseFlags(argv = [], subcommand) {
  const options = { noApproval: false }
  const positional = []
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (!raw.startsWith('--')) {
      positional.push(raw)
      continue
    }
    const equalAt = raw.indexOf('=')
    const key = raw.slice(0, equalAt >= 0 ? equalAt : undefined)
    if (!GOAL_COMMAND_FLAGS[subcommand].includes(key)) {
      throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for goal ${subcommand}: ${key}`)
    }
    if (seen.has(key)) throw new CliUsageError('CLI_OPTION_DUPLICATE', `${key} may only be specified once`)
    seen.add(key)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options[BOOLEAN_FLAGS.get(key)] = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for goal: ${key}`)
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = commandOptionValue(value, key)
    options[VALUE_FLAGS.get(key)] = normalized
  }
  return { options, positional }
}

function readStepsFile(filename, cwd) {
  let descriptor
  try {
    const target = path.resolve(cwd, filename)
    const declared = lstatSync(target)
    if (!declared.isFile() || declared.isSymbolicLink()) throw new Error('regular file required')
    if (declared.size > MAX_STEPS_BYTES) throw new CliUsageError('CLI_GOAL_STEPS_TOO_LARGE', '--steps-file exceeds 1 MiB')
    // Non-blocking/no-follow where available also rejects a file swapped for a
    // FIFO or symlink between lstat and open; fstat remains authoritative.
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0))
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.dev !== declared.dev || before.ino !== declared.ino) throw new Error('file changed')
    const buffer = Buffer.alloc(MAX_STEPS_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes)
      if (!count) break
      bytes += count
    }
    if (bytes > MAX_STEPS_BYTES) throw new CliUsageError('CLI_GOAL_STEPS_TOO_LARGE', '--steps-file exceeds 1 MiB')
    const after = fstatSync(descriptor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))
  } catch (error) {
    if (error instanceof CliUsageError) throw error
    throw new CliUsageError('CLI_GOAL_STEPS_UNREADABLE', '--steps-file must be a stable, readable regular UTF-8 JSON file')
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

function assertStepsShape(steps) {
  if (steps.length > MAX_STEPS) throw new CliUsageError('GOAL_PLAN_INVALID_INPUT', `steps must not exceed ${MAX_STEPS}`)
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step) || typeof step.title !== 'string' || !step.title.trim()) {
      throw new CliUsageError('GOAL_PLAN_INVALID_INPUT', `step ${index} requires a title`)
    }
    if (step.title.trim().length > 500) throw new CliUsageError('GOAL_PLAN_INVALID_INPUT', `step ${index} title must not exceed 500 characters`)
    if (step.acceptance != null && (!Array.isArray(step.acceptance) || step.acceptance.length > 20)) {
      throw new CliUsageError('GOAL_PLAN_INVALID_INPUT', `step ${index} acceptance must be an array with at most 20 conditions`)
    }
    try { normalizeStepAcceptance(step.acceptance || []) }
    catch { throw new CliUsageError('GOAL_PLAN_INVALID_INPUT', `step ${index} contains invalid acceptance conditions`) }
  }
}

/** Explicit, bounded file reads finish before runtime configuration or identity initialization. */
export function resolveGoalSteps({ steps, stepsFile } = {}, { cwd = process.cwd() } = {}) {
  if (steps !== undefined && stepsFile !== undefined) {
    throw new CliUsageError('CLI_GOAL_STEPS_CONFLICT', '--steps and --steps-file cannot be combined')
  }
  const raw = stepsFile !== undefined ? readStepsFile(stepsFile, cwd) : steps
  if (!raw) throw new CliUsageError('CLI_GOAL_STEPS_REQUIRED', 'provide --steps <json> or --steps-file <path>')
  if (typeof raw !== 'string') throw new CliUsageError('CLI_GOAL_STEPS_INVALID', '--steps must be JSON text')
  if (Buffer.byteLength(raw, 'utf8') > MAX_STEPS_BYTES) throw new CliUsageError('CLI_GOAL_STEPS_TOO_LARGE', '--steps exceeds 1 MiB')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliUsageError('CLI_GOAL_STEPS_INVALID', '--steps must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliUsageError('CLI_GOAL_STEPS_INVALID', '--steps must be a non-empty JSON array')
  }
  assertStepsShape(parsed)
  return parsed
}

export function parseGoalArgs(argv = [], { help = false } = {}) {
  const [subcommand, ...rest] = argv
  if (!subcommand && help) return { subcommand: null, options: { noApproval: false }, positional: [] }
  if (!SUBCOMMANDS.has(subcommand)) {
    throw new CliUsageError('CLI_GOAL_SUBCOMMAND_UNKNOWN', `unknown goal subcommand: ${subcommand || '(none)'}`)
  }
  const { options, positional } = parseFlags(rest, subcommand)
  validateGoalArguments({ subcommand, options, positional }, help)
  return { subcommand, options, positional }
}

function validateGoalArguments({ subcommand, options, positional }, help) {
  assertCommandPositionals(positional, subcommand === 'step' ? 2 : subcommand === 'list' ? 0 : 1, `goal ${subcommand}`)
  if (options.steps !== undefined && options.stepsFile !== undefined) {
    throw new CliUsageError('CLI_GOAL_STEPS_CONFLICT', '--steps and --steps-file cannot be combined')
  }
  if (subcommand === 'create' && positional.length && options.objective !== undefined) {
    throw new CliUsageError('CLI_GOAL_OBJECTIVE_CONFLICT', 'provide the objective positionally or with --objective, not both')
  }
  expectedVersionOf(options)
  commandPositiveInteger(options.limit, { flag: '--limit', code: 'CLI_GOAL_LIMIT_INVALID', max: 200 })
  commandPositiveInteger(options.keep, { flag: '--keep', code: 'CLI_GOAL_KEEP_INVALID', max: 10_000 })
  if (options.status !== undefined && !(subcommand === 'step' ? STEP_STATUSES : PLAN_STATUSES).has(options.status)) {
    throw new CliUsageError(subcommand === 'step' ? 'CLI_GOAL_STEP_STATUS_REQUIRED' : 'CLI_GOAL_STATUS_INVALID', 'invalid goal status')
  }
  if (help) return
  if (subcommand === 'create' && !String(positional[0] || options.objective || '').trim()) {
    throw new CliUsageError('CLI_GOAL_OBJECTIVE_REQUIRED', 'create requires an objective')
  }
  if (['show', 'approve', 'rewrite', 'step'].includes(subcommand)) planIdFrom(positional)
  if (subcommand === 'step') {
    if (!String(positional[1] || '').trim()) throw new CliUsageError('CLI_GOAL_STEP_ID_REQUIRED', 'step requires a step id')
    if (!STEP_STATUSES.has(options.status)) throw new CliUsageError('CLI_GOAL_STEP_STATUS_REQUIRED', `--status must be one of ${[...STEP_STATUSES].join(', ')}`)
  }
  if (['create', 'rewrite'].includes(subcommand) && options.steps === undefined && options.stepsFile === undefined) {
    throw new CliUsageError('CLI_GOAL_STEPS_REQUIRED', 'provide --steps <json> or --steps-file <path>')
  }
}

function planIdFrom(positional, index = 0) {
  const value = String(positional[index] || '').trim()
  if (!value) throw new CliUsageError('CLI_GOAL_PLAN_ID_REQUIRED', 'a plan id is required')
  return value
}

function expectedVersionOf(options) {
  return commandPositiveInteger(options.expectVersion, { flag: '--expect-version', code: 'CLI_GOAL_VERSION_INVALID' })
}

async function runSubcommand({ subcommand, options, positional, steps }, service, userId, stdout) {
  switch (subcommand) {
    case 'create': {
      const objective = String(positional[0] || options.objective || '').trim()
      if (!objective) throw new CliUsageError('CLI_GOAL_OBJECTIVE_REQUIRED', 'create requires an objective')
      const plan = service.createGoalPlan({
        userId,
        sessionId: options.sessionId || null,
        objective,
        steps,
        requireApproval: options.noApproval !== true,
      })
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      return 0
    }
    case 'list': {
      const plans = service.listGoalPlans({ userId, sessionId: options.sessionId || null, status: options.status || null, limit: Number(options.limit) || 50 })
      stdout.write(`${JSON.stringify({ plans }, null, 2)}\n`)
      return 0
    }
    case 'show': {
      const plan = service.getGoalPlan({ userId, planId: planIdFrom(positional) })
      if (!plan) throw new CliError('GOAL_PLAN_NOT_FOUND', 'goal plan not found')
      stdout.write(`${JSON.stringify({ ...plan, events: service.listGoalPlanEvents({ userId, planId: plan.id }) }, null, 2)}\n`)
      return 0
    }
    case 'approve': {
      const plan = service.approveGoalPlan({
        userId, planId: planIdFrom(positional), expectedVersion: expectedVersionOf(options),
      })
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      return 0
    }
    case 'prune': {
      const result = service.pruneGoalPlanEvents({
        userId,
        planId: String(positional[0] || '').trim() || null,
        keepPerPlan: Number(options.keep) || undefined,
      })
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    case 'rewrite': {
      const plan = service.rewriteGoalPlan({
        userId,
        planId: planIdFrom(positional),
        objective: options.objective ?? null,
        steps,
        requireApproval: options.noApproval !== true,
        expectedVersion: expectedVersionOf(options),
      })
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      return 0
    }
    case 'step': {
      const planId = planIdFrom(positional, 0)
      const stepId = String(positional[1] || '').trim()
      if (!stepId) throw new CliUsageError('CLI_GOAL_STEP_ID_REQUIRED', 'step requires a step id')
      const status = String(options.status || '').trim()
      if (!STEP_STATUSES.has(status)) {
        throw new CliUsageError('CLI_GOAL_STEP_STATUS_REQUIRED', `--status must be one of ${[...STEP_STATUSES].join(', ')}`)
      }
      const evidence = options.turn
        ? {
            turnId: options.turn,
            toolCallId: options.toolCall || '',
            note: options.note || '',
            ...(options.manualConfirm === true ? { manualConfirm: true } : {}),
            ...(options.confirmedBy ? { confirmedBy: options.confirmedBy } : {}),
          }
        : null
      const plan = service.setGoalStepStatus({
        userId, planId, stepId, status, evidence, expectedVersion: expectedVersionOf(options),
      })
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      return 0
    }
    default:
      throw new CliUsageError('CLI_GOAL_SUBCOMMAND_UNKNOWN', `unknown goal subcommand: ${subcommand}`)
  }
}

/** Local (headless) goal-plan management. */
export async function cmdGoal(argv, { stdout = process.stdout, cwd = process.cwd(), inputCwd = cwd, env = process.env } = {}) {
  const parsed = parseGoalArgs(argv)
  if (['create', 'rewrite'].includes(parsed.subcommand)) parsed.steps = resolveGoalSteps(parsed.options, { cwd: inputCwd })
  const userId = await resolveLocalUserId({ cwd, env, quietMissingDotEnv: true })
  const service = await import('../../server/services/goalPlanService.js')
  try {
    return await runSubcommand(parsed, service, userId, stdout)
  } catch (error) {
    if (error?.name === 'GoalPlanError') {
      throw new CliError(String(error.code || 'GOAL_PLAN_FAILED'), error.message)
    }
    throw error
  }
}
