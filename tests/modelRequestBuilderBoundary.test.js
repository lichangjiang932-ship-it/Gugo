import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import * as modelProxy from '../server/adapters/modelProxy.js'
import * as requestBuilder from '../server/adapters/modelRequestBuilder.js'

const builderSourceUrl = new URL('../server/adapters/modelRequestBuilder.js', import.meta.url)

test('modelProxy keeps request-builder exports as identity-preserving compatibility aliases', () => {
  for (const name of [
    'buildModelProviderRequest',
    'buildOpenAICompatibleRequest',
    'normalizeOpenAICompatibleUrl',
    'supportsStreamUsage',
  ]) {
    assert.equal(modelProxy[name], requestBuilder[name], name)
  }
})

test('model request building remains a leaf without execution, transport, or persistence dependencies', async () => {
  const source = await readFile(builderSourceUrl, 'utf8')
  for (const forbidden of [
    "from './modelProxy.js'",
    "from './modelStreamingTransport.js'",
    "from './modelFailover.js'",
    "from '../db.js'",
    "from '../services/",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})
