import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelJob,
  createArtifactHtmlPreviewSession,
  createLocalHtmlPreviewSession,
  createJob,
  getJob,
  loadArtifactPreviewDocument,
  loadArtifactPreviewHtml,
  listJobs,
  revokeArtifactHtmlPreviewSession,
  revokeLocalHtmlPreviewSession,
  retryJob,
  retryStep,
  subscribeToJobEvents,
  withDownloadToken,
} from '../src/lib/jobClient.js'
import { setAuthToken } from '../src/lib/accountClient.js'

test('download tokens are limited to same-origin API URLs', () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: null,
    sessionStorage: null,
    location: { origin: 'https://gugo.local' },
  }
  setAuthToken('download-session-secret')
  try {
    assert.equal(
      withDownloadToken('/api/artifacts/report.pdf#page=2'),
      '/api/artifacts/report.pdf?token=download-session-secret#page=2',
    )
    assert.equal(
      withDownloadToken('https://gugo.local/api/artifacts/report.pdf?preview=1'),
      'https://gugo.local/api/artifacts/report.pdf?preview=1&token=download-session-secret',
    )
    assert.equal(
      withDownloadToken('https://attacker.example/pixel.png'),
      'https://attacker.example/pixel.png',
    )
    assert.equal(withDownloadToken('//attacker.example/pixel.png'), '//attacker.example/pixel.png')
    assert.equal(withDownloadToken('https://gugo.local/help'), 'https://gugo.local/help')
    assert.equal(withDownloadToken('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
    assert.equal(withDownloadToken('blob:https://gugo.local/id'), 'blob:https://gugo.local/id')
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

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

test('verified local HTML exchanges account auth for a scoped relative-resource preview URL', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('local-preview-account-secret')
  const calls = []
  try {
    const previewUrl = await createLocalHtmlPreviewSession(
      '/api/local-files/verified/file-1?turnId=turn-1&preview=1&token=stale-secret',
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init })
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: '/api/local-files/previews/opaque-ticket/index.html' }),
          }
        },
      },
    )
    assert.equal(previewUrl, '/api/local-files/previews/opaque-ticket/index.html')
    assert.equal(calls[0].url, '/api/local-files/verified/file-1/preview-session?turnId=turn-1')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer local-preview-account-secret')
    assert.doesNotMatch(calls[0].url, /token=|stale-secret|local-preview-account-secret/)
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('managed HTML exchanges account auth for a scoped preview ticket without leaking tokens', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  const calls = []
  setAuthToken('artifact-preview-account-secret')
  try {
    const previewUrl = await createArtifactHtmlPreviewSession(
      '/api/artifacts/interactive.html?preview=1&token=stale-secret',
      {
        fetchImpl: async (url, init = {}) => {
          calls.push({ url, init })
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: '/api/artifacts/previews/opaque-ticket/index.html' }),
          }
        },
      },
    )
    assert.equal(previewUrl, '/api/artifacts/previews/opaque-ticket/index.html')
    assert.equal(calls[0].url, '/api/artifacts/interactive.html/preview-session')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer artifact-preview-account-secret')
    assert.doesNotMatch(calls[0].url, /token=|stale-secret|artifact-preview-account-secret/)
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('managed HTML preview tickets are revoked with account auth', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  const calls = []
  setAuthToken('artifact-preview-revoke-secret')
  try {
    await revokeArtifactHtmlPreviewSession('/api/artifacts/previews/opaque-ticket/index.html?ignored=1', {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init })
        return { ok: true, status: 204 }
      },
    })
    assert.equal(calls[0].url, '/api/artifacts/previews/opaque-ticket')
    assert.equal(calls[0].init.method, 'DELETE')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer artifact-preview-revoke-secret')
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('verified local HTML safely retries a transient 405 without changing the formal receipt URL', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('local-preview-retry-secret')
  const calls = []
  try {
    const previewUrl = await createLocalHtmlPreviewSession(
      '/api/local-files/verified/formal-gallery?turnId=turn-gallery&preview=1&token=stale-secret',
      {
        retryDelays: [0, 0],
        fetchImpl: async (url, init) => {
          calls.push({ url, init })
          if (calls.length < 3) return { ok: false, status: 405 }
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: '/api/local-files/previews/gallery-ticket/gallery.html' }),
          }
        },
      },
    )

    assert.equal(previewUrl, '/api/local-files/previews/gallery-ticket/gallery.html')
    assert.equal(calls.length, 3)
    assert.deepEqual(new Set(calls.map((call) => call.url)), new Set([
      '/api/local-files/verified/formal-gallery/preview-session?turnId=turn-gallery',
    ]))
    assert.ok(calls.every((call) => call.init.method === 'POST'))
    assert.ok(calls.every((call) => call.init.headers.Authorization === 'Bearer local-preview-retry-secret'))
    assert.ok(calls.every((call) => !call.url.includes('token=')))
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('verified local HTML does not replay ambiguous non-405 failures', async () => {
  let calls = 0
  await assert.rejects(
    createLocalHtmlPreviewSession(
      '/api/local-files/verified/formal-gallery?turnId=turn-gallery&preview=1',
      {
        retryDelays: [0, 0],
        fetchImpl: async () => {
          calls += 1
          return { ok: false, status: 503 }
        },
      },
    ),
    /local HTML preview session request failed: 503/,
  )
  assert.equal(calls, 1)
})

test('verified local HTML preserves structured non-405 preview-session errors', async () => {
  for (const scenario of [
    {
      status: 422,
      code: 'HTML_DELIVERY_RESOURCE_MISSING',
      message: '图片 images/missing.png 不存在',
      hint: '检查 HTML 中的相对路径',
    },
    {
      status: 403,
      code: 'PATH_NOT_AUTHORIZED',
      message: '目录尚未授权',
      hint: '授权 HTML 所在目录的只读访问',
    },
  ]) {
    let calls = 0
    await assert.rejects(
      createLocalHtmlPreviewSession(
        '/api/local-files/verified/formal-gallery?turnId=turn-gallery&preview=1',
        {
          retryDelays: [0, 0],
          fetchImpl: async () => {
            calls += 1
            return {
              ok: false,
              status: scenario.status,
              json: async () => ({ error: scenario }),
            }
          },
        },
      ),
      (error) => error?.statusCode === scenario.status
        && error?.code === scenario.code
        && error?.message === scenario.message
        && error?.hint === scenario.hint,
    )
    assert.equal(calls, 1)
  }
})

test('verified local HTML normalizes a trailing slash on the formal receipt URL', async () => {
  const calls = []
  const previewUrl = await createLocalHtmlPreviewSession(
    '/api/local-files/verified/formal-gallery/?sessionId=s-1&turnId=t-1&preview=1',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: '/api/local-files/previews/gallery-ticket/gallery.html' }),
        }
      },
    },
  )
  assert.equal(previewUrl, '/api/local-files/previews/gallery-ticket/gallery.html')
  assert.equal(calls[0].url, '/api/local-files/verified/formal-gallery/preview-session?sessionId=s-1&turnId=t-1')
})

test('persistent preview-session 405 reports an explicit client/server mismatch', async () => {
  const calls = []
  await assert.rejects(
    createLocalHtmlPreviewSession('/api/local-files/verified/formal-gallery?turnId=t-1', {
      retryDelays: [],
      fetchImpl: async (url) => {
        calls.push(String(url))
        if (url === '/api/health') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ kernelRevision: 'old', capabilities: {} }),
          }
        }
        return { ok: false, status: 405 }
      },
    }),
    (error) => error?.code === 'LOCAL_HTML_PREVIEW_RUNTIME_MISMATCH'
      && /版本不一致/.test(error.message),
  )
  assert.deepEqual(calls, [
    '/api/local-files/verified/formal-gallery/preview-session?turnId=t-1',
    '/api/health',
  ])
})

test('preview-session retry stops immediately when the sidebar aborts', async () => {
  const controller = new AbortController()
  let calls = 0
  const promise = createLocalHtmlPreviewSession('/api/local-files/verified/formal-gallery?turnId=t-1', {
    signal: controller.signal,
    retryDelays: [60_000],
    fetchImpl: async () => {
      calls += 1
      return { ok: false, status: 405 }
    },
  })
  controller.abort()
  await assert.rejects(promise, (error) => error?.name === 'AbortError')
  assert.equal(calls, 1)
})

test('verified local HTML preview tickets are revoked with account auth and never leak in query parameters', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('local-preview-revoke-secret')
  const calls = []
  try {
    await revokeLocalHtmlPreviewSession('/api/local-files/previews/opaque-ticket/index.html?ignored=1', {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 204 }
      },
    })
    assert.equal(calls[0].url, '/api/local-files/previews/opaque-ticket')
    assert.equal(calls[0].init.method, 'DELETE')
    assert.equal(calls[0].init.keepalive, true)
    assert.equal(calls[0].init.headers.Authorization, 'Bearer local-preview-revoke-secret')
    assert.doesNotMatch(calls[0].url, /secret|ignored/)
  } finally {
    setAuthToken('')
    globalThis.window = previousWindow
  }
})

test('HTML artifact previews embed private media by default for opaque-origin iframe compatibility', async () => {
  const document = await loadArtifactPreviewDocument('/api/artifacts/background.html', {
    fetchImpl: async (url) => {
      if (url === '/api/artifacts/background.html?preview=1') {
        return {
          ok: true,
          text: async () => '<style>body{background:url(gugo-asset://hero)}</style>',
        }
      }
      assert.equal(url, '/api/artifacts/background.html/assets/hero')
      return {
        ok: true,
        blob: async () => new Blob(['background'], { type: 'image/jpeg' }),
      }
    },
  })

  assert.match(document.html, /data:image\/jpeg;base64,/)
  assert.doesNotMatch(document.html, /(?:gugo-asset|blob):\/\//)
  assert.deepEqual(document.objectUrls, [])
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

