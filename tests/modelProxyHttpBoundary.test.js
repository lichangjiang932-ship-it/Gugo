import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import * as modelProxy from '../server/adapters/modelProxy.js'
import { createModelProxyHttpAdapter } from '../server/adapters/modelProxyHttp.js'

test('modelProxy keeps the legacy HTTP facade while its implementation lives in a one-way leaf', () => {
  for (const name of [
    'handleModelProxyRequest',
    'handleModelStatusRequest',
    'handleSystemDiagnosticsRequest',
    'modelProxyPlugin',
  ]) {
    assert.equal(typeof modelProxy[name], 'function', name)
  }
  const source = fs.readFileSync(
    new URL('../server/adapters/modelProxyHttp.js', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /from\s+['"]\.\/modelProxy\.js['"]/)
  assert.throws(
    () => createModelProxyHttpAdapter(),
    /createBackgroundModelCaller must be a function/,
  )
})
