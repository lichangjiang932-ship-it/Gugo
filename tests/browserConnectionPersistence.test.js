import assert from 'node:assert/strict'
import test from 'node:test'
import { _browserInternals } from '../server/adapters/browserAutomation.js'

test('Browser sessions are reused only while the process and CDP socket remain alive', () => {
  const session = {
    child: { exitCode: null },
    client: { isOpen: () => true },
    headless: false,
  }
  assert.equal(_browserInternals.isReusableSession(session), true)
  assert.equal(_browserInternals.isReusableSession(session, { headed: true }), true)
  assert.equal(_browserInternals.isReusableSession({ ...session, client: { isOpen: () => false } }), false)
  assert.equal(_browserInternals.isReusableSession({ ...session, child: { exitCode: 0 } }), false)
  assert.equal(_browserInternals.isReusableSession({ ...session, headless: true }, { headed: true }), false)
})
