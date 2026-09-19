import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test, { after } from 'node:test'

import { CliUsageError } from '../../bin/cli/errors.js'
import { cmdGoal, parseGoalArgs, resolveGoalSteps } from '../../bin/cli/goalCommand.js'
import { closeDb } from '../../server/db.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-goal-cli-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function capture() {
  const chunks = []
  return {
    chunks,
    stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } }),
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

test('goal argument parsing validates subcommands and options', () => {
  assert.deepEqual(parseGoalArgs(['list']).subcommand, 'list')
  assert.equal(parseGoalArgs(['create', 'Fix it', '--steps', '[]', '--no-approval']).options.noApproval, true)
  for (const argv of [[], ['bogus'], ['show', '--bogus'], ['list', '--limit'], ['create', 'x', '--steps', '[]', '--no-approval=1']]) {
    assert.throws(() => parseGoalArgs(argv), CliUsageError, JSON.stringify(argv))
  }
  assert.deepEqual(resolveGoalSteps({ steps: '[{"title":"a"}]' }), [{ title: 'a' }])
  const file = path.join(dataDir, 'steps.json')
  fs.writeFileSync(file, JSON.stringify([{ title: 'from file' }]))
  assert.deepEqual(resolveGoalSteps({ stepsFile: file }), [{ title: 'from file' }])
  for (const input of [{}, { steps: '{}' }, { steps: '[]' }, { steps: 'nope' }, { stepsFile: path.join(dataDir, 'missing.json') }]) {
    assert.throws(() => resolveGoalSteps(input), CliUsageError, JSON.stringify(input))
  }
})

test('goal help preflight validates syntax without opening or parsing steps content', () => {
  assert.equal(parseGoalArgs([], { help: true }).subcommand, null)
  assert.equal(parseGoalArgs(['create', '--steps-file', 'must-never-be-opened'], { help: true }).subcommand, 'create')
  assert.equal(parseGoalArgs(['create', '--steps', 'not JSON'], { help: true }).options.steps, 'not JSON')
  for (const argv of [
    ['create', '--steps', '[]', '--steps-file', 'missing'],
    ['list', '--limit', '0'], ['list', 'unexpected'], ['show', '--steps', '[]'],
    ['step', '--status', 'unknown'], ['approve', '--expect-version', '9007199254740992'],
  ]) assert.throws(() => parseGoalArgs(argv, { help: true }), CliUsageError, JSON.stringify(argv))
})

test('steps input bounds and typed acceptance are validated without runtime initialization', () => {
  for (const steps of [
    [{ title: 'x'.repeat(501) }], [{ title: 'x', acceptance: Array(21).fill('note') }],
    [{ title: 'x', acceptance: [{ kind: 'file' }] }], [{ title: 'x', acceptance: { kind: 'manual' } }],
  ]) assert.throws(() => resolveGoalSteps({ steps: JSON.stringify(steps) }), { code: 'GOAL_PLAN_INVALID_INPUT' })
  assert.throws(() => resolveGoalSteps({ steps: ' '.repeat(1024 * 1024 + 1) }), { code: 'CLI_GOAL_STEPS_TOO_LARGE' })
  assert.throws(() => resolveGoalSteps({ steps: '[{"title":"x"}]', stepsFile: 'missing' }), { code: 'CLI_GOAL_STEPS_CONFLICT' })
  const steps = [{ title: 'x', acceptance: [{ kind: 'manual' }, { kind: 'file', path: 'fixture.txt' }] }]
  assert.deepEqual(resolveGoalSteps({ steps: JSON.stringify(steps) }), steps)
})

test('the goal CLI creates, approves, and gates completion on evidence', async () => {
  const create = capture()
  assert.equal(await cmdGoal(['create', 'Fix the counter', '--steps', '[{"title":"Reproduce"},{"title":"Fix"}]'], { stdout: create.stream }), 0)
  const plan = create.json()
  assert.equal(plan.status, 'awaiting_approval')
  assert.equal(plan.steps.length, 2)

  const approve = capture()
  assert.equal(await cmdGoal(['approve', plan.id], { stdout: approve.stream }), 0)
  assert.equal(approve.json().status, 'approved')

  const list = capture()
  assert.equal(await cmdGoal(['list'], { stdout: list.stream }), 0)
  assert.equal(list.json().plans[0].id, plan.id)

  // A done step without evidence must fail with the stable evidence code.
  await assert.rejects(
    cmdGoal(['step', plan.id, plan.steps[0].id, '--status', 'done'], { stdout: capture().stream }),
    (error) => error?.code === 'GOAL_STEP_EVIDENCE_REQUIRED',
  )

  const show = capture()
  assert.equal(await cmdGoal(['show', plan.id], { stdout: show.stream }), 0)
  const shown = show.json()
  assert.equal(shown.steps[0].status, 'pending', 'a rejected claim must not persist')
  assert.equal(shown.events.at(-1).type, 'plan.approved')
})
