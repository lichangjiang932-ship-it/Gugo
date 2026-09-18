import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'yma-goal-routes-tests',
  `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
)

const { createAppServer } = await import('../server/appServer.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { createGoalPlan, getGoalPlan } = await import('../server/services/goalPlanService.js')

test('goal listing filters by the owned session before limiting and invalid versions never bypass concurrency checks', async () => {
  const { token, userId } = issueTestSession({ email: 'goal-route-scope@example.invalid' })
  for (const id of ['route-older-session', 'route-busy-session']) upsertSession({ id, userId, title: id })
  const plan = createGoalPlan({ userId, sessionId: 'route-older-session', objective: 'Older matching plan',
    now: 1, steps: [{ title: 'Fixture step' }] })
  for (let index = 0; index < 55; index += 1) createGoalPlan({ userId, sessionId: 'route-busy-session',
    objective: `Other ${index}`, now: 100 + index, steps: [{ title: 'Other fixture' }] })
  await withServer(async (baseUrl) => {
    const call = api(baseUrl, token)
    const listed = await call('GET', '/api/goals/list?sessionId=route-older-session&status=awaiting_approval&limit=1')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.plans.map((entry) => entry.id), [plan.id])
    for (const expectedVersion of [null, '', 0, -1, 1.5, 'invalid', '1', true]) {
      const response = await call('POST', '/api/goals/approve', { planId: plan.id, expectedVersion })
      assert.equal(response.status, 400, JSON.stringify(expectedVersion))
      assert.equal(getGoalPlan({ userId, planId: plan.id }).status, 'awaiting_approval')
    }
    assert.equal((await call('POST', '/api/goals/approve', { planId: plan.id, expectedVersion: plan.version })).status, 200)
  })
})

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function api(baseUrl, token) {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json = null
    try { json = await res.json() } catch { /* no body */ }
    return { status: res.status, body: json }
  }
}

function seedSuccessfulTool({ userId, sessionId, turnId, toolCallId }) {
  const base = { sessionId, turnId, userId }
  const emit = (type, payload, sequence) => appendTurnEvent({
    userId,
    event: createTurnEvent({
      ...base, id: `${turnId}-${sequence}`, sequence, type, payload, createdAt: 9_000 + sequence,
    }),
  })
  emit('turn.started', {}, 0)
  emit('tool.completed', { name: 'run_project_check', toolCallId }, 1)
  emit('turn.completed', { text: 'ok' }, 2)
}

test('goal routes require authentication', async () => {
  await withServer(async (baseUrl) => {
    const call = api(baseUrl, '')
    assert.equal((await call('GET', '/api/goals/list')).status, 401)
    assert.equal((await call('POST', '/api/goals/create', { objective: 'x', steps: [{ title: 'a' }] })).status, 401)
  })
})

test('goal routes drive the same plan the CLI and loop use', async () => {
  const { token, userId } = issueTestSession()
  upsertSession({ id: 'route-session', userId, title: 'Route' })

  await withServer(async (baseUrl) => {
    const call = api(baseUrl, token)

    const created = await call('POST', '/api/goals/create', {
      objective: 'Fix the counter',
      sessionId: 'route-session',
      steps: [{ title: 'Reproduce', acceptance: ['failing test seen'] }, { title: 'Fix' }],
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.ok, true)
    const plan = created.body.plan
    assert.equal(plan.status, 'awaiting_approval')
    assert.equal(plan.version, 1)
    assert.equal(plan.steps.length, 2)

    const listed = await call('GET', '/api/goals/list?sessionId=route-session')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.plans.map((entry) => entry.id), [plan.id])

    // An unapproved plan cannot move.
    const early = await call('POST', '/api/goals/step', {
      planId: plan.id, stepId: plan.steps[0].id, status: 'in_progress',
    })
    assert.equal(early.status, 409)
    assert.equal(early.body.code, 'GOAL_PLAN_NOT_APPROVED')

    const approved = await call('POST', '/api/goals/approve', { planId: plan.id, expectedVersion: 1 })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.plan.status, 'approved')
    assert.equal(approved.body.plan.version, 2)

    // A stale writer must fail closed instead of clobbering the approval.
    const stale = await call('POST', '/api/goals/step', {
      planId: plan.id, stepId: plan.steps[0].id, status: 'in_progress', expectedVersion: 1,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'GOAL_PLAN_VERSION_CONFLICT')
    assert.equal(stale.body.currentVersion, 2)

    // `done` without verifiable evidence is rejected by the service, not the UI.
    const bare = await call('POST', '/api/goals/step', {
      planId: plan.id, stepId: plan.steps[0].id, status: 'done',
    })
    assert.equal(bare.status, 409)
    assert.equal(bare.body.code, 'GOAL_STEP_EVIDENCE_REQUIRED')

    seedSuccessfulTool({ userId, sessionId: 'route-session', turnId: 't-route', toolCallId: 'c-route' })
    const done = await call('POST', '/api/goals/step', {
      planId: plan.id, stepId: plan.steps[0].id, status: 'done',
      evidence: { turnId: 't-route', toolCallId: 'c-route' },
    })
    assert.equal(done.status, 200)
    assert.equal(done.body.plan.steps[0].evidenceVerified, true)

    const otherStep = done.body.plan.steps[1]
    const finished = await call('POST', '/api/goals/step', {
      planId: plan.id, stepId: otherStep.id, status: 'done',
      evidence: { turnId: 't-route' },
    })
    assert.equal(finished.status, 200)
    assert.equal(finished.body.plan.status, 'completed')

    const shown = await call('GET', `/api/goals/show?planId=${plan.id}`)
    assert.equal(shown.status, 200)
    assert.ok(shown.body.events.some((event) => event.type === 'plan.completed'))

    const pruned = await call('POST', '/api/goals/prune', { planId: plan.id, keepPerPlan: 2 })
    assert.equal(pruned.status, 200)
    assert.equal(pruned.body.keepPerPlan, 2)
  })
})

test('a rewrite over HTTP creates a new revision and supersedes the old plan', async () => {
  const { token } = issueTestSession()
  await withServer(async (baseUrl) => {
    const call = api(baseUrl, token)
    const created = await call('POST', '/api/goals/create', {
      objective: 'Ship it', steps: [{ title: 'Draft' }],
    })
    const planId = created.body.plan.id
    const rewritten = await call('POST', '/api/goals/rewrite', {
      planId, steps: [{ title: 'Draft' }, { title: 'Test' }],
    })
    assert.equal(rewritten.status, 201)
    assert.equal(rewritten.body.plan.revision, 2)
    assert.equal(rewritten.body.plan.supersedesPlanId, planId)
    assert.equal((await call('GET', `/api/goals/show?planId=${planId}`)).body.plan.status, 'superseded')
  })
})

test('goal plans are not readable or writable across users', async () => {
  const owner = issueTestSession()
  const stranger = issueTestSession()
  await withServer(async (baseUrl) => {
    const ownerCall = api(baseUrl, owner.token)
    const strangerCall = api(baseUrl, stranger.token)
    const created = await ownerCall('POST', '/api/goals/create', {
      objective: 'Private', steps: [{ title: 'Secret step' }],
    })
    const planId = created.body.plan.id

    assert.equal((await strangerCall('GET', `/api/goals/show?planId=${planId}`)).status, 404)
    assert.equal((await strangerCall('POST', '/api/goals/approve', { planId })).status, 404)
    assert.equal((await strangerCall('GET', '/api/goals/list')).body.plans.length, 0)
    // The owner is unaffected.
    assert.equal((await ownerCall('GET', `/api/goals/show?planId=${planId}`)).status, 200)
  })
})

test('goal routes reject bad input and unknown subpaths', async () => {
  const { token } = issueTestSession()
  await withServer(async (baseUrl) => {
    const call = api(baseUrl, token)
    assert.equal((await call('POST', '/api/goals/create', { objective: '', steps: [{ title: 'a' }] })).status, 400)
    assert.equal((await call('POST', '/api/goals/create', { objective: 'x', steps: [] })).status, 400)
    assert.equal((await call('GET', '/api/goals/show')).status, 400)
    assert.equal((await call('POST', '/api/goals/approve', { planId: 'missing-plan' })).status, 404)
    assert.equal((await call('POST', '/api/goals/step', { planId: 'p', stepId: 's', status: 'done' })).status, 404)
    assert.equal((await call('GET', '/api/goals/does-not-exist')).status, 404)
  })
})
