import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-plugin-package-routes-'))
process.env.APP_DATA_DIR = tempDir

const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const { closeDb } = await import('../server/db.js')
const { handlePluginRequest } = await import('../server/routes/pluginRoutes.js')

const LOCAL_ENV = Object.freeze({ AUTH_MODE: 'local' })
const OWNER = bootstrapAuth({ env: LOCAL_ENV })
const REVISION = `sha256-${'a'.repeat(64)}`

function createRequest({
  url = '/api/plugins/packages',
  method = 'GET',
  token = '',
  remoteAddress = '127.0.0.1',
  body,
  rawBody,
} = {}) {
  const payload = rawBody === undefined
    ? body === undefined ? [] : [JSON.stringify(body)]
    : [rawBody]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  req.socket = { remoteAddress }
  return req
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(chunk = '') { this.body += chunk },
  }
}

function service(overrides = {}) {
  return {
    async listLocalPluginPackages() {
      return { schemaVersion: 1, store: { schemaVersion: 1, revision: REVISION, packages: [] } }
    },
    async importLocalPluginPackage(input) {
      return {
        schemaVersion: 1,
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        result: { operation: 'installed', input },
        refreshPending: false,
        restartRequired: false,
      }
    },
    async uninstallManagedLocalPluginPackage(input) {
      return {
        schemaVersion: 1,
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        result: { operation: 'uninstalled', input },
        refreshPending: false,
        restartRequired: false,
      }
    },
    async recoverManagedLocalPluginPackage(input) {
      return {
        schemaVersion: 1,
        recovered: true,
        outcome: 'uninstalled',
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        receipt: { pluginId: input.pluginId, generation: input.expectedGeneration },
      }
    },
    ...overrides,
  }
}

async function request(options = {}, packageService = service(), env = LOCAL_ENV) {
  const res = createResponse()
  await handlePluginRequest(createRequest(options), res, {
    env,
    localPluginPackageService: packageService,
  })
  return {
    status: res.statusCode,
    headers: res.headers,
    body: JSON.parse(res.body),
  }
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('local package endpoints require the loopback local owner before service access', async () => {
  let calls = 0
  const packageService = service({
    async listLocalPluginPackages() {
      calls += 1
      throw new Error('must not run')
    },
  })
  const unauthenticated = await request({}, packageService)
  assert.equal(unauthenticated.status, 401)
  assert.equal(unauthenticated.body.error.code, 'UNAUTHORIZED')

  const remote = await request({
    token: OWNER.token,
    remoteAddress: '192.0.2.20',
  }, packageService)
  assert.equal(remote.status, 403)
  assert.equal(remote.body.error.code, 'LOCAL_OWNER_ONLY')
  assert.equal(calls, 0)
})

test('GET lists only service-owned package metadata without caching', async () => {
  const response = await request({ token: OWNER.token })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.schemaVersion, 1)
  assert.equal(response.body.store.revision, REVISION)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.equal(JSON.stringify(response.body).includes(tempDir), false)
})

test('GET rejects query fields instead of accepting path or environment overrides', async () => {
  const response = await request({
    url: '/api/plugins/packages?managedRoot=C%3A%5Cforeign&env=unsafe',
    token: OWNER.token,
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'PLUGIN_PACKAGE_QUERY_INVALID')
})

test('POST import accepts only bounded business fields and forwards normalized CAS input', async () => {
  let received = null
  const packageService = service({
    async importLocalPluginPackage(input) {
      received = input
      return {
        schemaVersion: 1,
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        result: { operation: 'upgraded' },
        refreshPending: false,
        restartRequired: false,
      }
    },
  })
  const response = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    body: {
      sourceDirectory: '  D:\\plugins\\sample  ',
      expectedRevision: REVISION.toUpperCase(),
      replace: true,
      expectedPluginId: 'sample-plugin',
    },
  }, packageService)
  assert.equal(response.status, 200)
  assert.deepEqual(received, {
    sourceDirectory: 'D:\\plugins\\sample',
    expectedRevision: REVISION,
    replace: true,
    expectedPluginId: 'sample-plugin',
  })

  const injected = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    body: {
      sourceDirectory: 'D:\\plugins\\sample',
      expectedRevision: REVISION,
      managedRoot: 'D:\\foreign',
    },
  }, packageService)
  assert.equal(injected.status, 400)
  assert.match(injected.body.error.message, /unsupported fields/)
})

test('POST import requires an explicit target identity for replacement', async () => {
  const response = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    body: {
      sourceDirectory: 'D:\\plugins\\sample',
      expectedRevision: REVISION,
      replace: true,
    },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error.message, /expectedPluginId/)
})

test('package mutation bodies are capped at 8 KiB', async () => {
  const response = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    rawBody: JSON.stringify({
      sourceDirectory: `D:\\${'x'.repeat(9_000)}`,
      expectedRevision: REVISION,
    }),
  })
  assert.equal(response.status, 413)
  assert.equal(response.body.error.code, 'REQUEST_TOO_LARGE')
})

test('malformed JSON is a public 400 error and mutation query fields are rejected', async () => {
  const malformed = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    rawBody: '{',
  })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'INVALID_JSON')

  const query = await request({
    url: '/api/plugins/packages/sample-plugin?managedRoot=foreign',
    method: 'DELETE',
    token: OWNER.token,
    body: { expectedRevision: REVISION },
  })
  assert.equal(query.status, 400)
  assert.equal(query.body.error.code, 'PLUGIN_PACKAGE_QUERY_INVALID')
})

test('DELETE forwards plugin identity and CAS revision only', async () => {
  let received = null
  const packageService = service({
    async uninstallManagedLocalPluginPackage(input) {
      received = input
      return {
        schemaVersion: 1,
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        result: { operation: 'uninstalled' },
        refreshPending: false,
        restartRequired: false,
      }
    },
  })
  const response = await request({
    url: '/api/plugins/packages/sample-plugin',
    method: 'DELETE',
    token: OWNER.token,
    body: { expectedRevision: REVISION },
  }, packageService)
  assert.equal(response.status, 200)
  assert.deepEqual(received, { pluginId: 'sample-plugin', expectedRevision: REVISION })
})

test('plugin id import remains uninstallable because import uses a non-identity action path', async () => {
  let received = null
  const packageService = service({
    async uninstallManagedLocalPluginPackage(input) {
      received = input
      return {
        schemaVersion: 1,
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        result: { operation: 'uninstalled' },
        refreshPending: false,
        restartRequired: false,
      }
    },
  })
  const response = await request({
    url: '/api/plugins/packages/import',
    method: 'DELETE',
    token: OWNER.token,
    body: { expectedRevision: REVISION },
  }, packageService)
  assert.equal(response.status, 200)
  assert.deepEqual(received, { pluginId: 'import', expectedRevision: REVISION })
})

test('service conflicts remain actionable while internal paths are hidden', async () => {
  const conflictService = service({
    async importLocalPluginPackage() {
      const error = new Error('plugin package store changed; refresh and retry')
      error.code = 'PLUGIN_PACKAGE_REVISION_CONFLICT'
      error.statusCode = 409
      throw error
    },
  })
  const conflict = await request({
    url: '/api/plugins/packages/actions/import',
    method: 'POST',
    token: OWNER.token,
    body: { sourceDirectory: 'D:\\plugins\\sample', expectedRevision: REVISION },
  }, conflictService)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'PLUGIN_PACKAGE_REVISION_CONFLICT')
  assert.match(conflict.body.error.message, /refresh and retry/)

  const failedService = service({
    async listLocalPluginPackages() {
      const error = new Error(`failed at ${tempDir}`)
      error.code = 'PLUGIN_PACKAGE_STORE_FAILED'
      error.statusCode = 500
      throw error
    },
  })
  const failed = await request({ token: OWNER.token }, failedService)
  assert.equal(failed.status, 500)
  assert.equal(failed.body.error.message, '本地插件包操作失败')
  assert.equal(JSON.stringify(failed.body).includes(tempDir), false)
})

test('uninstall blockers expose only bounded safe details', async () => {
  const packageService = service({
    async uninstallManagedLocalPluginPackage() {
      const error = new Error('still referenced')
      error.code = 'PLUGIN_PACKAGE_RELEASES_RETAINED'
      error.statusCode = 409
      error.details = {
        pluginId: 'sample-plugin',
        dependantPluginIds: ['consumer-b', '../outside', 'consumer-a'],
        releaseCount: 2,
        pinCount: 1,
        checkpointCount: 1,
        referenceCount: 3,
        blockingReasons: ['retained_release', 'checkpoint_reference', 'private_path'],
        referenceId: 'C:\\private\\checkpoint',
        sourceDirectory: 'C:\\private\\plugins',
      }
      throw error
    },
  })
  const response = await request({
    url: '/api/plugins/packages/sample-plugin',
    method: 'DELETE',
    token: OWNER.token,
    body: { expectedRevision: REVISION },
  }, packageService)
  assert.equal(response.status, 409)
  assert.deepEqual(response.body.error.details, {
    pluginId: 'sample-plugin',
    dependantPluginIds: ['consumer-a', 'consumer-b'],
    releaseCount: 2,
    pinCount: 1,
    checkpointCount: 1,
    referenceCount: 3,
    blockingReasons: ['retained_release', 'checkpoint_reference'],
  })
  assert.equal(JSON.stringify(response.body).includes('private'), false)
})

test('POST recovery is owner-only, forwards only normalized CAS fields, and disables caching', async () => {
  let received = null
  const packageService = service({
    async recoverManagedLocalPluginPackage(input) {
      received = input
      return {
        schemaVersion: 1,
        recovered: true,
        outcome: 'uninstalled',
        store: { schemaVersion: 1, revision: REVISION, packages: [] },
        receipt: { pluginId: input.pluginId, generation: input.expectedGeneration },
      }
    },
  })
  const unauthorized = await request({
    url: '/api/plugins/packages/sample-plugin/actions/recover',
    method: 'POST',
    body: { expectedRevision: REVISION, expectedGeneration: 7 },
  }, packageService)
  assert.equal(unauthorized.status, 401)
  assert.equal(received, null)

  const response = await request({
    url: '/api/plugins/packages/SAMPLE-PLUGIN/actions/recover',
    method: 'POST',
    token: OWNER.token,
    body: { expectedRevision: REVISION.toUpperCase(), expectedGeneration: 7 },
  }, packageService)
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.deepEqual(received, {
    pluginId: 'sample-plugin',
    expectedRevision: REVISION,
    expectedGeneration: 7,
  })
})

test('POST recovery rejects extra fields and redacts internal failures', async () => {
  let calls = 0
  const packageService = service({
    async recoverManagedLocalPluginPackage() {
      calls += 1
      const error = new Error(`recovery failed at ${tempDir}`)
      error.code = 'PLUGIN_PACKAGE_RECOVERY_UNSAFE'
      error.statusCode = 503
      error.details = { pluginId: 'sample-plugin', sourceDirectory: tempDir }
      throw error
    },
  })
  const injected = await request({
    url: '/api/plugins/packages/sample-plugin/actions/recover',
    method: 'POST',
    token: OWNER.token,
    body: {
      expectedRevision: REVISION,
      expectedGeneration: 7,
      ownerPid: 1,
      barrierToken: 'private-token',
    },
  }, packageService)
  assert.equal(injected.status, 400)
  assert.equal(calls, 0)

  const failed = await request({
    url: '/api/plugins/packages/sample-plugin/actions/recover',
    method: 'POST',
    token: OWNER.token,
    body: { expectedRevision: REVISION, expectedGeneration: 7 },
  }, packageService)
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error.code, 'PLUGIN_PACKAGE_RECOVERY_UNSAFE')
  assert.equal(failed.body.error.message, '本地插件包操作失败')
  assert.equal(JSON.stringify(failed.body).includes(tempDir), false)
  assert.equal(JSON.stringify(failed.body).includes('private-token'), false)
})
