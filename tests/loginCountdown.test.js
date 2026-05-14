import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../src/lib/loginCountdown.js'

test('formats send-code button label during countdown', () => {
  assert.equal(formatLoginCodeCountdownLabel(60), '重新发送 60s')
  assert.equal(formatLoginCodeCountdownLabel(1), '重新发送 1s')
  assert.equal(formatLoginCodeCountdownLabel(0), '发送验证码')
})

test('disables send-code button while loading, missing email, or counting down', () => {
  assert.equal(shouldDisableLoginCodeButton({ accountLoading: false, loginEmail: 'a@example.com', countdown: 0 }), false)
  assert.equal(shouldDisableLoginCodeButton({ accountLoading: true, loginEmail: 'a@example.com', countdown: 0 }), true)
  assert.equal(shouldDisableLoginCodeButton({ accountLoading: false, loginEmail: '', countdown: 0 }), true)
  assert.equal(shouldDisableLoginCodeButton({ accountLoading: false, loginEmail: 'a@example.com', countdown: 12 }), true)
})
