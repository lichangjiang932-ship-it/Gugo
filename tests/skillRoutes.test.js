import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'

test('skill import endpoint installs and lists imported skills', async () => {
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    })
    assert.equal(importedResponse.status, 201)
    const imported = await importedResponse.json()
    assert.equal(imported.skill.id, 'writer')

    const listed = await fetch(`http://127.0.0.1:${port}/api/skills`).then((res) => res.json())
    assert.equal(listed.skills.some((skill) => skill.id === 'writer'), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

