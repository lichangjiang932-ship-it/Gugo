import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-skill-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test('skill import endpoint installs and lists imported skills', async () => {
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const files = {
      'skill.json': JSON.stringify({
        id: 'writer',
        name: '写作助手',
        description: '生成长文',
        version: '1.0.0',
        icon: '✍️',
        permissions: ['内容生成'],
      }),
      'README.md': '# Writer',
      'prompts/system.md': '你是写作助手',
    }

    const importedResponse = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ files }),
    })
    assert.equal(importedResponse.status, 201)
    const imported = await importedResponse.json()
    assert.match(imported.skill.id, /^writer(?:-\d+)?$/)

    const listed = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => res.json())
    assert.equal(listed.skills.some((skill) => skill.id === imported.skill.id), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('skill routes reject unauthenticated import', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: {} }),
    })
    assert.equal(res.status, 401)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('one user cannot list another user\'s imported skills', async () => {
  const alice = issueTestSession()
  const bob = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const files = {
      'skill.json': JSON.stringify({
        id: 'private-skill',
        name: 'alice 的技能',
        description: '生成长文',
        version: '1.0.0',
        icon: '🔒',
        permissions: ['内容生成'],
      }),
      'README.md': '# Private',
      'prompts/system.md': '私有 system prompt',
    }
    const aliceImport = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ files }),
    })
    assert.equal(aliceImport.status, 201)

    const bobList = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }).then((res) => res.json())
    assert.equal(bobList.skills.some((s) => s.id === 'private-skill'), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
