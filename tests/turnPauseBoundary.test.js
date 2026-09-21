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
