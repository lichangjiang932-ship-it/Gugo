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

test('anonymous callers cannot read private skill manifests or assets', async () => {
  const owner = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const baseId = `private-read-${process.pid}`
    const files = {
      'skill.json': JSON.stringify({
        id: baseId,
        name: 'Private read boundary',
        description: 'Must require its owner session.',
        version: '1.0.0',
        icon: 'lock',
        permissions: [],
      }),
      'prompts/system.md': 'private prompt content',
    }
    const importedResponse = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ files }),
    })
    assert.equal(importedResponse.status, 201)
    const imported = await importedResponse.json()
    const encodedId = encodeURIComponent(imported.skill.id)

    const ownerManifest = await fetch(`http://127.0.0.1:${port}/api/skills/${encodedId}/manifest`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(ownerManifest.status, 200)
    const ownerAsset = await fetch(`http://127.0.0.1:${port}/api/skills/${encodedId}/assets/prompts%2Fsystem.md`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(ownerAsset.status, 200)
    assert.match(ownerAsset.headers.get('cache-control') || '', /^private\b/)

    const anonymousManifest = await fetch(`http://127.0.0.1:${port}/api/skills/${encodedId}/manifest`)
    assert.equal(anonymousManifest.status, 404)
    const anonymousAsset = await fetch(`http://127.0.0.1:${port}/api/skills/${encodedId}/assets/prompts%2Fsystem.md`)
    assert.equal(anonymousAsset.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('different users importing the same skill id receive globally unique ids', async () => {
  const alice = issueTestSession()
  const bob = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const baseId = `shared-id-${process.pid}`
    const files = {
      'skill.json': JSON.stringify({
        id: baseId,
        name: 'Global id collision fixture',
        description: 'Both users import this package.',
        version: '1.0.0',
        icon: 'copy',
        permissions: [],
      }),
      'prompts/system.md': 'collision-safe prompt',
    }
    const importFor = async (token) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ files }),
      })
      assert.equal(response.status, 201)
      return response.json()
    }

    const aliceImport = await importFor(alice.token)
    const bobImport = await importFor(bob.token)
    assert.equal(aliceImport.skill.id, baseId)
    assert.equal(bobImport.skill.id, `${baseId}-2`)

    const aliceList = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    }).then((response) => response.json())
    const bobList = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }).then((response) => response.json())
    assert.equal(aliceList.skills.some((skill) => skill.id === baseId), true)
    assert.equal(aliceList.skills.some((skill) => skill.id === `${baseId}-2`), false)
    assert.equal(bobList.skills.some((skill) => skill.id === baseId), false)
    assert.equal(bobList.skills.some((skill) => skill.id === `${baseId}-2`), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('imported skills cannot shadow a built-in runtime skill id', async () => {
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        files: {
          'skill.json': JSON.stringify({
            id: 'ppt',
            name: 'Shadow attempt',
            description: 'Must not replace the built-in PPT skill.',
            version: '1.0.0',
            icon: 'P',
            permissions: [],
          }),
          'prompts/system.md': 'Do not shadow the built-in skill.',
        },
      }),
    })
    assert.equal(response.status, 201)
    const imported = await response.json()
    assert.match(imported.skill.id, /^ppt-\d+$/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
