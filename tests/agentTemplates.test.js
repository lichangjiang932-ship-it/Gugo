/**
 * A3 Yuan/persona template coverage.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-agent-template-tests-'))

const { createAppServer } = await import('../server/appServer.js')

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET /api/agent-templates returns built-in templates', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent-templates`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.templates.map((tpl) => tpl.id), ['hanako', 'butter', 'ming', 'kong'])
  })
})

test('GET /api/agent-templates/:id returns localized five-section detail', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent-templates/hanako?lang=en`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.template.id, 'hanako')
    assert.equal(body.template.lang, 'en')
    assert.deepEqual(
      body.template.sections.map((section) => section.title),
      ['MOOD', 'Vibe', 'Sparks', 'Reflections', 'Will'],
    )
    assert.match(body.template.systemPrompt, /## MOOD/)
  })
})

test('legacy and regional template locales follow the global English fallback rule', async () => {
  await withServer(async (base) => {
    for (const locale of ['en-US', 'ja', 'ko', 'zh-TW']) {
      const res = await fetch(`${base}/api/agent-templates/hanako?lang=${encodeURIComponent(locale)}`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.template.lang, 'en', locale)
      assert.equal(body.template.sections[0].title, 'MOOD', locale)
    }

    const res = await fetch(`${base}/api/agent-templates/hanako?lang=zh-CN`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.template.lang, 'zh')
    assert.equal(body.template.label, '温柔学姐型')
    assert.match(body.template.systemPrompt, /思考与心境/)
  })
})

test('GET /api/agent-templates/:id returns 404 for unknown template', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent-templates/unknown`)
    assert.equal(res.status, 404)
  })
})

test('agent with persona template injects MOOD into system block', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-yuan-'))
  process.env.APP_DATA_DIR = dir
  const suffix = `${Date.now()}_${Math.random()}`
  const auth = await import(`../server/adapters/authAccount.js?yuan=${suffix}`)
  const ag = await import(`../server/services/agentStore.js?yuan=${suffix}`)

  const issued = auth.issueEmailCode({ email: 'yuan@example.com' })
  const userId = auth.verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  const agent = ag.createAgent({ userId, name: 'Hanako Agent', personaTemplate: 'hanako' })
  const block = ag.buildAgentSystemBlock(agent)

  assert.match(block, /^# Agent: Hanako Agent/)
  assert.match(block, /## PERSONA TEMPLATE/)
  assert.match(block, /## MOOD/)
  assert.match(block, /## Vibe/)
  assert.match(block, /Stay in character/)
})
