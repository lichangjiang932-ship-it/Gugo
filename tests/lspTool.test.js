import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-lsp-tool-'))
const workspace = path.join(testRoot, 'workspace')
const outsideWorkspace = path.join(testRoot, 'outside-workspace')
const dataDirectory = path.join(testRoot, 'data')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(outsideWorkspace, { recursive: true })
fs.mkdirSync(dataDirectory, { recursive: true })

const sourceFile = path.join(workspace, 'source.js')
const secondFile = path.join(workspace, 'second.js')
const outsideFile = path.join(outsideWorkspace, 'outside.js')
const ungrantedFile = path.join(testRoot, 'ungranted.js')
const longFile = path.join(workspace, `${'long-location-'.repeat(10)}.js`)
fs.writeFileSync(sourceFile, '😀target()\nconst value = target()\n', 'utf8')
fs.writeFileSync(secondFile, 'export const second = true\n', 'utf8')
fs.writeFileSync(outsideFile, 'export const outside = true\n', 'utf8')
fs.writeFileSync(ungrantedFile, 'export const secret = true\n', 'utf8')
fs.writeFileSync(longFile, 'export const longName = true\n', 'utf8')

const savedEnv = {
  APP_DATA_DIR: process.env.APP_DATA_DIR,
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
process.env.APP_DATA_DIR = dataDirectory
process.env.APP_DB_PATH = path.join(dataDirectory, 'lsp-tool.db')
process.env.WORKSPACE_FS_ENABLED = '0'
process.env.WORKSPACE_ROOT = path.join(testRoot, 'disabled-shared-workspace')
process.env.WORKSPACE_SHARED_TRUSTED = '0'

const { closeDb, createUser } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { LSP_TOOL_SPEC, dispatchLspTool, _testing } = await import('../server/utils/lspTool.js')

let userSequence = 0
function makeUser(label) {
  userSequence += 1
  const id = `lsp-${label}-${process.pid}-${userSequence}`
  createUser({ id, email: `${id}@example.com` })
  setApprovalMode({ userId: id, mode: 'normal' })
  return id
}

function location(filePath, line = 0, character = 0) {
  return {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  }
}

function fakeService(respond, calls = []) {
  return {
    hasProviderForFile: () => true,
    async query(request, signal) {
      calls.push({ request, signal })
      return respond(request, signal)
    },
  }
}

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(testRoot, { recursive: true, force: true })
})

test('LSP tool schema exposes the closed read-only operation set and one-based coordinates', () => {
  assert.equal(LSP_TOOL_SPEC.function.name, 'lsp')
  assert.deepEqual(LSP_TOOL_SPEC.function.parameters.properties.operation.enum, [
    'goToDefinition',
    'findReferences',
    'goToImplementation',
    'hover',
  ])
  assert.equal(LSP_TOOL_SPEC.function.parameters.properties.line.minimum, 1)
  assert.equal(LSP_TOOL_SPEC.function.parameters.properties.character.minimum, 1)
})

test('ungranted source is rejected before the LSP provider is called', async () => {
  const userId = makeUser('ungranted')
  let queries = 0
  const service = fakeService(() => {
    queries += 1
    return { kind: 'locations', locations: [] }
  })

  await assert.rejects(
    dispatchLspTool({
      operation: 'goToDefinition',
      file: sourceFile,
      line: 1,
      character: 1,
      workspace_root: workspace,
    }, { userId, service }),
    (error) => {
      assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
      assert.equal(error.statusCode, 403)
      assert.equal(error.requiredAccessMode, 'read_only')
      assert.match(error.message, /source\.js/u)
      return true
    },
  )
  assert.equal(queries, 0)
})

test('read-only grant authorizes all four operations and converts 1-based UTF-16 coordinates', async () => {
  const userId = makeUser('coordinates')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  const calls = []
  const service = fakeService((request) => (
    request.operation === 'hover'
      ? { kind: 'hover', hover: { contents: 'target(): void' } }
      : { kind: 'locations', locations: [location(sourceFile)] }
  ), calls)

  for (const operation of ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']) {
    await dispatchLspTool({
      operation,
      file: sourceFile,
      line: 1,
      // The astral emoji occupies two UTF-16 code units, so model character 3
      // must arrive at the LSP seam as zero-based character 2.
      character: 3,
      workspace_root: workspace,
    }, { userId, service })
  }

  assert.deepEqual(calls.map(({ request }) => request.operation), [
    'goToDefinition',
    'findReferences',
    'goToImplementation',
    'hover',
  ])
  for (const { request } of calls) {
    assert.equal(request.filePath, fs.realpathSync(sourceFile))
    assert.equal(request.workspaceRoot, fs.realpathSync(workspace))
    assert.deepEqual(request.position, { line: 0, character: 2 })
  }
})

test('an authorized source cannot escape an independently authorized workspace root', async () => {
  const userId = makeUser('workspace-boundary')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  grantLocalPath({ userId, rootPath: outsideWorkspace, accessMode: 'read_only' })
  const service = fakeService(() => ({ kind: 'locations', locations: [] }))

  await assert.rejects(
    dispatchLspTool({
      operation: 'findReferences',
      file: outsideFile,
      line: 1,
      character: 1,
      workspace_root: workspace,
    }, { userId, service }),
    (error) => {
      assert.equal(error.code, 'LSP_PATH_OUTSIDE_WORKSPACE')
      assert.equal(error.statusCode, 403)
      return true
    },
  )
})

test('provider file URIs are re-authorized and locations outside the selected workspace are filtered', async () => {
  const userId = makeUser('result-authorization')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  grantLocalPath({ userId, rootPath: outsideWorkspace, accessMode: 'read_only' })
  const service = fakeService(() => ({
    kind: 'locations',
    locations: [
      location(secondFile, 2, 4),
      location(outsideFile, 3, 5),
      location(ungrantedFile, 4, 6),
      { ...location(secondFile), uri: 'https://example.com/source.js' },
    ],
  }))

  const result = await dispatchLspTool({
    operation: 'findReferences',
    file: sourceFile,
    line: 1,
    character: 3,
    workspace_root: workspace,
  }, { userId, service })

  assert.equal(result.locations.length, 1)
  assert.deepEqual(result.locations[0], {
    file: fs.realpathSync(secondFile),
    line: 3,
    character: 5,
    end_line: 3,
    end_character: 6,
  })
})

test('location output is limited to 100 entries and the complete JSON result stays bounded', async () => {
  const userId = makeUser('location-limits')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  const service = fakeService(() => ({
    kind: 'locations',
    locations: Array.from({ length: 150 }, (_, index) => location(
      longFile,
      index,
      index % 20,
    )),
  }))

  const result = await dispatchLspTool({
    operation: 'findReferences',
    file: sourceFile,
    line: 1,
    character: 3,
    workspace_root: workspace,
  }, { userId, service })
  const serialized = JSON.stringify(result)

  assert.ok(result.locations.length <= 100)
  assert.equal(result.truncated, true)
  assert.ok(serialized.length <= _testing.MAX_RESULT_BYTES)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= _testing.MAX_RESULT_BYTES)
})

test('hover output truncates escaped Unicode content within the complete serialized limit', async () => {
  const userId = makeUser('hover-limit')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  const contents = '😀"\\\n'.repeat(12_000)
  const service = fakeService(() => ({
    kind: 'hover',
    hover: {
      contents,
      range: {
        start: { line: 0, character: 2 },
        end: { line: 0, character: 8 },
      },
    },
  }))

  const result = await dispatchLspTool({
    operation: 'hover',
    file: sourceFile,
    line: 1,
    character: 3,
    workspace_root: workspace,
  }, { userId, service })
  const serialized = JSON.stringify(result)

  assert.equal(result.truncated, true)
  assert.ok(result.hover.contents.length < contents.length)
  assert.deepEqual(result.hover.range, {
    line: 1,
    character: 3,
    end_line: 1,
    end_character: 9,
  })
  assert.ok(serialized.length <= _testing.MAX_RESULT_BYTES)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= _testing.MAX_RESULT_BYTES)
})

test('AbortSignal is passed to the provider query without wrapping or replacement', async () => {
  const userId = makeUser('abort-signal')
  grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_only' })
  const controller = new AbortController()
  let receivedSignal
  const service = fakeService((_request, signal) => {
    receivedSignal = signal
    return { kind: 'locations', locations: [] }
  })

  await dispatchLspTool({
    operation: 'goToDefinition',
    file: sourceFile,
    line: 1,
    character: 3,
    workspace_root: workspace,
  }, { userId, signal: controller.signal, service })

  assert.equal(receivedSignal, controller.signal)
})
