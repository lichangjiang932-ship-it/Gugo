import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shellTrustWarning, warnShellTrust } from '../server/utils/bashGuard.js'

test('shellTrustWarning returns a message when WORKSPACE_SHELL_ENABLED=1', () => {
  const msg = shellTrustWarning({ WORKSPACE_SHELL_ENABLED: '1' })
  assert.ok(msg, 'should return a non-empty warning when shell enabled')
  assert.match(msg, /信任|trust/i)
})

test('shellTrustWarning returns null when shell disabled', () => {
  assert.equal(shellTrustWarning({}), null)
  assert.equal(shellTrustWarning({ WORKSPACE_SHELL_ENABLED: '0' }), null)
})

test('warnShellTrust emits a warn log only when shell enabled', () => {
  const calls = []
  const logger = { warn: (...args) => calls.push(args.join(' ')) }

  warnShellTrust({ WORKSPACE_SHELL_ENABLED: '1' }, logger)
  assert.equal(calls.length, 1, 'should warn once when enabled')
  assert.match(calls[0], /WORKSPACE_SHELL_ENABLED/)

  warnShellTrust({}, logger)
  assert.equal(calls.length, 1, 'should not warn when disabled')
})
