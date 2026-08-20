import assert from 'node:assert/strict'
import test from 'node:test'

import { isLoopbackAddress } from '../server/utils/loopbackRequest.js'

test('loopback address recognition accepts IPv4, IPv6, and mapped IPv4 only', () => {
  for (const address of ['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
  for (const address of ['', 'localhost', '192.0.2.10', '::ffff:192.0.2.10', '2001:db8::1']) {
    assert.equal(isLoopbackAddress(address), false, address)
  }
})
