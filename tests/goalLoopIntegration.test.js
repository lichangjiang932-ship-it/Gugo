import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { appendTurnEvent } from '../server/services/turnEventStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { approveGoalPlan, createGoalPlan } from '../server/services/goalPlanService.js'
import { buildGoalPlanPromptBlock, goalToolContextForTurn } from '../server/services/goalPlanPrompt.js'
import { GOAL_TOOL_NAMES, dispatchGoalTool } from '../server/utils/goalTools.js'
import { initializeGoalToolVisibility } from '../server/services/loop/runtime-initializeGoalTools.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { filterCurrentDynamicToolSpecs } from '../server/utils/toolSchemaCatalog.js'
import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-goal-loop-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'goal-loop@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
upsertSession({ id: 'loop-session', userId, title: 'Loop' })

const toolNameFromSpec = (spec) => String(spec?.function?.name || '').trim()

function seedSuccessfulTool({ turnId, toolCallId, name = 'run_project_check', sessionId = 'loop-session' }) {
  const base = { sessionId, turnId, userId }
  const emit = (type, payload, sequence) => appendTurnEvent({
    userId,
    event: createTurnEvent({
      ...base, id: `${turnId}-${sequence}`, sequence, type, payload, createdAt: 5_000 + sequence,
    }),
  })
  emit('turn.started', {}, 0)
  emit('tool.started', { name, toolCallId }, 1)
  emit('tool.completed', { name, toolCallId }, 2)
  emit('turn.completed', { text: 'ok' }, 3)
}

test('a session without a plan gets no goal tool or prompt block', () => {
  assert.deepEqual(goalToolContextForTurn({ userId, sessionId: 'no-plan-session' }), {
    active: false, planId: null, toolSpecs: [], promptBlock: null,
  })
  assert.equal(buildGoalPlanPromptBlock(null), null)
  const specs = [{ type: 'function', function: { name: 'read_file' } }]
  const s = { d: { goalToolContextForTurn, toolNameFromSpec }, activeToolSpecs: specs, job: { userId, sessionId: 'no-plan-session' } }
  initializeGoalToolVisibility(s)
  assert.deepEqual(s.activeToolSpecs.map(toolNameFromSpec), ['read_file'])
})

test('an approved plan mounts the goal tools and a frozen prompt block', async () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'loop-session',
    objective: 'Fix the counter',
    steps: [{ title: 'Reproduce', acceptance: ['failing test observed'] }, { title: 'Fix it' }],
  })
  // Awaiting approval still mounts the tools, but the block forbids work.
  const pending = goalToolContextForTurn({ userId, sessionId: 'loop-session' })
  assert.equal(pending.active, true)
  assert.equal(pending.planId, plan.id)
  assert.deepEqual(pending.toolSpecs.map(toolNameFromSpec), [...GOAL_TOOL_NAMES])
  assert.match(pending.promptBlock, /not approved yet/)

  approveGoalPlan({ userId, planId: plan.id })
  const context = goalToolContextForTurn({ userId, sessionId: 'loop-session' })
  assert.match(context.promptBlock, /Fix the counter/)
  assert.match(context.promptBlock, /Reproduce/)
  assert.match(context.promptBlock, /acceptance: failing test observed/)

  const initial = [{ type: 'function', function: { name: 'read_file' } }]
  const s = { d: { goalToolContextForTurn, toolNameFromSpec }, activeToolSpecs: [...initial], job: { userId, sessionId: 'loop-session' } }
  initializeGoalToolVisibility(s)
  assert.deepEqual(
    s.activeToolSpecs.map(toolNameFromSpec),
    ['read_file', ...GOAL_TOOL_NAMES],
    'goal tools append after the stable tool block',
  )
  // Idempotent: a second call cannot duplicate the specs.
  initializeGoalToolVisibility(s)
  assert.deepEqual(s.activeToolSpecs.map(toolNameFromSpec), ['read_file', ...GOAL_TOOL_NAMES])

  // The per-request dynamic-spec filter must not drop specs that have no
  // dynamic registration (goal specs are plain, appended lazily).
  assert.deepEqual(
    filterCurrentDynamicToolSpecs(s.activeToolSpecs, { userId }).map(toolNameFromSpec),
    ['read_file', ...GOAL_TOOL_NAMES],
  )

  // The prompt compiler injects the same block for the turn.
  const prepared = await prepareTurnPromptContext({
    userId,
    sessionId: 'loop-session',
    includeRecentTranscript: false,
    env: { AGENT_INJECT_ENABLED: '0' },
  })
  assert.equal(prepared.goalPlanId, plan.id)
  assert.ok(
    prepared.messages.some((message) => message.content.includes('Fix the counter')),
    'the plan objective reaches the model context',
  )

  // Guard: per-turn context (memory, plan) must not disturb the stable prefix,
  // or every plan update would invalidate the provider prefix cache.
  assert.ok(prepared.promptFingerprints.stableBlockCount > 0)
  const withoutPlan = await prepareTurnPromptContext({
    userId,
    sessionId: 'other-session',
    includeRecentTranscript: false,
    env: { AGENT_INJECT_ENABLED: '0' },
  })
  assert.equal(withoutPlan.goalPlanId, null)
  assert.equal(
    withoutPlan.promptFingerprints.stablePrefixFingerprint,
    prepared.promptFingerprints.stablePrefixFingerprint,
    'injecting a plan must only change the volatile tail',
  )
  assert.notEqual(
    withoutPlan.promptFingerprints.fullFingerprint,
    prepared.promptFingerprints.fullFingerprint,
  )
})

test('the loop tool surface rejects self-certified completion', async () => {
  const plan = goalToolContextForTurn({ userId, sessionId: 'loop-session' }).planId
  const { getGoalPlan } = await import('../server/services/goalPlanService.js')
  const stepId = getGoalPlan({ userId, planId: plan }).steps[0].id

  const status = await executeServerTool({
    name: 'goal_plan_status', args: {}, job: { userId, sessionId: 'loop-session', id: 't-current' },
  })
  assert.equal(status.ok, true)
  assert.equal(status.plan.id, plan)

  // No evidence at all: rejected, and the step keeps its status.
  const bare = await executeServerTool({
    name: 'goal_step_update',
    args: { plan_id: plan, step_id: stepId, status: 'done' },
    job: { userId, sessionId: 'loop-session', id: 't-current' },
  })
  assert.equal(bare.ok, false)
  assert.equal(bare.code, 'GOAL_STEP_EVIDENCE_REQUIRED')
  assert.equal(getGoalPlan({ userId, planId: plan }).steps[0].status, 'pending')

  // A fabricated tool call id is rejected against persisted events.
  seedSuccessfulTool({ turnId: 't-real', toolCallId: 'c-real' })
  const fabricated = dispatchGoalTool('goal_step_update', {
    plan_id: plan, step_id: stepId, status: 'done', turn_id: 't-real', tool_call_id: 'c-invented',
  }, { userId, sessionId: 'loop-session', turnId: 't-current' })
  assert.equal(fabricated.ok, false)
  assert.equal(fabricated.evidenceCode, 'GOAL_EVIDENCE_TOOL_CALL_NOT_FOUND')

  // The real persisted tool call succeeds, and defaults to the current turn id.
  const accepted = await executeServerTool({
    name: 'goal_step_update',
    args: { plan_id: plan, step_id: stepId, status: 'done', turn_id: 't-real', tool_call_id: 'c-real' },
    job: { userId, sessionId: 'loop-session', id: 't-current' },
  })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.step.status, 'done')
  assert.equal(accepted.step.evidenceVerified, true)
})

test('a rewrite from the loop creates an unapproved new revision', () => {
  const plan = goalToolContextForTurn({ userId, sessionId: 'loop-session' }).planId
  const result = dispatchGoalTool('goal_plan_rewrite', {
    plan_id: plan,
    steps: [{ title: 'Reproduce' }, { title: 'Fix it' }, { title: 'Add regression test' }],
  }, { userId, sessionId: 'loop-session', turnId: 't-current' })
  assert.equal(result.ok, true)
  assert.equal(result.plan.revision, 2)
  assert.equal(result.plan.status, 'awaiting_approval')
  assert.equal(result.plan.supersedesPlanId, plan)
  assert.match(String(result.message), /needs user approval/)
})

test('goal tool results carry the next actionable step', async () => {
  upsertSession({ id: 'next-session', userId, title: 'Next' })
  const created = createGoalPlan({
    userId, sessionId: 'next-session', objective: 'Ship it', steps: [{ title: 'Step one' }],
  })
  approveGoalPlan({ userId, planId: created.id })

  const status = dispatchGoalTool('goal_plan_status', {}, { userId, sessionId: 'next-session' })
  assert.equal(status.plan.id, created.id)
  assert.equal(status.openStepCount, 1)
  assert.equal(status.nextStepId, created.steps[0].id)
  assert.equal(status.completed, false)

  seedSuccessfulTool({ turnId: 't-next', toolCallId: 'c-next', sessionId: 'next-session' })
  const updated = dispatchGoalTool('goal_step_update', {
    plan_id: created.id, step_id: created.steps[0].id, status: 'done',
    turn_id: 't-next', tool_call_id: 'c-next',
  }, { userId, sessionId: 'next-session', turnId: 't-next' })
  assert.equal(updated.ok, true)
  // The last step is done, so the plan auto-completes and the tool says so
  // instead of making the model issue another read.
  assert.equal(updated.completed, true)
  assert.equal(updated.openStepCount, 0)
  assert.equal(updated.nextStepId, null)
  assert.deepEqual(updated.openSteps, [])
})
