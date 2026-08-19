import assert from 'node:assert/strict'
import test from 'node:test'

import { openRuntimeConfigInBrowser } from '../src/lib/runtimeConfigClient.js'

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
