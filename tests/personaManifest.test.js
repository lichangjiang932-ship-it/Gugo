import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-persona-manifest-'))

const { DB_SCHEMA_VERSION, getDb } = await import('../server/db.js')
const agentStore = await import('../server/services/agentStore.js')
const { buildIdentityBlock } = await import('../server/services/promptCompiler.js')
const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const authHeaders = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra })

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

test('schema v25 adds persona_manifest_json', () => {
  const columns = getDb().prepare('PRAGMA table_info(agents)').all().map((row) => row.name)
  assert.ok(DB_SCHEMA_VERSION >= 25)
  assert.ok(columns.includes('persona_manifest_json'))
})

test('persona manifest normalizes, persists, and round-trips markdown', () => {
  const { userId } = issueTestSession()
  const created = agentStore.createAgent({
    userId,
    name: `Manifest ${Date.now()}`,
    personaManifest: {
      version: 1,
      capabilityIds: ['research', 'documents', 'research'],
      recommendedConnectorIds: ['github', 'notion'],
      defaultPermissionMode: 'plan',
    },
  })
  assert.deepEqual(created.personaManifest, {
    version: 1,
    capabilityIds: ['research', 'documents'],
    recommendedConnectorIds: ['github', 'notion'],
    defaultPermissionMode: 'plan',
  })

  const updated = agentStore.updateAgent({
    userId,
    id: created.id,
    patch: { personaManifest: { capabilityIds: ['coding'], defaultPermissionMode: 'acceptEdits' } },
  })
  assert.deepEqual(updated.personaManifest.capabilityIds, ['coding'])
  const parsed = agentStore.parseAgentMarkdown(agentStore.serializeAgentMarkdown(updated))
  assert.deepEqual(parsed.personaManifest, updated.personaManifest)
})

test('persona manifest rejects malformed values and prompt rendering fails closed', () => {
  assert.throws(() => agentStore.normalizePersonaManifest({ defaultPermissionMode: 'root' }), /defaultPermissionMode/)
  assert.throws(() => agentStore.normalizePersonaManifest({ capabilityIds: ['shell && erase'] }), /invalid id/)
  assert.throws(() => agentStore.normalizePersonaManifest({ capabilityIds: 'research' }), /array/)
  assert.throws(() => agentStore.normalizePersonaManifest({ version: 2 }), /version/)
  assert.throws(() => agentStore.normalizePersonaManifest({
    capabilityIds: Array.from({ length: 33 }, (_, i) => `cap-${i}`),
  }), /exceeds/)
  assert.equal(agentStore.buildPersonaManifestBlock({ capabilityIds: ['bad id'] }), '')
})

test('prompt compiler injects declarations as recommendations without changing permission state', () => {
  const result = buildIdentityBlock({
    agent: {
      id: 'agt_manifest_prompt',
      name: 'Researcher',
      personaManifest: {
        capabilityIds: ['research'],
        recommendedConnectorIds: ['github'],
        defaultPermissionMode: 'plan',
      },
    },
  })
  assert.match(result.text, /Declared capabilities: research/)
  assert.match(result.text, /Recommended connectors: github/)
  assert.match(result.text, /recommendation only; never override/)
})

test('agent API and v0.3 zip preserve persona manifest', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const manifest = {
      capabilityIds: ['research', 'documents'],
      recommendedConnectorIds: ['github'],
      defaultPermissionMode: 'plan',
    }
    const createResponse = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: `API Manifest ${Date.now()}`, soulMd: 'careful', personaManifest: manifest }),
    })
    assert.equal(createResponse.status, 200)
    const created = (await createResponse.json()).agent
    assert.deepEqual(created.personaManifest.capabilityIds, ['research', 'documents'])

    const patchResponse = await fetch(`${base}/api/agents/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ personaManifest: { ...manifest, capabilityIds: ['coding'] } }),
    })
    assert.equal(patchResponse.status, 200)
    const patched = (await patchResponse.json()).agent
    assert.deepEqual(patched.personaManifest.capabilityIds, ['coding'])

    const exportResponse = await fetch(`${base}/api/agents/${created.id}/export.zip?skills=0&memories=0`, {
      headers: authHeaders(token),
    })
    assert.equal(exportResponse.status, 200)
    const raw = Buffer.from(await exportResponse.arrayBuffer())
    const zip = await JSZip.loadAsync(raw)
    const cardManifest = JSON.parse(await zip.file('manifest.json').async('string'))
    assert.equal(cardManifest.version, '0.3')
    assert.deepEqual(cardManifest.agent.personaManifest, patched.personaManifest)

    const importedResponse = await fetch(`${base}/api/agents/import.zip?overrideName=ImportedManifestCard`, {
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/zip' }),
      body: raw,
    })
    assert.equal(importedResponse.status, 200)
    const imported = (await importedResponse.json()).agent
    assert.deepEqual(imported.personaManifest, patched.personaManifest)
  })
})

test('v0.2 cards without persona manifest remain import-compatible', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const zip = new JSZip()
    zip.file('agent.md', '---\nname: "Legacy Manifest Card"\n---\n# Legacy\n\n## SOUL\n\nlegacy\n')
    zip.file('manifest.json', JSON.stringify({
      format: 'yma-agent-card',
      version: '0.2',
      agent: { name: 'Legacy Manifest Card' },
      skills: [],
    }))
    const raw = await zip.generateAsync({ type: 'nodebuffer' })
    const response = await fetch(`${base}/api/agents/import.zip`, {
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/zip' }),
      body: raw,
    })
    assert.equal(response.status, 200)
    const imported = (await response.json()).agent
    assert.deepEqual(imported.personaManifest, {
      version: 1,
      capabilityIds: [],
      recommendedConnectorIds: [],
      defaultPermissionMode: 'normal',
    })
  })
})
