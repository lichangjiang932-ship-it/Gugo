import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  closeLspRuntime,
  getLspRuntimeStatus,
  getLspService,
  hasConfiguredLspProvider,
  startLspRuntime,
} from '../server/services/lspRuntime.js'
import {
  getBuiltinSpec,
  resolveSpecsForMode,
} from '../server/utils/toolSchemaCatalog.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'

const allowedCommand = fs.realpathSync.native(process.execPath)
const existingUnlistedFile = fs.realpathSync.native(fileURLToPath(import.meta.url))

function providerConfig(overrides = {}) {
  return {
    id: 'typescript-lsp',
    command: allowedCommand,
    args: ['--stdio'],
    env: { LSP_TEST_MODE: '1' },
    extensionToLanguage: { '.ts': 'typescript' },
    ...overrides,
  }
}

function runtimeEnv(providers, allowlist = [allowedCommand]) {
  return {
    LSP_STDIO_PROVIDERS: JSON.stringify(providers),
    ...(allowlist === undefined
      ? {}
      : { LSP_STDIO_COMMAND_ALLOWLIST: JSON.stringify(allowlist) }),
  }
}

function directoryHasLsp() {
  return resolveSpecsForMode('chat').some((entry) => entry.name === 'lsp')
}

async function turnHasLsp() {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: [getBuiltinSpec('lsp')],
    enabledConnectorTools: [],
    toolsConfig: { enabled: ['lsp'], disabled: [] },
  })
  return specs.some((spec) => spec?.function?.name === 'lsp')
}

function createProvider(config, { onQuery = null, onClose = null } = {}) {
  return {
    id: config.id,
    extensionToLanguage: config.extensionToLanguage,
    async query(request, signal) {
      onQuery?.(request, signal)
      return {
        kind: 'locations',
        locations: [{
          uri: 'file:///workspace/src/definition.ts',
          range: {
            start: { line: 2, character: 3 },
            end: { line: 2, character: 9 },
          },
        }],
        resolvedWorkspaceUri: 'file:///workspace',
      }
    },
    async close() {
      onClose?.()
    },
  }
}

test.beforeEach(async () => {
  await closeLspRuntime()
})

test.after(async () => {
  await closeLspRuntime()
})

test('unconfigured runtime is disabled and keeps LSP out of API and turn catalogs', async () => {
  let factoryCalls = 0
  const status = await startLspRuntime({
    env: {},
    createProvider: async () => {
      factoryCalls += 1
      throw new Error('factory must not run')
    },
  })

  assert.deepEqual(status, {
    enabled: false,
    providerCount: 0,
    reason: 'not_configured',
    code: null,
  })
  assert.equal(factoryCalls, 0)
  assert.equal(getLspService(), null)
  assert.equal(hasConfiguredLspProvider(), false)
  assert.equal(directoryHasLsp(), false)
  assert.equal(await turnHasLsp(), false)
})

test('missing or mismatched command allowlists fail closed before any provider is registered', async (t) => {
  const cases = [
    {
      name: 'missing allowlist',
      env: { LSP_STDIO_PROVIDERS: JSON.stringify([providerConfig()]) },
      code: 'LSP_COMMAND_NOT_ALLOWED',
    },
    {
      name: 'later provider is not allowlisted',
      env: runtimeEnv([
        providerConfig(),
        providerConfig({
          id: 'javascript-lsp',
          command: existingUnlistedFile,
          extensionToLanguage: { '.js': 'javascript' },
        }),
      ]),
      code: 'LSP_COMMAND_NOT_ALLOWED',
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await closeLspRuntime()
      let factoryCalls = 0
      const status = await startLspRuntime({
        env: fixture.env,
        createProvider: async (config) => {
          factoryCalls += 1
          return createProvider(config)
        },
      })

      assert.equal(status.enabled, false)
      assert.equal(status.providerCount, 0)
      assert.equal(status.reason, 'invalid_config')
      assert.equal(status.code, fixture.code)
      assert.equal(factoryCalls, 0)
      assert.equal(getLspService(), null)
      assert.equal(hasConfiguredLspProvider(), false)
      assert.equal(directoryHasLsp(), false)
    })
  }
})

test('allowlisted absolute executable enables routed queries and API/turn discovery', async () => {
  const seenConfigs = []
  const seenQueries = []
  const status = await startLspRuntime({
    env: runtimeEnv([providerConfig()]),
    createProvider: async (config) => {
      seenConfigs.push(config)
      return createProvider(config, {
        onQuery: (request, signal) => seenQueries.push({ request, signal }),
      })
    },
  })

  assert.deepEqual(status, {
    enabled: true,
    providerCount: 1,
    reason: 'configured',
    code: null,
  })
  assert.equal(seenConfigs.length, 1)
  assert.equal(seenConfigs[0].command, allowedCommand)
  assert.equal(hasConfiguredLspProvider(), true)
  assert.equal(hasConfiguredLspProvider('src/example.TS'), true)
  assert.equal(hasConfiguredLspProvider('src/example.js'), false)
  assert.equal(directoryHasLsp(), true)
  assert.equal(await turnHasLsp(), true)

  const signal = new AbortController().signal
  const result = await getLspService().query({
    operation: 'goToDefinition',
    filePath: 'src/example.ts',
    workspaceRoot: '/workspace',
    position: { line: 4, character: 7 },
  }, signal)

  assert.equal(seenQueries.length, 1)
  assert.deepEqual(seenQueries[0].request, {
    operation: 'goToDefinition',
    filePath: 'src/example.ts',
    workspaceRoot: '/workspace',
    position: { line: 4, character: 7 },
    languageId: 'typescript',
  })
  assert.equal(seenQueries[0].signal, signal)
  assert.deepEqual(result, {
    kind: 'locations',
    locations: [{
      uri: 'file:///workspace/src/definition.ts',
      range: {
        start: { line: 2, character: 3 },
        end: { line: 2, character: 9 },
      },
    }],
    resolvedWorkspaceUri: 'file:///workspace',
  })
})

test('extension conflicts roll back atomically and close every created provider', async () => {
  const closeCounts = new Map()
  const configs = [
    providerConfig({ id: 'typescript-one' }),
    providerConfig({ id: 'typescript-two' }),
  ]
  const status = await startLspRuntime({
    env: runtimeEnv(configs),
    createProvider: async (config) => {
      let closed = false
      return createProvider(config, {
        onClose: () => {
          if (closed) return
          closed = true
          closeCounts.set(config.id, (closeCounts.get(config.id) || 0) + 1)
        },
      })
    },
  })

  assert.deepEqual(status, {
    enabled: false,
    providerCount: 0,
    reason: 'provider_initialization_failed',
    code: 'LSP_CONFLICT',
  })
  assert.deepEqual(Object.fromEntries(closeCounts), {
    'typescript-one': 1,
    'typescript-two': 1,
  })
  assert.equal(getLspService(), null)
  assert.equal(hasConfiguredLspProvider('src/example.ts'), false)
  assert.equal(directoryHasLsp(), false)
  assert.equal(await turnHasLsp(), false)
})

test('provider initialization failures replace private codes with a stable fallback', async () => {
  const status = await startLspRuntime({
    env: runtimeEnv([providerConfig()]),
    createProvider: async () => {
      const failure = new Error('private command C:\\secret\\language-server.exe')
      failure.code = 'C:\\secret\\language-server.exe'
      failure.command = 'C:\\secret\\language-server.exe'
      throw failure
    },
  })

  assert.deepEqual(status, {
    enabled: false,
    providerCount: 0,
    reason: 'provider_initialization_failed',
    code: 'LSP_PROVIDER_INIT_FAILED',
  })
  assert.equal(JSON.stringify(status).includes('secret'), false)
})

test('close is idempotent, disposes providers once, and hides LSP again', async () => {
  let closeCalls = 0
  await startLspRuntime({
    env: runtimeEnv([providerConfig()]),
    createProvider: async (config) => createProvider(config, {
      onClose: () => { closeCalls += 1 },
    }),
  })

  await Promise.all([closeLspRuntime(), closeLspRuntime(), closeLspRuntime()])

  assert.equal(closeCalls, 1)
  assert.deepEqual(getLspRuntimeStatus(), {
    enabled: false,
    providerCount: 0,
    reason: 'closed',
    code: null,
  })
  assert.equal(getLspService(), null)
  assert.equal(hasConfiguredLspProvider(), false)
  assert.equal(directoryHasLsp(), false)
  assert.equal(await turnHasLsp(), false)
})

test('runtime reports only stable query failure codes and recovers after a successful query', async () => {
  let failQuery = true
  await startLspRuntime({
    env: runtimeEnv([providerConfig()]),
    createProvider: async (config) => ({
      ...createProvider(config),
      async query(request, signal) {
        if (failQuery) {
          const failure = new Error('private executable C:\\secret\\typescript-language-server.exe')
          failure.code = 'LSP_MALFORMED_RESPONSE'
          failure.command = 'C:\\secret\\typescript-language-server.exe'
          failure.args = ['--private']
          failure.env = { PRIVATE_TOKEN: 'secret' }
          failure.cwd = 'C:\\private-workspace'
          failure.sourcePath = 'C:\\private-workspace\\source.ts'
          throw failure
        }
        return createProvider(config).query(request, signal)
      },
    }),
  })

  await assert.rejects(
    getLspService().query({
      operation: 'goToDefinition',
      filePath: 'src/example.ts',
      workspaceRoot: '/workspace',
      position: { line: 0, character: 0 },
    }),
    (failure) => failure?.code === 'LSP_MALFORMED_RESPONSE',
  )
  assert.deepEqual(getLspRuntimeStatus(), {
    enabled: true,
    providerCount: 1,
    reason: 'query_failed',
    code: 'LSP_MALFORMED_RESPONSE',
  })
  assert.equal(JSON.stringify(getLspRuntimeStatus()).includes('secret'), false)

  failQuery = false
  await getLspService().query({
    operation: 'goToDefinition',
    filePath: 'src/example.ts',
    workspaceRoot: '/workspace',
    position: { line: 0, character: 0 },
  })
  assert.deepEqual(getLspRuntimeStatus(), {
    enabled: true,
    providerCount: 1,
    reason: 'configured',
    code: null,
  })
})

test('runtime ignores request failures that do not describe provider readiness', async () => {
  await startLspRuntime({
    env: runtimeEnv([providerConfig()]),
    createProvider: async (config) => createProvider(config),
  })

  await assert.rejects(
    getLspService().query({
      operation: 'goToDefinition',
      filePath: 'src/example.js',
      workspaceRoot: '/workspace',
      position: { line: 0, character: 0 },
    }),
    (failure) => failure?.code === 'LSP_UNAVAILABLE',
  )
  assert.deepEqual(getLspRuntimeStatus(), {
    enabled: true,
    providerCount: 1,
    reason: 'configured',
    code: null,
  })
})
