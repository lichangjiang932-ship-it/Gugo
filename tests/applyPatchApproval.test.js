import test from 'node:test'
import assert from 'node:assert/strict'

import { executeToolCall } from '../src/lib/tools/index.js'

function makeApplyPatchCall() {
  return {
    name: 'apply_patch',
    arguments: JSON.stringify({
      patch: '*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch',
    }),
  }
}

test('client tool executor delegates apply_patch without classifying risk', async () => {
  const oldFetch = globalThis.fetch
  const oldWindow = globalThis.window
  const requests = []
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    const dryRun = requests.at(-1).body.dry_run
    return new Response(JSON.stringify({ ok: true, dry_run: dryRun, changes: [{ path: 'demo.txt' }] }), { status: 200 })
  }
  try {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, '/api/tools/code/apply-patch')
    assert.deepEqual(requests.map((request) => request.body.dry_run), [true, false])
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})

test('server authorization failures are returned to the model without a client fallback', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'APPROVAL_REQUIRED', message: 'server approval required' },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  try {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, false)
    assert.match(JSON.parse(result.content).error, /server approval required/)
  } finally {
    globalThis.fetch = oldFetch
  }
})
