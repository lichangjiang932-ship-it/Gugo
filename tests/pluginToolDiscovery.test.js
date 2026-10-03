import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-discovery-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.GUGO_LOAD_DOTENV = '0'

const { closeDb, createUser } = await import('../server/db.js')
const {
  _resetRuntimePluginsForTests,
  registerPlugin,
  unregisterPlugin,
} = await import('../server/plugins/pluginRegistry.js')
const { createDefaultExecuteStep } = await import('../server/services/jobRuntime.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { getBuiltinSpec, registerDynamicTool } = await import('../server/services/toolRegistry.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')
const { selectJobToolSpecs } = await import('../server/services/toolLoopRuntime.js')
const { createTestTurnEnginePersistence } = await import('./helpers/turnEnginePersistence.js')

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

test('workspace authorization does not hide runtime plugins while plan mode remains fail-closed', async () => {
  await installDiscoveryPlugin('workspace-independent-discovery-plugin')

  const normalNames = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    permissionMode: 'normal',
    fileAccessStatus: { grants: [] },
    enabledConnectorTools: [],
  }))
  const planNames = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    permissionMode: 'plan',
    fileAccessStatus: { grants: [] },
    enabledConnectorTools: [],
  }))
  const disabledNames = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [],
    permissionMode: 'normal',
    fileAccessStatus: { grants: [] },
    toolsConfig: { disabled: ['plugin_global_discovery'] },
    userToolPermissions: { plugin_scoped_discovery: false },
    enabledConnectorTools: [],
  }))

  assert.equal(normalNames.has('plugin_global_discovery'), true)
  assert.equal(normalNames.has('plugin_scoped_discovery'), true)
  assert.equal(planNames.has('plugin_global_discovery'), false)
  assert.equal(planNames.has('plugin_scoped_discovery'), false)
  assert.equal(disabledNames.has('plugin_global_discovery'), false)
  assert.equal(disabledNames.has('plugin_scoped_discovery'), false)
})

test('a same-name dynamic placeholder cannot unlock a builtin workspace schema', async (t) => {
  const name = 'read_file'
  const placeholder = toolDefinition(name)
  const dispose = registerDynamicTool({ ...placeholder, origin: 'test', source: 'collision-probe' })
  t.after(dispose)

  const names = namesOf(await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [getBuiltinSpec(name)],
    permissionMode: 'normal',
    fileAccessStatus: { grants: [] },
    enabledConnectorTools: [],
  }))

  assert.equal(names.has(name), false)
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

test('explicit runtime-plugin intent survives deferred discovery and compact chat selection', async () => {
  await installDiscoveryPlugin('explicit-plugin-selection')
  const searchTools = getBuiltinSpec('search_tools')
  let deferred = []
  const ordinary = await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [searchTools],
    enabledConnectorTools: [],
    prompt: 'Explain this local project.',
    onDeferredSpecs: (specs) => { deferred = specs },
  })
  assert.equal(namesOf(ordinary).has('plugin_global_discovery'), false)
  assert.equal(namesOf(deferred).has('plugin_global_discovery'), true)

  const explicitPrompt = 'Use the runtime plugin tool for this task.'
  const explicit = await resolveTurnToolSpecs({
    userId: OWNER,
    baseSpecs: [searchTools],
    enabledConnectorTools: [],
    prompt: explicitPrompt,
  })
  const selected = selectJobToolSpecs({
    origin: 'chat',
    specs: explicit,
    prompt: explicitPrompt,
    userPrompt: explicitPrompt,
  })
  assert.equal(namesOf(selected).has('plugin_global_discovery'), true)
  assert.equal(namesOf(selected).has('plugin_scoped_discovery'), true)
})

test('TurnEngine passes visible runtime plugin tools to the real loop input', async () => {
  await installDiscoveryPlugin('turn-engine-discovery-plugin')
  let observed = null
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
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
  // Scope is set by the trusted registry host, not by plugin-supplied metadata.
  for (const [userId, name] of [[OWNER, 'plugin_owner_only_discovery'], [OTHER, 'plugin_other_only_discovery']]) {
    t.after(registerDynamicTool({ ...toolDefinition(name, { userId }), origin: 'plugin', source: 'trusted-job-discovery-fixture' }))
  }
  const observed = new Map()
  const requestOwners = []
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ tools, userId, usageOwnerId, modelEnv }) => {
      const names = namesOf(tools)
      requestOwners.push({ userId, usageOwnerId, frozenEnvironment: Object.isFrozen(modelEnv), names })
      // A bound environment deliberately clears transport userId so the model
      // adapter cannot expand the Provider scope again. Logical ownership is
      // carried independently in usageOwnerId, including tool-free wrap-up calls.
      observed.set(usageOwnerId, new Set([...(observed.get(usageOwnerId) || []), ...names]))
      return { content: 'verification complete', toolCalls: [] }
    },
  })

  for (const userId of [OWNER, OTHER]) {
    const requestStart = requestOwners.length
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
    const requests = requestOwners.slice(requestStart)
    assert.ok(requests.length > 0)
    assert.ok(requests.every((request) => request.usageOwnerId === userId))
    assert.ok(requests.every((request) => request.userId === null && request.frozenEnvironment))
    const otherTool = userId === OWNER ? 'plugin_other_only_discovery' : 'plugin_owner_only_discovery'
    assert.ok(requests.every((request) => !request.names.has(otherTool)))
    assert.ok(requests.every((request) => !request.names.has('foreign_job_dynamic_probe')))
  }

  assert.equal(observed.get(OWNER)?.has('plugin_global_discovery'), true)
  assert.equal(observed.get(OWNER)?.has('plugin_scoped_discovery'), true)
  assert.equal(observed.get(OTHER)?.has('plugin_global_discovery'), true)
  assert.equal(observed.get(OTHER)?.has('plugin_scoped_discovery'), true)
  assert.equal(observed.get(OWNER)?.has('foreign_job_dynamic_probe'), false)
  assert.equal(observed.get(OTHER)?.has('foreign_job_dynamic_probe'), false)
  assert.equal(observed.get(OWNER)?.has('plugin_owner_only_discovery'), true)
  assert.equal(observed.get(OTHER)?.has('plugin_other_only_discovery'), true)
})
