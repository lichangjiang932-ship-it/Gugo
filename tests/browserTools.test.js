import assert from 'node:assert/strict'
import test from 'node:test'

import { registerBrowserTools } from '../server/services/browserTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'

test.afterEach(() => unregisterByOrigin('browser'))

test('browser dynamic tool catalog exposes state and console inspection', () => {
  registerBrowserTools()
  const names = new Set(
    listAllSpecs()
      .filter((entry) => entry.origin === 'browser')
      .map((entry) => entry.name),
  )

  assert.ok(names.has('browser_state'))
  assert.ok(names.has('browser_console'))
})
