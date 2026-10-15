import assert from 'node:assert/strict'
import test from 'node:test'
import { planVerificationObservation } from '../server/services/loop/verificationObservationStage.js'
import { consumeVerificationObservation } from '../server/services/loop/verificationObservationConsumer.js'
import { createLoopExecutionScope } from '../server/services/loop/executionScope.js'
const input = Object.freeze({ call: Object.freeze({ name: 'read_file', args: Object.freeze({ path: '/w/index.html' }) }), result: Object.freeze({ content: '<main>Actual file</main>', path: '/w/index.html' }), succeeded: true,
  htmlTargets: Object.freeze(['/w/index.html']), executionScope: createLoopExecutionScope({ job: {}, step: {} }) })
const ports = Object.freeze({ observe: () => ({ changed: true }), repairPrompt: () => '', normalizeTarget: value => String(value || ''), targetsMatch: (a, b) => a === b })
test('verification stage works with only its declared ports and immutable input', () => {
  const effect = planVerificationObservation(input, ports)
  assert.equal(effect.progress, true)
  assert.deepEqual(effect.htmlReads, [{ path: '/w/index.html', content: '<main>Actual file</main>' }])
  assert.ok(Object.isFrozen(effect) && Object.isFrozen(effect.htmlReads[0]))
  assert.throws(() => planVerificationObservation(input, {}), /requires/)
})
test('production consumer applies only declared effects and never records truncated reads', () => {
  const effects = []
  consumeVerificationObservation({ ...input, result: { content: 'partial', truncated: true } }, ports, {
    markProgress: () => effects.push('progress'), resetRetries: () => effects.push('reset'), appendMessage: () => effects.push('message'), retainHtml: () => effects.push('html') })
  assert.deepEqual(effects, ['progress', 'reset'])
  const failed = planVerificationObservation(input, { ...ports, observe: () => ({ failed: true }), repairPrompt: () => 'Rerun the exact check' })
  assert.equal(failed.progress, false)
  assert.deepEqual(failed.messages, [{ role: 'system', content: 'Rerun the exact check' }])
})
