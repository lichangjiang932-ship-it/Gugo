import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { appendTurnEvent } from '../server/services/turnEventStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { createGoalPlan, getGoalPlan, setGoalStepStatus } from '../server/services/goalPlanService.js'
import { normalizeStepAcceptance, verifyStepEvidence } from '../server/services/goalPlanEvidence.js'
import { buildGoalPlanPromptBlock } from '../server/services/goalPlanPrompt.js'
import { dispatchGoalTool, findActiveGoalPlan } from '../server/utils/goalTools.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { isSubstantiveToolCall } from '../server/utils/toolLoopGuard.js'
import { installToolFailureRecovery } from '../server/services/loop/toolFailureRecovery.js'

after(() => closeDb())
const issued = issueEmailCode({ email: 'goal-authority@example.invalid' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
for (const id of ['authority-session', 'foreign-session', 'older-session']) {
  upsertSession({ id, userId, title: id })
}

function makePlan(sessionId, acceptance = []) {
  return createGoalPlan({ userId, sessionId, objective: 'Verified objective', requireApproval: false,
    steps: [{ title: 'Required step', acceptance }] })
}

function seedTerminal(turnId) {
  for (const [sequence, type] of ['turn.started', 'turn.completed'].entries()) {
    appendTurnEvent({ userId, event: createTurnEvent({ userId, sessionId: 'authority-session',
      turnId, id: `${turnId}-${sequence}`, sequence, type,
      payload: type === 'turn.completed' ? { text: 'Ready for human review' } : {} }) })
  }
}

test('model goal dispatch cannot manufacture a human confirmation', async () => {
  const plan = makePlan('authority-session', [{ kind: 'manual' }])
  seedTerminal('authority-manual-turn')
  const result = await executeServerTool({ name: 'goal_step_update', job: {
    userId, sessionId: 'authority-session', id: 'authority-manual-turn',
  }, args: { plan_id: plan.id, step_id: plan.steps[0].id, status: 'done',
    turn_id: 'authority-manual-turn', manual_confirm: true, confirmed_by: userId } })
  assert.equal(result.ok, false)
  assert.equal(getGoalPlan({ userId, planId: plan.id }).steps[0].status, 'pending')
  const human = setGoalStepStatus({ userId, planId: plan.id, stepId: plan.steps[0].id, status: 'done',
    evidence: { turnId: 'authority-manual-turn', manualConfirm: true, confirmedBy: userId } })
  assert.equal(human.steps[0].status, 'done', 'trusted human service entry stays available')
})

test('model plan writes require their current session and reject stale versions', () => {
  const foreign = makePlan('foreign-session')
  const rejected = dispatchGoalTool('goal_step_update', {
    plan_id: foreign.id, step_id: foreign.steps[0].id, status: 'blocked',
  }, { userId, sessionId: 'authority-session' })
  assert.equal(rejected.ok, false)
  assert.equal(getGoalPlan({ userId, planId: foreign.id }).steps[0].status, 'pending')
  const current = makePlan('authority-session')
  const stale = dispatchGoalTool('goal_step_update', {
    plan_id: current.id, step_id: current.steps[0].id, status: 'blocked', expected_version: current.version + 1,
  }, { userId, sessionId: 'authority-session' })
  assert.equal(stale.code, 'GOAL_PLAN_VERSION_CONFLICT')
})

test('session lookup does not lose an older plan behind another sessions recent plans', () => {
  const older = makePlan('older-session')
  for (let index = 0; index < 55; index += 1) makePlan('foreign-session')
  assert.equal(findActiveGoalPlan({ userId, sessionId: 'older-session' })?.id, older.id)
})

function checkEvidence(acceptance, { name = 'bash_exec', result = {}, args = {}, verification } = {}) {
  return verifyStepEvidence({ sessionId: 'authority-session', acceptance,
    evidence: { turnId: 'predicate-turn', ...(verification === undefined ? { toolCallId: 'predicate-tool' } : {}) },
    events: [
      { type: 'tool.started', turnId: 'predicate-turn', sessionId: 'authority-session',
        payload: { name, toolCallId: 'predicate-tool', args } },
      { type: 'tool.completed', turnId: 'predicate-turn', sessionId: 'authority-session',
        payload: { name, toolCallId: 'predicate-tool', args, result } },
      { type: 'turn.completed', turnId: 'predicate-turn', sessionId: 'authority-session',
        payload: { text: 'done', ...(verification === undefined ? {} : { taskVerification: verification }) } },
    ] })
}

test('command evidence needs the expected command, directory, and a final successful exit', () => {
  const acceptance = [{ kind: 'command', command: 'npm test', cwd: '/project' }]
  assert.equal(checkEvidence(acceptance, { args: { command: 'echo ok', cwd: '/project' }, result: { exitCode: 0 } }).verified, false)
  assert.equal(checkEvidence(acceptance, { args: { command: 'npm test' }, result: { exitCode: 0 } }).verified, false)
  assert.equal(checkEvidence(acceptance, { args: { command: 'npm test', cwd: '/project' }, result: { ok: true, pid: 123 } }).verified, false)
  assert.equal(checkEvidence(acceptance, { args: { command: 'npm test', cwd: '/project' }, result: { exitCode: 0 } }).verified, true)
})

test('file evidence binds path and digest to the same actual output', () => {
  const expected = 'a'.repeat(64)
  const acceptance = [{ kind: 'file', path: '/project/report.md', sha256: expected }]
  assert.equal(checkEvidence(acceptance, { name: 'write_file', result: { ok: true, verifiedOutputs: [
    { path: '/project/report.md', sha256: 'b'.repeat(64) }, { path: '/project/other.md', sha256: expected },
  ] } }).verified, false)
  assert.equal(checkEvidence(acceptance, { name: 'read_file', result: { ok: true, path: '/project/report.md', sha256: expected } }).verified, false)
  assert.equal(checkEvidence(acceptance, { name: 'write_file', result: { ok: true, path: '/project/report.md', sha256: expected } }).verified, true)
})

test('empty or failed task verification does not satisfy verification acceptance', () => {
  const acceptance = [{ kind: 'verification' }]
  assert.equal(checkEvidence(acceptance, { verification: {} }).verified, false)
  assert.equal(checkEvidence(acceptance, { verification: { ok: true, checks: [{ status: 'failed' }] } }).verified, false)
  assert.equal(checkEvidence(acceptance, { verification: { ok: true, checks: [{ status: 'passed' }] } }).verified, true)
})

test('unknown typed acceptance is rejected instead of weakening to any successful tool', () => {
  assert.throws(() => normalizeStepAcceptance([{ kind: 'commnad', command: 'npm test' }]))
  assert.throws(() => normalizeStepAcceptance([{ kind: 'file' }]))
})

test('typed acceptance stays legible and blocked work requests a decision', () => {
  const text = buildGoalPlanPromptBlock({ id: 'plan', objective: 'Fix tests', status: 'approved', revision: 1,
    steps: [{ id: 'step', ordinal: 0, title: 'Tests', status: 'blocked',
      acceptance: [{ kind: 'command', command: 'npm test', cwd: '/project' }] }] })
  assert.ok(!text.includes('[object Object]'))
  assert.match(text, /npm test/)
  assert.ok(!text.includes('Next actionable step: 0. Tests'))
  assert.match(text, /blocked|replan/i)
})

test('goal bookkeeping cannot certify work or reset a real failure sequence', () => {
  assert.equal(checkEvidence([{ kind: 'tool' }], { name: 'goal_plan_status', result: { ok: true } }).verified, false)
  const restore = () => ({ tool: null, count: 0, reflected: false, attempts: [] })
  const state = { d: {
    FAILURE_RECOVERY_MARKER: '[recovery]', FAILURE_RECOVERY_THRESHOLD: 2,
    isCommandExecutionTool: () => true, isSubstantiveToolCall,
    isSuccessfulToolResult: (result) => result.ok === true,
    restoreFailureRecovery: restore, shouldReflectOnFailure: (result) => result.ok === false,
    toolNameFromSpec: () => '',
  }, failureRecovery: restore(), activeToolSpecs: [], convo: [] }
  const iteration = {}
  installToolFailureRecovery(state, iteration)
  iteration.observeFailureRecovery({ name: 'bash_exec' }, { ok: false, code: 'CHECK_FAILED' })
  iteration.observeFailureRecovery({ name: 'goal_plan_status' }, { ok: true })
  assert.equal(state.failureRecovery.count, 1)
  iteration.observeFailureRecovery({ name: 'bash_exec' }, { ok: false, code: 'CHECK_FAILED' })
  assert.equal(state.failureRecovery.count, 2)
  assert.equal(state.pendingFailureRecoveryPrompt, true)
})
