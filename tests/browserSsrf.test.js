import test from 'node:test'
import assert from 'node:assert/strict'

import { _browserInternals } from '../server/adapters/browserAutomation.js'

test('browser URL validation blocks link-local metadata targets before launch', async () => {
  await assert.rejects(
    () => _browserInternals.validateUrl('http://169.254.169.254/latest/meta-data/'),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
})

test('browser URL validation blocks loopback and non-http protocols', async () => {
  await assert.rejects(() => _browserInternals.validateUrl('http://127.0.0.1/admin'), /内网|loopback/)
  await assert.rejects(() => _browserInternals.validateUrl('http://[::ffff:7f00:1]/admin'), /private|loopback/)
  await assert.rejects(() => _browserInternals.validateUrl('file:///etc/passwd'), /http\/https/)
})
