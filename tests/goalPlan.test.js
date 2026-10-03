import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeDb, getDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { appendTurnEvent, appendTurnEventsInTransaction, listTurnEvents } from '../server/services/turnEventStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { buildGoalPlanPromptBlock } from '../server/services/goalPlanPrompt.js'
import {
  GOAL_EVIDENCE_CODES,
  normalizeStepEvidence,
  verifyStepEvidence,
} from '../server/services/goalPlanEvidence.js'
import {
  GOAL_PLAN_ERROR_CODES,
  approveGoalPlan,
  createGoalPlan,
  getGoalPlan,
  listGoalPlanEvents,
  listGoalPlans,
  pruneGoalPlanEvents,
  rewriteGoalPlan,
  setGoalStepStatus,
} from '../server/services/goalPlanService.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-goal-plan-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'goal@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
upsertSession({ id: 'goal-session', userId, title: 'Goal' })

function seedTurn({ turnId, tools = [], terminal = 'completed', sessionId = 'goal-session' }) {
  const base = { sessionId, turnId, userId }
  let sequence = 0
  const emit = (type, payload = {}) => appendTurnEvent({
    userId,
    event: createTurnEvent({ ...base, id: `${turnId}-e${sequence}`, sequence: sequence++, type, payload, createdAt: 1_000 + sequence }),
  })
  emit('turn.started')
  for (const tool of tools) {
    emit('tool.started', { name: tool.name, toolCallId: tool.toolCallId })
    emit('tool.completed', {
      name: tool.name,
      toolCallId: tool.toolCallId,
      ...(tool.args ? { args: tool.args } : {}),
      ...(tool.result ? { result: tool.result } : {}),
      ...(tool.error ? { error: tool.error } : {}),
    })
  }
  if (terminal === 'completed') emit('turn.completed', { text: 'done' })
  else if (terminal === 'failed') emit('turn.failed', { code: 'TURN_FAILED' })
}

test('step evidence is verified against persisted turn facts', () => {
  const events = [
    { turnId: 't-ok', type: 'turn.started', payload: {} },
    { turnId: 't-ok', type: 'tool.completed', payload: { name: 'read_file', toolCallId: 'c1' } },
    { turnId: 't-ok', type: 'turn.completed', payload: { text: 'ok' } },
    { turnId: 't-failed-tool', type: 'tool.completed', payload: { toolCallId: 'c2', error: { code: 'X' } } },
    { turnId: 't-failed-tool', type: 'turn.completed', payload: { text: 'partial' } },
    { turnId: 't-no-tool', type: 'turn.completed', payload: { text: 'looks good' } },
    { turnId: 't-verify', type: 'turn.completed', payload: { text: 'ok', taskVerification: { ok: true, checks: [] } } },
    { turnId: 't-failed', type: 'turn.failed', payload: { code: 'TURN_FAILED' } },
  ]
  assert.equal(normalizeStepEvidence({ toolCallId: 'c1' }), null, 'a turnId is mandatory')
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 'nope' } }).code,
    GOAL_EVIDENCE_CODES.TURN_NOT_FOUND,
  )
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 't-ok', toolCallId: 'missing' } }).code,
    GOAL_EVIDENCE_CODES.TOOL_CALL_NOT_FOUND,
  )
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 't-failed-tool', toolCallId: 'c2' } }).code,
    GOAL_EVIDENCE_CODES.TOOL_CALL_FAILED,
  )
  assert.equal(verifyStepEvidence({ events, evidence: { turnId: 't-ok', toolCallId: 'c1' } }).verified, true)
  assert.equal(verifyStepEvidence({ events, evidence: { turnId: 't-ok' } }).verified, true)
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 't-no-tool' } }).code,
    GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
    'model prose alone is not evidence: the step acceptance is not satisfied',
  )
  // A passing host verification is accepted only when the step asks for it.
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 't-verify' } }).code,
    GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
  )
  assert.equal(
    verifyStepEvidence({
      events, evidence: { turnId: 't-verify' }, acceptance: [{ kind: 'verification' }],
    }).verified,
    true,
  )
  assert.equal(
    verifyStepEvidence({ events, evidence: { turnId: 't-failed' } }).code,
    GOAL_EVIDENCE_CODES.TURN_NOT_COMPLETED,
  )
})

test('goal plan lifecycle gates step completion on verified evidence', () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Fix the counter',
    steps: [{ title: 'Reproduce', acceptance: ['failing test observed'] }, { title: 'Fix it' }],
  })
  assert.equal(plan.status, 'awaiting_approval')
  assert.equal(plan.steps.length, 2)
  assert.equal(plan.steps[0].status, 'pending')
  assert.equal(plan.steps[0].evidenceVerified, false)

  // A step cannot change before the plan is approved.
  assert.throws(
    () => setGoalStepStatus({ userId, planId: plan.id, stepId: plan.steps[0].id, status: 'done', evidence: { turnId: 'x' } }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.PLAN_NOT_APPROVED,
  )

  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id

  // done without evidence, and with unverifiable evidence, both fail closed.
  assert.throws(
    () => setGoalStepStatus({ userId, planId: plan.id, stepId, status: 'done' }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED,
  )
  seedTurn({ turnId: 't-unverified', terminal: 'failed' })
  assert.throws(
    () => setGoalStepStatus({ userId, planId: plan.id, stepId, status: 'done', evidence: { turnId: 't-unverified' } }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED
      && error.evidenceCode === GOAL_EVIDENCE_CODES.TURN_NOT_COMPLETED,
  )
  // The rejected attempt must not persist a claim.
  assert.equal(getGoalPlan({ userId, planId: plan.id }).steps[0].status, 'pending')

  // A verified tool call completes the step.
  seedTurn({ turnId: 't-good', tools: [{ name: 'run_project_check', toolCallId: 'c-good' }] })
  const afterFirst = setGoalStepStatus({
    userId, planId: plan.id, stepId, status: 'done',
    evidence: { turnId: 't-good', toolCallId: 'c-good', note: 'check passed' },
  })
  assert.equal(afterFirst.steps[0].status, 'done')
  assert.equal(afterFirst.steps[0].evidenceVerified, true)
  assert.equal(afterFirst.steps[0].evidence.toolCallId, 'c-good')
  assert.equal(afterFirst.status, 'approved', 'one open step keeps the plan active')

  // Completing the last step completes the plan.
  seedTurn({ turnId: 't-good-2', tools: [{ name: 'edit_file', toolCallId: 'c-edit' }] })
  const completed = setGoalStepStatus({
    userId, planId: plan.id, stepId: getGoalPlan({ userId, planId: plan.id }).steps[1].id,
    status: 'done', evidence: { turnId: 't-good-2', toolCallId: 'c-edit' },
  })
  assert.equal(completed.status, 'completed')

  const events = listGoalPlanEvents({ userId, planId: plan.id })
  const types = events.map((event) => event.type)
  assert.deepEqual(types, ['plan.created', 'plan.approved', 'step.status', 'step.status', 'plan.completed'])
  assert.equal(listGoalPlans({ userId }).length, 1)
})

test('goal evidence reads the terminal at sequence 2000 through the default persisted loader', () => {
  const sessionId = 'goal-long-evidence-session'
  const turnId = 'goal-long-evidence-turn'
  upsertSession({ id: sessionId, userId, title: 'Long evidence' })
  const plan = createGoalPlan({
    userId, sessionId, objective: 'Verify a long turn',
    steps: [{ title: 'Verification passed', acceptance: [{ kind: 'command', tools: ['run_test'], cwd: '/proj' }] }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const entries = Array.from({ length: 2001 }, (_, sequence) => ({
    userId,
    event: createTurnEvent({
      userId, sessionId, turnId, id: `${turnId}-${sequence}`, sequence, createdAt: 10_000 + sequence,
      type: sequence === 0 ? 'turn.started' : sequence === 2000 ? 'turn.completed'
        : sequence === 1998 ? 'tool.started' : sequence === 1999 ? 'tool.completed' : 'assistant.delta',
      payload: sequence === 0 ? {} : sequence === 2000 ? { text: 'verified' }
        : sequence === 1998 ? { name: 'run_test', toolCallId: 'long-check' }
          : sequence === 1999 ? { name: 'run_test', toolCallId: 'long-check',
            args: { cwd: '/proj' }, result: { ok: true, exitCode: 0, executionCwd: '/proj' } }
            : { text: 'progress' },
    }),
  }))
  const db = getDb()
  db.transaction(() => appendTurnEventsInTransaction(entries, db)).immediate()
  const scope = { userId, sessionId, turnId }
  assert.equal(listTurnEvents({ ...scope, after: -1, limit: 5000 }).length, 2000)
  assert.equal(listTurnEvents({ ...scope, after: 1999 }).at(-1).sequence, 2000)
  const completed = setGoalStepStatus({
    userId, planId: plan.id, stepId: plan.steps[0].id, status: 'done', evidence: { turnId },
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.steps[0].evidenceVerified, true)
})

test('a rewrite creates a new revision and supersedes the previous plan', () => {
  const original = createGoalPlan({
    userId, objective: 'Ship the feature', steps: [{ title: 'Draft design' }],
  })
  approveGoalPlan({ userId, planId: original.id })
  const rewritten = rewriteGoalPlan({
    userId,
    planId: original.id,
    steps: [{ title: 'Draft design' }, { title: 'Add regression test' }],
  })
  assert.equal(rewritten.revision, 2)
  assert.equal(rewritten.supersedesPlanId, original.id)
  assert.equal(rewritten.status, 'awaiting_approval')
  assert.equal(getGoalPlan({ userId, planId: original.id }).status, 'superseded')

  // A superseded plan cannot be rewritten or have steps changed.
  assert.throws(
    () => rewriteGoalPlan({ userId, planId: original.id, steps: [{ title: 'x' }] }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION,
  )
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: original.id, stepId: getGoalPlan({ userId, planId: original.id }).steps[0].id,
      status: 'done', evidence: { turnId: 't-good' },
    }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.PLAN_NOT_APPROVED
      || error.code === GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION,
  )

  const events = listGoalPlanEvents({ userId, planId: original.id }).map((event) => event.type)
  assert.deepEqual(events, ['plan.created', 'plan.approved', 'plan.superseded'])
  const created = listGoalPlanEvents({ userId, planId: rewritten.id }).map((event) => event.type)
  assert.deepEqual(created, ['plan.created'])
})

test('a stale expectedVersion fails closed instead of overwriting', () => {
  const plan = createGoalPlan({ userId, objective: 'Concurrency', steps: [{ title: 'A' }, { title: 'B' }] })
  approveGoalPlan({ userId, planId: plan.id })
  const fresh = getGoalPlan({ userId, planId: plan.id })
  assert.equal(fresh.status, 'approved')
  assert.equal(fresh.approvedBy, userId, 'approval is attributed to the owner')
  const staleVersion = fresh.version

  // Someone else moves the plan forward first.
  setGoalStepStatus({
    userId, planId: plan.id, stepId: fresh.steps[0].id, status: 'in_progress',
    expectedVersion: staleVersion,
  })
  const moved = getGoalPlan({ userId, planId: plan.id })
  assert.notEqual(moved.version, staleVersion)

  // The stale writer must not be able to clobber it.
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId: moved.steps[1].id, status: 'in_progress',
      expectedVersion: staleVersion,
    }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.VERSION_CONFLICT
      && error.currentVersion === moved.version,
  )
  assert.equal(getGoalPlan({ userId, planId: plan.id }).steps[1].status, 'pending')

  // The same guard covers approval and rewrites.
  const pending = createGoalPlan({ userId, objective: 'Approve race', steps: [{ title: 'A' }] })
  assert.throws(
    () => approveGoalPlan({ userId, planId: pending.id, expectedVersion: pending.version + 5 }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.VERSION_CONFLICT,
  )
  assert.equal(getGoalPlan({ userId, planId: pending.id }).status, 'awaiting_approval')
})

test('a persisted tool call can only prove one step', () => {
  const plan = createGoalPlan({
    userId, objective: 'Anti reuse', steps: [{ title: 'A' }, { title: 'B' }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const steps = getGoalPlan({ userId, planId: plan.id }).steps
  seedTurn({ turnId: 't-shared', tools: [{ name: 'run_project_check', toolCallId: 'c-shared' }] })

  setGoalStepStatus({
    userId, planId: plan.id, stepId: steps[0].id, status: 'done',
    evidence: { turnId: 't-shared', toolCallId: 'c-shared' },
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId: steps[1].id, status: 'done',
      evidence: { turnId: 't-shared', toolCallId: 'c-shared' },
    }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.EVIDENCE_ALREADY_USED,
  )
  assert.equal(getGoalPlan({ userId, planId: plan.id }).steps[1].status, 'pending')

  // Reopening the first step releases the tool call for a different step.
  setGoalStepStatus({ userId, planId: plan.id, stepId: steps[0].id, status: 'in_progress' })
  const reopened = setGoalStepStatus({
    userId, planId: plan.id, stepId: steps[1].id, status: 'done',
    evidence: { turnId: 't-shared', toolCallId: 'c-shared' },
  })
  assert.equal(reopened.steps[1].status, 'done')
})

test('a blocked step records a replanning signal', () => {
  const plan = createGoalPlan({ userId, objective: 'Blocked', steps: [{ title: 'A' }] })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id
  setGoalStepStatus({ userId, planId: plan.id, stepId, status: 'blocked' })
  const events = listGoalPlanEvents({ userId, planId: plan.id })
  const replan = events.find((event) => event.type === 'plan.replan_required')
  assert.ok(replan, 'blocked steps must emit a replanning signal')
  assert.equal(replan.payload.stepId, stepId)
  assert.equal(replan.payload.reason, 'step_blocked')
  // Repeating blocked does not spam the signal.
  setGoalStepStatus({ userId, planId: plan.id, stepId, status: 'blocked' })
  assert.equal(
    listGoalPlanEvents({ userId, planId: plan.id })
      .filter((event) => event.type === 'plan.replan_required').length,
    1,
  )
})

test('event history is bounded by an explicit prune', () => {
  const plan = createGoalPlan({ userId, objective: 'Prune', steps: [{ title: 'A' }, { title: 'B' }] })
  approveGoalPlan({ userId, planId: plan.id })
  const steps = getGoalPlan({ userId, planId: plan.id }).steps
  setGoalStepStatus({ userId, planId: plan.id, stepId: steps[0].id, status: 'in_progress' })
  setGoalStepStatus({ userId, planId: plan.id, stepId: steps[1].id, status: 'in_progress' })
  assert.ok(listGoalPlanEvents({ userId, planId: plan.id }).length >= 4)

  const pruned = pruneGoalPlanEvents({ userId, planId: plan.id, keepPerPlan: 2 })
  assert.ok(pruned.deleted > 0)
  const kept = listGoalPlanEvents({ userId, planId: plan.id })
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((event) => event.type), ['step.status', 'step.status'],
    'prune keeps the newest events')
})

test('evidence from another session cannot complete a step', () => {
  // The reported reproduction: a step about running tests in this project was
  // completed by an unrelated `read_file` success from a different session.
  upsertSession({ id: 'other-session', userId, title: 'Other' })
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Run the tests here',
    steps: [{
      title: 'Tests pass',
      acceptance: [{ kind: 'command', tools: ['run_test'], cwd: '/proj' }],
    }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id
  seedTurn({
    turnId: 't-elsewhere',
    sessionId: 'other-session',
    tools: [{ name: 'read_file', toolCallId: 'c-read', args: { path: '/proj/src/a.js' } }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-elsewhere', toolCallId: 'c-read' },
    }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED
      && error.evidenceCode === GOAL_EVIDENCE_CODES.SESSION_MISMATCH,
  )
  assert.equal(getGoalPlan({ userId, planId: plan.id }).steps[0].status, 'pending')
})

test('a successful but unrelated tool call cannot complete a step', () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Run the tests',
    steps: [{
      title: 'Tests pass',
      acceptance: [{ kind: 'command', tools: ['run_test'], cwd: '/proj' }],
    }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id

  // Right session, wrong tool: reading a file proves nothing about a test run.
  seedTurn({
    turnId: 't-wrong-tool',
    tools: [{ name: 'read_file', toolCallId: 'c-read', args: { path: '/proj/src/a.js' } }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-wrong-tool', toolCallId: 'c-read' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
  )

  // Right tool, wrong workspace.
  seedTurn({
    turnId: 't-wrong-cwd',
    tools: [{ name: 'run_test', toolCallId: 'c-elsewhere', args: { cwd: '/other' }, result: { ok: true, exitCode: 0 } }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-wrong-cwd', toolCallId: 'c-elsewhere' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
  )

  // Right tool and workspace, but the command failed.
  seedTurn({
    turnId: 't-failing',
    tools: [{ name: 'run_test', toolCallId: 'c-fail', args: { cwd: '/proj' }, result: { ok: false, exitCode: 1 } }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-failing', toolCallId: 'c-fail' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.TOOL_CALL_FAILED,
  )

  // The genuinely matching call is accepted, and says what it proved.
  seedTurn({
    turnId: 't-pass',
    tools: [{ name: 'run_test', toolCallId: 'c-pass', args: { cwd: '/proj' }, result: { ok: true, exitCode: 0 } }],
  })
  const done = setGoalStepStatus({
    userId, planId: plan.id, stepId, status: 'done',
    evidence: { turnId: 't-pass', toolCallId: 'c-pass' },
  })
  assert.equal(done.steps[0].evidenceVerified, true)
  assert.deepEqual(done.steps[0].evidence.satisfied, ['command run_test in /proj succeeding'])
})

test('file evidence is bound to the path and digest it claims', () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Write the report',
    steps: [{ title: 'Report written', acceptance: [{ kind: 'file', path: '/proj/out/report.md', sha256: 'abc123' }] }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id

  seedTurn({
    turnId: 't-other-file',
    tools: [{ name: 'write_file', toolCallId: 'c-other', result: { ok: true, path: '/proj/out/notes.md' } }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-other-file', toolCallId: 'c-other' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
  )

  // Same path, wrong bytes: a digest mismatch is not a pass.
  seedTurn({
    turnId: 't-wrong-digest',
    tools: [{
      name: 'write_file', toolCallId: 'c-digest',
      result: { ok: true, path: '/proj/out/report.md', verifiedOutputs: [{ path: '/proj/out/report.md', sha256: 'deadbeef' }] },
    }],
  })
  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-wrong-digest', toolCallId: 'c-digest' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
  )

  seedTurn({
    turnId: 't-right-digest',
    tools: [{
      name: 'write_file', toolCallId: 'c-right',
      result: { ok: true, path: '/proj/out/report.md', verifiedOutputs: [{ path: '/proj/out/report.md', sha256: 'abc123' }] },
    }],
  })
  const done = setGoalStepStatus({
    userId, planId: plan.id, stepId, status: 'done',
    evidence: { turnId: 't-right-digest', toolCallId: 'c-right' },
  })
  assert.equal(done.steps[0].evidenceVerified, true)
})

test('a manual step cannot be completed by tool success', () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Agree the wording',
    steps: [{ title: 'Wording approved', acceptance: [{ kind: 'manual' }] }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id
  seedTurn({ turnId: 't-manual', tools: [{ name: 'run_test', toolCallId: 'c-manual', result: { ok: true, exitCode: 0 } }] })

  assert.throws(
    () => setGoalStepStatus({
      userId, planId: plan.id, stepId, status: 'done',
      evidence: { turnId: 't-manual', toolCallId: 'c-manual' },
    }),
    (error) => error.evidenceCode === GOAL_EVIDENCE_CODES.MANUAL_CONFIRMATION_REQUIRED,
  )

  const done = setGoalStepStatus({
    userId, planId: plan.id, stepId, status: 'done',
    evidence: { turnId: 't-manual', manualConfirm: true, confirmedBy: 'owner' },
  })
  assert.equal(done.steps[0].evidenceVerified, true)
  assert.equal(done.steps[0].evidence.manualConfirmed, true)
})

test('skipped means "not required", and required steps cannot be skipped', () => {
  const plan = createGoalPlan({
    userId,
    sessionId: 'goal-session',
    objective: 'Mixed plan',
    steps: [
      { title: 'Optional tidy-up' },
      { title: 'Tests pass', acceptance: [{ kind: 'command', tools: ['run_test'] }] },
    ],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const steps = getGoalPlan({ userId, planId: plan.id }).steps

  // A step with machine-checkable acceptance is required work.
  assert.throws(
    () => setGoalStepStatus({ userId, planId: plan.id, stepId: steps[1].id, status: 'skipped' }),
    (error) => error.code === GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION
      && /cannot be skipped/u.test(error.message),
  )

  // A step with no declared acceptance can be skipped...
  const afterSkip = setGoalStepStatus({ userId, planId: plan.id, stepId: steps[0].id, status: 'skipped' })
  assert.equal(afterSkip.steps[0].status, 'skipped')
  // ...but the plan is not finished while a required step is still open.
  assert.equal(afterSkip.status, 'approved')

  // Finishing the required step completes the plan, and the completion event
  // records that one step was skipped rather than silently equating the two.
  seedTurn({
    turnId: 't-mixed',
    tools: [{ name: 'run_test', toolCallId: 'c-mixed', result: { ok: true, exitCode: 0 } }],
  })
  const finished = setGoalStepStatus({
    userId, planId: plan.id, stepId: steps[1].id, status: 'done',
    evidence: { turnId: 't-mixed', toolCallId: 'c-mixed' },
  })
  assert.equal(finished.status, 'completed')
  const completed = listGoalPlanEvents({ userId, planId: plan.id })
    .find((event) => event.type === 'plan.completed')
  assert.equal(completed.payload.skippedSteps, 1)
})

test('a plan of only skipped steps finishes instead of contradicting itself', () => {
  // Reported: every step skipped left the plan `approved` while the prompt said
  // nothing was left to do.
  const plan = createGoalPlan({
    userId, sessionId: 'goal-session', objective: 'All optional', steps: [{ title: 'Tidy' }],
  })
  approveGoalPlan({ userId, planId: plan.id })
  const stepId = getGoalPlan({ userId, planId: plan.id }).steps[0].id
  const after = setGoalStepStatus({ userId, planId: plan.id, stepId, status: 'skipped' })
  assert.equal(after.status, 'completed')
  const text = buildGoalPlanPromptBlock(after)
  assert.match(text, /done or skipped/u)
  assert.doesNotMatch(text, /Next actionable step/u)
})
