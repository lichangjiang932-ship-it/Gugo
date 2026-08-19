import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-discovery-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const {
  _resetRuntimePluginsForTests,
  registerPlugin,
  unregisterPlugin,
} = await import('../server/plugins/pluginRegistry.js')
const { createDefaultExecuteStep } = await import('../server/services/jobRuntime.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { registerDynamicTool } = await import('../server/services/toolRegistry.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')

const OWNER = 'plugin-discovery-owner'
const OTHER = 'plugin-discovery-other'
const SESSION = 'plugin-discovery-session'

for (const [id, email] of [[OWNER, 'owner@example.com'], [OTHER, 'other@example.com']]) {
  createUser({ id, email })
  upsertSession({ id: `${SESSION}-${id}`, userId: id, title: 'Plugin discovery' })
}

function manifest(id) {
  return {
    id,
    name: id,
    version: '1.0.0',
    contributes: [
      'tool:plugin_global_discovery',
      'tool:plugin_scoped_discovery',
    ],
  }
}

function toolDefinition(name, { userId = null } = {}) {
  return {
    name,
    ...(userId ? { userId } : {}),
    spec: {
      type: 'function',
      function: {
        name,
        description: `Runtime test tool ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    exec: async () => ({ ok: true, name }),
  }
}

function namesOf(specs) {
  return new Set((Array.isArray(specs) ? specs : [])
    .map((spec) => spec?.function?.name)
    .filter(Boolean))
}

async function installDiscoveryPlugin(id = 'production-discovery-plugin') {
  await registerPlugin(manifest(id), (ctx) => {
    ctx.tools.register(toolDefinition('plugin_global_discovery'))
    ctx.tools.register(toolDefinition('plugin_scoped_discovery', { userId: OWNER }))
  })
}

test.afterEach(async () => {
  await _resetRuntimePluginsForTests()
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('runtime plugins cannot forge tenant scope and their tools disappear on unload', async () => {
  await installDiscoveryPlugin()

  const ownerNames = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    enabledConnectorTools: [],
  }))
  const otherNames = namesOf(await resolveTurnToolSpecs({
    userId: OTHER,
    baseSpecs: [],
    enabledConnectorTools: [],
  }))

  assert.equal(ownerNames.has('plugin_global_discovery'), true)
  assert.equal(ownerNames.has('plugin_scoped_discovery'), true)
  assert.equal(otherNames.has('plugin_global_discovery'), true)
  assert.equal(otherNames.has('plugin_scoped_discovery'), true)

  assert.equal(await unregisterPlugin('production-discovery-plugin'), true)
  const unloadedNames = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    enabledConnectorTools: [],
  }))
  assert.equal(unloadedNames.has('plugin_global_discovery'), false)
  assert.equal(unloadedNames.has('plugin_scoped_discovery'), false)
})

test('production turn discovery does not inject unrelated dynamic registry origins', async (t) => {
  const foreign = toolDefinition('foreign_dynamic_probe')
  const dispose = registerDynamicTool({ ...foreign, origin: 'test', source: 'test-only' })
  t.after(dispose)

  const names = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    enabledConnectorTools: [],
  }))
  assert.equal(names.has('foreign_dynamic_probe'), false)
})

test('TurnEngine passes visible runtime plugin tools to the real loop input', async () => {
  await installDiscoveryPlugin('turn-engine-discovery-plugin')
  let observed = null
  const engine = new TurnEngine({
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ toolSpecs }) => {
      observed = namesOf(toolSpecs)
      return { text: 'plugin catalog observed', artifactIds: [], iterations: 1 }
    },
  })

  const turnId = 'plugin-discovery-turn'
  await engine.startTurn({
    userId: OWNER,
    sessionId: `${SESSION}-${OWNER}`,
    turnId,
    content: 'Use the runtime plugin if needed.',
  })
  await engine.waitForTurn({ userId: OWNER, sessionId: `${SESSION}-${OWNER}`, turnId })

  assert.equal(observed?.has('plugin_global_discovery'), true)
  assert.equal(observed?.has('plugin_scoped_discovery'), true)
})

test('background Job model requests receive only that user\'s runtime plugin tools', async (t) => {
  await installDiscoveryPlugin('job-discovery-plugin')
  const foreign = toolDefinition('foreign_job_dynamic_probe')
  const disposeForeign = registerDynamicTool({ ...foreign, origin: 'test', source: 'test-only' })
  t.after(disposeForeign)
  const observed = new Map()
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ tools, userId }) => {
      observed.set(userId, namesOf(tools))
      return { content: 'verification complete', toolCalls: [] }
    },
  })

  for (const userId of [OWNER, OTHER]) {
    await executeStep({
      job: {
        id: `plugin-job-${userId}`,
        userId,
        title: 'Plugin visibility job',
        prompt: 'Verify the runtime plugin catalog.',
        steps: [],
        artifacts: [],
      },
      step: { id: `plugin-step-${userId}`, kind: 'verify' },
    })
    assert.ok(observed.has(userId), `Job model request was not issued for ${userId}`)
  }

  assert.equal(observed.get(OWNER)?.has('plugin_global_discovery'), true)
  assert.equal(observed.get(OWNER)?.has('plugin_scoped_discovery'), true)
  assert.equal(observed.get(OTHER)?.has('plugin_global_discovery'), true)
  assert.equal(observed.get(OTHER)?.has('plugin_scoped_discovery'), true)
  assert.equal(observed.get(OWNER)?.has('foreign_job_dynamic_probe'), false)
})
