import assert from 'node:assert/strict'
import test from 'node:test'

import { registerConnectorTools } from '../server/services/connectorTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'

test.afterEach(() => unregisterByOrigin('connector'))

test('connector tool catalog exposes Notion and GitHub operations', () => {
  registerConnectorTools()
  const names = new Set(listAllSpecs().filter((entry) => entry.origin === 'connector').map((entry) => entry.name))
  assert.ok(names.has('notion_search'))
  assert.ok(names.has('notion_fetch_page'))
  assert.ok(names.has('github_search_repositories'))
  assert.ok(names.has('github_get_file'))
  assert.ok(names.has('connected_app_list'))
  assert.ok(names.has('connected_app_open'))
})
