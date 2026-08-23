import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearAuthoritativeUserData,
  downloadAuthoritativeUserData,
  openRuntimeConfigInBrowser,
  previewAuthoritativeUserDataClear,
  USER_DATA_CLEAR_CONFIRMATION,
} from '../src/lib/runtimeConfigClient.js'

function previewWindow() {
  return {
    opener: {},
    closed: false,
    location: {
      value: '',
      replace(value) { this.value = value },
    },
    close() { this.closed = true },
  }
}

test('web runtime config opens an authenticated response in a reserved tab', async () => {
  const preview = previewWindow()
  const requests = []
  const revoked = []
  const scheduled = []
  const result = await openRuntimeConfigInBrowser({
    authToken: 'session-token',
    windowRef: {
      open(url, target) {
        assert.equal(url, 'about:blank')
        assert.equal(target, '_blank')
        return preview
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response('{"env":{}}', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    },
    urlApi: {
      createObjectURL(blob) {
        assert.equal(blob.type, 'application/json;charset=utf-8')
        return 'blob:runtime-config'
      },
      revokeObjectURL(url) { revoked.push(url) },
    },
    schedule(callback, delay) { scheduled.push({ callback, delay }) },
  })

  assert.deepEqual(result, { opened: true })
  assert.equal(preview.opener, null)
  assert.equal(preview.location.value, 'blob:runtime-config')
  assert.deepEqual(requests, [{
    url: '/api/system/runtime-config',
    options: {
      headers: { Authorization: 'Bearer session-token' },
      credentials: 'same-origin',
    },
  }])
  assert.equal(scheduled[0].delay, 60_000)
  scheduled[0].callback()
  assert.deepEqual(revoked, ['blob:runtime-config'])
})

test('web runtime config closes the reserved tab when the server rejects access', async () => {
  const preview = previewWindow()
  await assert.rejects(
    openRuntimeConfigInBrowser({
      authToken: 'session-token',
      windowRef: { open: () => preview },
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'not available' },
      }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    }),
    /not available/,
  )
  assert.equal(preview.closed, true)
})

test('web runtime config fails clearly when the browser blocks the new tab', async () => {
  await assert.rejects(
    openRuntimeConfigInBrowser({
      windowRef: { open: () => null },
      authToken: 'session-token',
    }),
    (error) => error?.code === 'CONFIG_POPUP_BLOCKED',
  )
})

test('authoritative user-data export downloads the authenticated ZIP and revokes its object URL', async () => {
  const requests = []
  const revoked = []
  const scheduled = []
  let clicked = 0
  let removed = 0
  const anchor = {
    hidden: false,
    href: '',
    download: '',
    click() { clicked += 1 },
    remove() { removed += 1 },
  }
  const result = await downloadAuthoritativeUserData({
    authToken: 'session-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(new Blob(['zip-body'], { type: 'application/zip' }), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': "attachment; filename*=UTF-8''gugo%20data%3Abackup.zip",
        },
      })
    },
    documentRef: {
      createElement(tagName) {
        assert.equal(tagName, 'a')
        return anchor
      },
      body: {
        appendChild(element) { assert.equal(element, anchor) },
      },
    },
    urlApi: {
      createObjectURL(blob) {
        assert.equal(blob.type, 'application/zip')
        return 'blob:user-data'
      },
      revokeObjectURL(url) { revoked.push(url) },
    },
    schedule(callback, delay) { scheduled.push({ callback, delay }) },
  })

  assert.deepEqual(result, { downloaded: true, filename: 'gugo data_backup.zip' })
  assert.deepEqual(requests, [{
    url: '/api/system/user-data/export',
    options: {
      headers: { Authorization: 'Bearer session-token' },
      credentials: 'same-origin',
    },
  }])
  assert.equal(anchor.href, 'blob:user-data')
  assert.equal(anchor.download, 'gugo data_backup.zip')
  assert.equal(anchor.hidden, true)
  assert.equal(clicked, 1)
  assert.equal(removed, 1)
  assert.equal(scheduled[0].delay, 60_000)
  scheduled[0].callback()
  assert.deepEqual(revoked, ['blob:user-data'])
})

test('authoritative user-data export preserves structured server errors', async () => {
  await assert.rejects(
    downloadAuthoritativeUserData({
      authToken: 'session-token',
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'USER_DATA_EXPORT_BUSY',
          message: 'export is busy',
          retryable: true,
        },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    }),
    (error) => {
      assert.equal(error?.code, 'USER_DATA_EXPORT_BUSY')
      assert.equal(error?.message, 'export is busy')
      assert.equal(error?.status, 409)
      assert.equal(error?.retryable, true)
      return true
    },
  )
})

test('authoritative user-data clear sends the exact confirmation with same-origin authentication', async () => {
  const requests = []
  const result = await clearAuthoritativeUserData({
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    previewToken: 'preview-token',
    authToken: 'session-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({ ok: true, cleared: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  assert.deepEqual(result, { ok: true, cleared: true })
  assert.deepEqual(requests, [{
    url: '/api/system/user-data',
    options: {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer session-token',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        previewToken: 'preview-token',
      }),
    },
  }])
})

test('authoritative user-data clear preview is authenticated and returns only the server projection', async () => {
  const requests = []
  const preview = await previewAuthoritativeUserDataClear({
    authToken: 'session-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({
        ok: true,
        preview: {
          token: 'opaque-preview-token',
          databaseRows: { total: 3 },
          managedFiles: { removable: 2, removableBytes: 12 },
        },
      }), { headers: { 'Content-Type': 'application/json' } })
    },
  })

  assert.equal(preview.token, 'opaque-preview-token')
  assert.deepEqual(requests, [{
    url: '/api/system/user-data/preview',
    options: {
      headers: { Authorization: 'Bearer session-token' },
      credentials: 'same-origin',
    },
  }])
})

test('authoritative user-data clear preserves partial-failure details', async () => {
  await assert.rejects(
    clearAuthoritativeUserData({
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      authToken: 'session-token',
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
          message: 'cleanup remains pending',
          incomplete: true,
          databaseCleared: true,
          cleanupPending: true,
        },
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    }),
    (error) => {
      assert.equal(error?.code, 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE')
      assert.equal(error?.status, 500)
      assert.equal(error?.incomplete, true)
      assert.equal(error?.databaseCleared, true)
      assert.equal(error?.cleanupPending, true)
      return true
    },
  )
})
