import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelJob,
  createJob,
  getJob,
  loadArtifactPreviewDocument,
  loadArtifactPreviewHtml,
  listJobs,
  retryJob,
  retryStep,
  subscribeToJobEvents,
} from '../src/lib/jobClient.js'
import { setAuthToken } from '../src/lib/accountClient.js'

test('job client uses expected endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ job: { id: 'job-1' }, jobs: [] }),
    }
  }

  await createJob('生成周报', { fetchImpl })
  await createJob('修复项目', { fetchImpl, requirePlanApproval: true })
  await createJob('model-specific job', { fetchImpl, requirePlanApproval: true, modelName: ' context-model ' })
  await listJobs({ fetchImpl })
  await getJob('job-1', { fetchImpl })
  await cancelJob('job-1', { fetchImpl })
  await retryJob('job-1', { fetchImpl })
  await retryStep('job-1', 'step-1', { fetchImpl })

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/jobs',
    '/api/jobs',
    '/api/jobs',
    '/api/jobs',
    '/api/jobs/job-1',
    '/api/jobs/job-1/cancel',
    '/api/jobs/job-1/retry',
    '/api/jobs/job-1/steps/step-1/retry',
  ])
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: '生成周报' })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    prompt: '修复项目',
    requirePlanApproval: true,
  })
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    prompt: 'model-specific job',
    requirePlanApproval: true,
    modelName: 'context-model',
  })
})

test('HTML artifact previews use an auth header without exposing the session token in the URL', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('long-lived-secret')
  const calls = []
  try {
    const html = await loadArtifactPreviewHtml('/api/artifacts/demo.html?token=stale-secret', {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => '<!doctype html><p>safe</p>' }
      },
    })
    assert.equal(html, '<!doctype html><p>safe</p>')
    assert.equal(calls[0].url, '/api/artifacts/demo.html?preview=1')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer long-lived-secret')
    assert.doesNotMatch(calls[0].url, /token=/)
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('HTML artifact previews reject cross-origin URLs before forwarding credentials', async () => {
  let fetched = false
  await assert.rejects(
    loadArtifactPreviewHtml('https://attacker.invalid/demo.html', {
      fetchImpl: async () => { fetched = true },
    }),
    /same-origin/,
  )
  assert.equal(fetched, false)
})

test('HTML artifact previews load each private media asset once and replace markers with Blob URLs', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('asset-session-secret')
  const calls = []
  try {
    const document = await loadArtifactPreviewDocument('/api/artifacts/gallery.html?token=stale', {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        if (url === '/api/artifacts/gallery.html?preview=1') {
          return {
            ok: true,
            status: 200,
            text: async () => '<img src="gugo-asset://portrait"><div style="background:url(gugo-asset://portrait)"></div>',
          }
        }
        assert.equal(url, '/api/artifacts/gallery.html/assets/portrait')
        return { ok: true, status: 200, blob: async () => new Blob(['portrait'], { type: 'image/jpeg' }) }
      },
      createObjectUrl: (blob) => {
        assert.equal(blob.type, 'image/jpeg')
        return 'blob:gugo-portrait'
      },
    })
    assert.equal(calls.length, 2)
    assert.ok(calls.every((call) => call.init.headers.Authorization === 'Bearer asset-session-secret'))
    assert.ok(calls.every((call) => !String(call.url).includes('token=')))
    assert.equal(document.objectUrls.length, 1)
    assert.equal(document.html.match(/blob:gugo-portrait/g)?.length, 2)
    assert.doesNotMatch(document.html, /gugo-asset:\/\//)
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('subscribeToJobEvents exchanges a one-time ticket and connects with ?ticket=', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return { ok: true, status: 201, json: async () => ({ ticket: 'st_abc', expiresIn: 60 }) }
  }
  let connectedUrl = null
  class FakeES {
    constructor(url) { connectedUrl = url }
    addEventListener() {}
    close() {}
  }

  const unsubscribe = subscribeToJobEvents(() => {}, { EventSourceImpl: FakeES, fetchImpl })
  // allow the async ticket exchange to resolve
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(calls[0].url, '/api/jobs/stream-ticket')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(connectedUrl, '/api/jobs/stream?ticket=st_abc')
  // never leaks a token in the query string
  assert.ok(!String(connectedUrl).includes('token='))
  unsubscribe()
})

test('subscribeToJobEvents gets a fresh one-time ticket after the stream disconnects', async () => {
  const tickets = ['st_first', 'st_second']
  const calls = []
  const instances = []
  const timers = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { ok: true, status: 201, json: async () => ({ ticket: tickets.shift() }) }
  }
  class FakeES {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      this.closed = false
      instances.push(this)
    }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    close() { this.closed = true }
    emit(type, data = {}) { this.listeners.get(type)?.(data) }
  }

  const unsubscribe = subscribeToJobEvents(() => {}, {
    EventSourceImpl: FakeES,
    fetchImpl,
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimeoutImpl: () => {},
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  instances[0].emit('ready')
  instances[0].emit('error')

  assert.equal(instances[0].closed, true)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 1_000)
  timers[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.length, 2)
  assert.equal(instances[1].url, '/api/jobs/stream?ticket=st_second')
  unsubscribe()
})

test('subscribeToJobEvents retries ticket exchange failures without opening an unauthenticated stream', async () => {
  const calls = []
  const instances = []
  const timers = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (calls.length === 1) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 201, json: async () => ({ ticket: 'st_recovered' }) }
  }
  class FakeES {
    constructor(url) {
      this.url = url
      instances.push(this)
    }
    addEventListener() {}
    close() {}
  }

  const unsubscribe = subscribeToJobEvents(() => {}, {
    EventSourceImpl: FakeES,
    fetchImpl,
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimeoutImpl: () => {},
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(instances.length, 0)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 1_000)
  timers[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.length, 2)
  assert.equal(instances[0].url, '/api/jobs/stream?ticket=st_recovered')
  unsubscribe()
})

