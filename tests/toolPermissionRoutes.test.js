import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-toolperm-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('tool-permissions route requires auth', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tool-permissions`)
    assert.equal(res.status, 401)
  })
})

test('tool-permissions GET returns empty overrides by default, POST persists', async () => {
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  await withServer(async (port) => {
    const initial = await (await fetch(`http://127.0.0.1:${port}/api/tool-permissions`, { headers })).json()
    assert.deepEqual(initial.permissions, {})
    assert.ok(initial.gateable.includes('bash_exec'))

    const post = await fetch(`http://127.0.0.1:${port}/api/tool-permissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ toolName: 'bash_exec', enabled: false }),
    })
    assert.equal(post.status, 200)
    const body = await post.json()
    assert.equal(body.permissions.bash_exec, false)
  })
})

test('tool-permissions POST rejects non-gateable tool names', async () => {
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tool-permissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ toolName: 'definitely_not_a_tool', enabled: false }),
    })
    assert.equal(res.status, 400)
  })
})
