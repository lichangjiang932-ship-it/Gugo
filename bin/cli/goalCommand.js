import { readFileSync } from 'node:fs'
import { CliError, CliUsageError } from './errors.js'
import { resolveLocalUserId } from './localIdentity.js'

const SUBCOMMANDS = new Set(['create', 'list', 'show', 'approve', 'rewrite', 'step', 'prune'])
const STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped'])

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

function parseFlags(argv = []) {
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
    if (seen.has(key)) throw new CliUsageError('CLI_OPTION_DUPLICATE', `${key} may only be specified once`)
    seen.add(key)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options[BOOLEAN_FLAGS.get(key)] = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for goal: ${key}`)
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = value === undefined ? '' : String(value)
    if (!normalized.trim()) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} requires a value`)
    options[VALUE_FLAGS.get(key)] = normalized
  }
  return { options, positional }
}

/** `--steps` inline JSON or `--steps-file` path; both normalize to an array. */
export function resolveGoalSteps({ steps, stepsFile } = {}) {
  let raw = steps
  if (!raw && stepsFile) {
    try {
      raw = readFileSync(stepsFile, 'utf8')
    } catch (error) {
      throw new CliUsageError('CLI_GOAL_STEPS_UNREADABLE', `cannot read --steps-file: ${error?.message || error}`)
    }
  }
  if (!raw) throw new CliUsageError('CLI_GOAL_STEPS_REQUIRED', 'provide --steps <json> or --steps-file <path>')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new CliUsageError('CLI_GOAL_STEPS_INVALID', `--steps must be JSON: ${error?.message || error}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliUsageError('CLI_GOAL_STEPS_INVALID', '--steps must be a non-empty JSON array')
  }
  return parsed
}

export function parseGoalArgs(argv = []) {
  const [subcommand, ...rest] = argv
  if (!SUBCOMMANDS.has(subcommand)) {
    throw new CliUsageError('CLI_GOAL_SUBCOMMAND_UNKNOWN', `unknown goal subcommand: ${subcommand || '(none)'}`)
  }
  const { options, positional } = parseFlags(rest)
  return { subcommand, options, positional }
}

function planIdFrom(positional, index = 0) {
  const value = String(positional[index] || '').trim()
  if (!value) throw new CliUsageError('CLI_GOAL_PLAN_ID_REQUIRED', 'a plan id is required')
  return value
}

function expectedVersionOf(options) {
  if (options.expectVersion === undefined) return undefined
  const parsed = Number(options.expectVersion)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError('CLI_GOAL_VERSION_INVALID', '--expect-version must be a positive integer')
  }
  return parsed
}

async function runSubcommand({ subcommand, options, positional }, service, userId, stdout) {
  switch (subcommand) {
    case 'create': {
      const objective = String(positional[0] || options.objective || '').trim()
      if (!objective) throw new CliUsageError('CLI_GOAL_OBJECTIVE_REQUIRED', 'create requires an objective')
      const plan = service.createGoalPlan({
        userId,
        sessionId: options.sessionId || null,
        objective,
        steps: resolveGoalSteps(options),
        requireApproval: options.noApproval !== true,
      })
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      return 0
    }
    case 'list': {
      const plans = service.listGoalPlans({ userId, status: options.status || null, limit: Number(options.limit) || 50 })
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
        steps: resolveGoalSteps(options),
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
export async function cmdGoal(argv, { stdout = process.stdout } = {}) {
  const parsed = parseGoalArgs(argv)
  const service = await import('../../server/services/goalPlanService.js')
  const userId = await resolveLocalUserId()
  try {
    return await runSubcommand(parsed, service, userId, stdout)
  } catch (error) {
    if (error?.name === 'GoalPlanError') {
      throw new CliError(String(error.code || 'GOAL_PLAN_FAILED'), error.message)
    }
    throw error
  }
}
