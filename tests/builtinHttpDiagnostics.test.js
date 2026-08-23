import assert from 'node:assert/strict'
import test from 'node:test'

import { createBuiltinHttpCapabilities } from '../server/core/builtinHttpCapabilities.js'
import { issueTestSession } from './helpers/testAuth.js'

function createResponse() {
  return {
    statusCode: null,
    body: '',
    headers: new Map(),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(body = '') {
      this.body = String(body)
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value))
    },
  }
}

test('builtin diagnostics capability carries runtime host state through the production composition root', async () => {
  const auth = issueTestSession()
  const expectedRuntime = Object.freeze({
    turnHost: Object.freeze({
      ready: true,
      persistenceConfigured: true,
      compactionArchiveConfigured: true,
    }),
  })
  let reads = 0
  const definitions = createBuiltinHttpCapabilities({
    jobRuntime: {},
    readRuntimeDiagnostics() {
      reads += 1
      return expectedRuntime
    },
  })
  const diagnostics = definitions.find((entry) => entry.id === 'builtin.system.diagnostics')
  const res = createResponse()

  await diagnostics.handle({
    method: 'GET',
    url: '/api/system/diagnostics',
    headers: { authorization: `Bearer ${auth.token}` },
  }, res)

  assert.equal(reads, 1)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.runtime, expectedRuntime)
  assert.equal(JSON.stringify(body.runtime).includes('adapterId'), false)
  assert.equal(JSON.stringify(body.runtime).includes('portId'), false)
})
