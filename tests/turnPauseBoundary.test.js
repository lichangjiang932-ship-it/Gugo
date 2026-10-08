import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareIteration } from '../server/services/loop/runtime-prepareIteration.js'
import { getVisibleTurnClarification } from '../src/lib/chatFlowGuards.js'
import { translateKey } from '../src/i18n/translations.js'

function pauseState(reason) {
  const finishes = []
  const s = {
    // The phase destructures its dependency bag before any guard runs, so the
    // abort paths still need the bag to exist.
    d: {},
    signal: { aborted: true, reason },
    iteration: { steeringLeaseId: null },
    iter: 2,
    locale: 'zh',
    artifactIds: ['artifact-1'],
    recovery: { archiveId: null },
    artifactRecoveryActive: () => false,
    appliedSteeringIds: [],
    steeringController: { claimFresh: async () => ({ leaseId: null, messages: [] }), persistAndAcknowledge: async () => {} },
    appendSteeringMessages: () => {},
    finishTerminalResult: async (result, options) => {
      finishes.push({ result, options })
      return { ...result, terminal: true }
    },
  }
  return { s, finishes }
}

test('a pause request finishes the turn as paused and resumable, keeping the checkpoint', async () => {
  const { s, finishes } = pauseState(Object.assign(new Error('Paused by user'), { code: 'TURN_PAUSE_REQUESTED' }))
  const outcome = await prepareIteration(s)
  assert.equal(outcome.kind, 'return')
  assert.equal(finishes.length, 1)
  const { result, options } = finishes[0]
  // `paused` is what makes the turn non-terminal, so "continue" resumes from the
  // checkpoint instead of redoing the task.
  assert.equal(result.paused, true)
  assert.equal(result.clarification.reason_code, 'user_paused')
  assert.equal(result.iterations, 3, 'the paused attempt is counted')
  assert.deepEqual(result.artifactIds, ['artifact-1'], 'completed artifacts are kept')
  assert.equal(options.finalMetadata.paused, true)
})

test('a cancellation still aborts and never becomes a resumable pause', async () => {
  const { s, finishes } = pauseState(Object.assign(new Error('Cancelled by user'), { code: 'TURN_CANCEL_REQUESTED' }))
  await assert.rejects(() => prepareIteration(s), (error) => error.name === 'AbortError')
  assert.equal(finishes.length, 0, 'a cancelled turn must not be finished as paused')
})

test('an abort with no pause request keeps the previous cancellation behaviour', async () => {
  const { s, finishes } = pauseState(undefined)
  await assert.rejects(() => prepareIteration(s), (error) => error.name === 'AbortError')
  assert.equal(finishes.length, 0)
})

test('a user pause reads as "paused", not as a clarification question or a cancellation', () => {
  const zh = (key) => translateKey(key, 'zh')
  const en = (key) => translateKey(key, 'en')
  assert.equal(getVisibleTurnClarification({ reason_code: 'user_paused' }, zh), '已暂停')
  assert.equal(getVisibleTurnClarification({ reason_code: 'user_paused' }, en), 'Paused')
  // A real clarification keeps asking; the pause branch must not swallow it.
  assert.notEqual(getVisibleTurnClarification({ reason_code: 'clarification_required' }, zh), '已暂停')
  // An explicit question still wins over the reason code.
  assert.equal(getVisibleTurnClarification({ reason_code: 'user_paused', question: 'Which file?' }, zh), 'Which file?')
})

function steeringStub({ queued = [], closesAfterClaim = true } = {}) {
  const inbox = [...queued]
  const acknowledged = []
  return {
    acknowledged,
    claimFresh: async () => (inbox.length ? { leaseId: 'lease-1', messages: inbox.splice(0) } : { leaseId: null, messages: [] }),
    persistAndAcknowledge: async (leaseId) => { acknowledged.push(leaseId) },
    gateClosed: () => closesAfterClaim && inbox.length === 0,
  }
}

test('steering queued before a pause is saved with the paused checkpoint instead of holding the turn open', async () => {
  const { s, finishes } = pauseState(Object.assign(new Error('Paused by user'), { code: 'TURN_PAUSE_REQUESTED' }))
  const steering = steeringStub({ queued: [{ id: 'steer-1', content: 'Use CSV instead.' }] })
  const appended = []
  Object.assign(s, {
    appliedSteeringIds: [],
    steeringController: steering,
    appendSteeringMessages: (messages) => appended.push(...messages),
  })
  const outcome = await prepareIteration(s)
  assert.equal(outcome.kind, 'return')
  assert.deepEqual(appended.map((message) => message.content), ['Use CSV instead.'], 'the note is in the transcript the checkpoint saves')
  assert.deepEqual(steering.acknowledged, ['lease-1'])
  assert.equal(finishes.length, 1)
})

test('a pause whose steering inbox never closes stops after a bounded number of passes', async () => {
  const { s } = pauseState(Object.assign(new Error('Paused by user'), { code: 'TURN_PAUSE_REQUESTED' }))
  Object.assign(s, {
    appliedSteeringIds: [],
    steeringController: steeringStub(),
    appendSteeringMessages: () => {},
    // The completion gate keeps deferring, as it did while a message stayed unclaimed.
    finishTerminalResult: async () => null,
  })
  let passes = 0
  await assert.rejects(async () => {
    for (; passes < 50; passes += 1) {
      s.iteration = { steeringLeaseId: null }
      const outcome = await prepareIteration(s)
      assert.equal(outcome.kind, 'continue')
    }
  }, (error) => error.name === 'AbortError' && error.code === 'TURN_PAUSE_REQUESTED')
  assert.ok(passes <= 4, `stopped after ${passes} deferred passes`)
})
