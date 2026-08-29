import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLspService,
  LspError,
  LSP_OPERATIONS,
} from '../server/services/lspService.js'

const WORKSPACE_URI = 'file:///workspace/'

function position(line = 0, character = 0) {
  return { line, character }
}

function request(overrides = {}) {
  return {
    operation: 'goToDefinition',
    filePath: 'src/example.ts',
    workspaceRoot: '/workspace',
    position: position(0, 6),
    ...overrides,
  }
}

function locationsResult(overrides = {}) {
  return {
    kind: 'locations',
    locations: [{
      uri: 'file:///workspace/src/definition.ts',
      range: { start: position(2, 4), end: position(2, 12) },
    }],
    resolvedWorkspaceUri: WORKSPACE_URI,
    ...overrides,
  }
}

function provider(overrides = {}) {
  return {
    id: 'typescript',
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    query: async () => locationsResult(),
    ...overrides,
  }
}

test('exports the frozen four-operation LSP contract and stable errors', () => {
  assert.deepEqual(LSP_OPERATIONS, [
    'goToDefinition',
    'findReferences',
    'goToImplementation',
    'hover',
  ])
  assert.equal(Object.isFrozen(LSP_OPERATIONS), true)
  const error = new LspError('LSP_UNAVAILABLE', 'missing provider')
  assert.equal(error.name, 'LspError')
  assert.equal(error.code, 'LSP_UNAVAILABLE')
  assert.equal(error.retryable, false)
})

test('registerProvider validates atomically and preserves the active route after conflicts', async () => {
  const service = createLspService()
  assert.throws(
    () => service.registerProvider(provider({ id: '' })),
    (error) => error?.code === 'LSP_INVALID_PROVIDER',
  )
  assert.throws(
    () => service.registerProvider(provider({ extensionToLanguage: {} })),
    (error) => error?.code === 'LSP_INVALID_PROVIDER',
  )
  assert.throws(
    () => service.registerProvider(provider({ extensionToLanguage: { '.TS': 'ts', ts: 'ts' } })),
    (error) => error?.code === 'LSP_INVALID_PROVIDER',
  )
  assert.equal(service.hasProviderForFile('before.ts'), false)

  service.registerProvider(provider())
  assert.throws(
    () => service.registerProvider(provider({ id: 'typescript' })),
    (error) => error?.code === 'LSP_CONFLICT',
  )
  assert.throws(
    () => service.registerProvider(provider({
      id: 'conflicting-provider',
      extensionToLanguage: { '.TS': 'other', '.js': 'javascript' },
    })),
    (error) => error?.code === 'LSP_CONFLICT',
  )
  assert.equal(service.hasProviderForFile('src/kept.TS'), true)
  assert.equal(service.hasProviderForFile('src/not-published.js'), false)
  assert.equal((await service.query(request())).kind, 'locations')
  await service.close()
})

test('query selects by lowercase final extension and forwards an immutable request and AbortSignal', async () => {
  const service = createLspService()
  const controller = new AbortController()
  let observed = null
  let observedSignal = null
  let closeCalls = 0
  const dispose = service.registerProvider(provider({
    extensionToLanguage: { TS: 'typescript' },
    async query(input, signal) {
      observed = input
      observedSignal = signal
      return locationsResult()
    },
    close() { closeCalls += 1 },
  }))

  const result = await service.query(request({ filePath: 'src/Example.TS' }), controller.signal)
  assert.equal(observedSignal, controller.signal)
  assert.deepEqual(observed, {
    operation: 'goToDefinition',
    filePath: 'src/Example.TS',
    workspaceRoot: '/workspace',
    position: { line: 0, character: 6 },
    languageId: 'typescript',
  })
  assert.equal(Object.isFrozen(observed), true)
  assert.equal(Object.isFrozen(observed.position), true)
  assert.equal(result.kind, 'locations')
  assert.equal(dispose(), true)
  assert.equal(dispose(), false)
  assert.equal(closeCalls, 1)
  assert.equal(service.hasProviderForFile('src/Example.ts'), false)
  await assert.rejects(
    service.query(request()),
    (error) => error?.code === 'LSP_UNAVAILABLE',
  )
  await service.close()
})

test('query rejects malformed requests before invoking a provider', async () => {
  const service = createLspService()
  let calls = 0
  service.registerProvider(provider({ query: async () => { calls += 1; return locationsResult() } }))
  const invalidRequests = [
    [null, 'LSP_INVALID_REQUEST'],
    [request({ operation: 'rename' }), 'LSP_UNSUPPORTED_OPERATION'],
    [request({ filePath: '' }), 'LSP_INVALID_REQUEST'],
    [request({ workspaceRoot: '  ' }), 'LSP_INVALID_REQUEST'],
    [request({ position: { line: -1, character: 0 } }), 'LSP_INVALID_REQUEST'],
    [request({ position: { line: 0, character: 0.5 } }), 'LSP_INVALID_REQUEST'],
  ]
  for (const [input, code] of invalidRequests) {
    await assert.rejects(service.query(input), (error) => error?.code === code)
  }
  await assert.rejects(
    service.query(request(), {}),
    (error) => error?.code === 'LSP_INVALID_REQUEST',
  )
  assert.equal(calls, 0)
  await service.close()
})

test('query reports unavailable extensions with a stable error', async () => {
  const service = createLspService()
  service.registerProvider(provider())
  assert.equal(service.hasProviderForFile('README'), false)
  assert.equal(service.hasProviderForFile('.bashrc'), false)
  assert.equal(service.hasProviderForFile(null), false)
  await assert.rejects(
    service.query(request({ filePath: 'src/example.py' })),
    (error) => error instanceof LspError && error.code === 'LSP_UNAVAILABLE',
  )
  await service.close()
})

test('navigation results are normalized copies and deeply frozen', async () => {
  const service = createLspService()
  const source = locationsResult({ ignored: 'provider-private' })
  service.registerProvider(provider({ query: async () => source }))
  const result = await service.query(request({ operation: 'findReferences' }))

  assert.deepEqual(result, locationsResult())
  assert.notEqual(result, source)
  assert.notEqual(result.locations, source.locations)
  assert.notEqual(result.locations[0], source.locations[0])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.locations), true)
  assert.equal(Object.isFrozen(result.locations[0]), true)
  assert.equal(Object.isFrozen(result.locations[0].range), true)
  assert.equal(Object.isFrozen(result.locations[0].range.start), true)

  source.locations[0].uri = 'file:///mutated.ts'
  assert.equal(result.locations[0].uri, 'file:///workspace/src/definition.ts')
  await service.close()
})

test('hover results support null or immutable contents and reject response-kind mismatches', async () => {
  const service = createLspService()
  const sourceHover = {
    kind: 'hover',
    hover: {
      contents: '```ts\nclass Example\n```',
      range: { start: position(1, 2), end: position(1, 9) },
      ignored: true,
    },
  }
  let current = sourceHover
  service.registerProvider(provider({ query: async () => current }))

  const result = await service.query(request({ operation: 'hover' }))
  assert.deepEqual(result, {
    kind: 'hover',
    hover: {
      contents: '```ts\nclass Example\n```',
      range: { start: position(1, 2), end: position(1, 9) },
    },
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.hover), true)
  assert.equal(Object.isFrozen(result.hover.range.end), true)

  current = { kind: 'hover', hover: null }
  assert.deepEqual(await service.query(request({ operation: 'hover' })), {
    kind: 'hover',
    hover: null,
  })
  current = sourceHover
  await assert.rejects(
    service.query(request({ operation: 'goToImplementation' })),
    (error) => error?.code === 'LSP_MALFORMED_RESPONSE',
  )
  current = locationsResult()
  await assert.rejects(
    service.query(request({ operation: 'hover' })),
    (error) => error?.code === 'LSP_MALFORMED_RESPONSE',
  )
  await service.close()
})

test('close removes every route, isolates provider failures, and permanently disposes the service', async () => {
  const service = createLspService()
  const closed = []
  service.registerProvider(provider({
    id: 'sync-failure',
    extensionToLanguage: { '.ts': 'typescript' },
    close() {
      closed.push('sync-failure')
      throw new Error('close failed')
    },
  }))
  service.registerProvider(provider({
    id: 'async-failure',
    extensionToLanguage: { '.js': 'javascript' },
    async close() {
      closed.push('async-failure')
      throw new Error('async close failed')
    },
  }))
  service.registerProvider(provider({
    id: 'healthy',
    extensionToLanguage: { '.py': 'python' },
    close() { closed.push('healthy') },
  }))

  const firstClose = service.close()
  assert.equal(service.close(), firstClose)
  await firstClose
  assert.deepEqual(closed.sort(), ['async-failure', 'healthy', 'sync-failure'])
  assert.equal(service.hasProviderForFile('src/example.ts'), false)
  await assert.rejects(
    service.query(request()),
    (error) => error?.code === 'LSP_DISPOSED',
  )
  assert.throws(
    () => service.registerProvider(provider({ id: 'late' })),
    (error) => error?.code === 'LSP_DISPOSED',
  )
})
