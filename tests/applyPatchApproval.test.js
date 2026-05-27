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

function installWindow({ approve, autoApprove = false }) {
  const calls = { approval: 0 }
  globalThis.window = {
    localStorage: {
      getItem(key) {
        if (key === 'apply_patch.auto_approve' && autoApprove) return '1'
        return null
      },
      setItem: () => {},
      removeItem: () => {},
    },
    __applyPatchApproval: async (changes) => {
      calls.approval += 1
      assert.deepEqual(changes, [{
        path: 'demo.txt',
        op: 'add',
        stats: { added: 1, removed: 0 },
        preview: '+hello',
      }])
      return approve
    },
  }
  return calls
}

test('execApplyPatch performs dry-run before approved apply', async () => {
  const oldFetch = globalThis.fetch
  const oldWindow = globalThis.window
  const approvalCalls = installWindow({ approve: true })
  const requests = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/tools/code/apply-patch')
    const body = JSON.parse(init.body)
    requests.push(body)
    if (requests.length === 1) {
      assert.equal(body.dry_run, true)
      return new Response(JSON.stringify({
        ok: true,
        dry_run: true,
        total: 1,
        changes: [{ path: 'demo.txt', op: 'add', stats: { added: 1, removed: 0 }, preview: '+hello' }],
      }), { status: 200 })
    }
    assert.equal(body.dry_run, false)
    return new Response(JSON.stringify({
      ok: true,
      dry_run: false,
      total: 1,
      changes: [{ path: 'demo.txt', op: 'add', stats: { added: 1, removed: 0 } }],
    }), { status: 200 })
  }

  try {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, true)
    assert.equal(approvalCalls.approval, 1)
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map((r) => r.dry_run), [true, false])
    assert.equal(JSON.parse(result.content).dry_run, false)
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})

test('execApplyPatch returns rejected tool result without applying', async () => {
  const oldFetch = globalThis.fetch
  const oldWindow = globalThis.window
  const approvalCalls = installWindow({ approve: false })
  const requests = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/tools/code/apply-patch')
    const body = JSON.parse(init.body)
    requests.push(body)
    return new Response(JSON.stringify({
      ok: true,
      dry_run: true,
      total: 1,
      changes: [{ path: 'demo.txt', op: 'add', stats: { added: 1, removed: 0 }, preview: '+hello' }],
    }), { status: 200 })
  }

  try {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, false)
    assert.equal(approvalCalls.approval, 1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].dry_run, true)
    assert.deepEqual(JSON.parse(result.content), {
      ok: false,
      error: 'User rejected patch',
      rejected: true,
    })
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})
