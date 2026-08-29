import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchToolPermissions, setToolPermission, GATEABLE_TOOLS } from '../src/lib/toolPermissionClient.js'

test('GATEABLE_TOOLS lists the real backend tools', () => {
  const ids = GATEABLE_TOOLS.map((t) => t.id)
  assert.ok(ids.includes('bash_exec'))
  assert.ok(ids.includes('run_code'))
  assert.ok(ids.includes('write_file'))
  assert.ok(ids.includes('edit_file'))
})

test('fetchToolPermissions returns the permissions map', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/tool-permissions')
    return { ok: true, json: async () => ({ ok: true, permissions: { bash_exec: false } }) }
  }
  const perms = await fetchToolPermissions({ fetchImpl })
  assert.equal(perms.bash_exec, false)
})

test('setToolPermission POSTs toolName/enabled and returns updated map', async () => {
  let captured = null
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return { ok: true, json: async () => ({ ok: true, permissions: { write_file: false } }) }
  }
  const perms = await setToolPermission('write_file', false, { fetchImpl })
  assert.equal(captured.url, '/api/tool-permissions')
  assert.equal(captured.init.method, 'POST')
  assert.deepEqual(JSON.parse(captured.init.body), { toolName: 'write_file', enabled: false })
  assert.equal(perms.write_file, false)
})

test('client throws on error response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'nope' }) })
  await assert.rejects(() => fetchToolPermissions({ fetchImpl }), /nope/)
})
