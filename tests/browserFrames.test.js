import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeBrowserFrameEvaluationParams,
  activeBrowserFrameSessionId,
  flattenBrowserFrameTree,
  listBrowserFrames,
  switchBrowserFrameContext,
} from '../server/adapters/browserFrameAutomation.js'
import { _browserInternals } from '../server/adapters/browserAutomation.js'

function oopifSession() {
  const requests = []
  const targets = [
    { type: 'iframe', targetId: 'foreign', parentFrameId: 'other-page', url: 'https://other.example/' },
    { type: 'iframe', targetId: 'remote', parentFrameId: 'main-frame', url: 'https://frame.example/' },
  ]
  return { requests, targets, session: {
    sessionId: null, discoverFrameTargets: true,
    client: { async request(method, params, sessionId) {
      requests.push({ method, params, sessionId })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: frameTree().frame } }
      if (method === 'Target.getTargets') return { targetInfos: targets }
      if (method === 'Target.attachToTarget') return { sessionId: 'remote-session' }
      if (method === 'Page.createIsolatedWorld') {
        assert.equal(sessionId, 'remote-session')
        return { executionContextId: 72 }
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'frame text' } }
      return {}
    } },
  } }
}

test('OOPIF discovery includes only descendants of the current page and routes DOM calls through its session', async () => {
  const { session, requests } = oopifSession()
  const listing = await listBrowserFrames(session)
  assert.deepEqual(listing.frames.map((frame) => frame.frameId), ['main-frame', 'remote'])
  await switchBrowserFrameContext(session, { frameId: 'remote', authorizeFrame: (frame) => {
    assert.equal(frame.url, 'https://frame.example/')
    assert.equal(requests.some((request) => request.method === 'Target.attachToTarget'), false)
  } })
  assert.equal(activeBrowserFrameSessionId(session), 'remote-session')
  assert.equal(await _browserInternals.evaluate(session, 'document.body.innerText'), 'frame text')
  assert.equal(requests.at(-1).sessionId, 'remote-session')
  assert.equal(requests.at(-1).params.contextId, 72)
  await _browserInternals.evaluate(session, 'document.title', null, { mainFrame: true })
  assert.equal(requests.at(-1).sessionId, null)
  assert.equal(requests.at(-1).params.contextId, undefined)
  await switchBrowserFrameContext(session, { frameId: 'main-frame' })
  assert.equal(activeBrowserFrameSessionId(session), null)
})

test('unauthorized and unrelated OOPIF targets cannot be attached', async () => {
  const { session, requests } = oopifSession()
  await assert.rejects(switchBrowserFrameContext(session, { frameId: 'remote',
    authorizeFrame: () => { throw new Error('denied') } }), /denied/u)
  await assert.rejects(switchBrowserFrameContext(session, { frameId: 'foreign' }),
    (error) => error.code === 'BROWSER_FRAME_NOT_FOUND')
  assert.equal(requests.some((request) => request.method === 'Target.attachToTarget'), false)
})

test('OOPIF navigation invalidates both the execution context and protocol session route', async () => {
  const { session, targets } = oopifSession()
  await switchBrowserFrameContext(session, { frameId: 'remote' })
  targets[1].url = 'https://changed.example/'
  const listing = await listBrowserFrames(session)
  assert.equal(listing.frameContextActive, false)
  assert.equal(activeBrowserFrameSessionId(session), null)
  assert.equal(session.activeFrameContextId, null)
})

test('OOPIF target metadata cannot authorize against a stale in-process frame URL', async () => {
  const { session } = oopifSession()
  const request = session.client.request
  session.client.request = (method, ...args) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: frameTree().frame, childFrames: [{ frame: { id: 'remote', url: 'https://old.example/' } }] } }
    : request(method, ...args)
  const listing = await listBrowserFrames(session)
  assert.equal(listing.frames.find((frame) => frame.frameId === 'remote').url, 'https://frame.example/')
  await assert.rejects(switchBrowserFrameContext(session, { frameId: 'remote', authorizeFrame: (frame) => {
    assert.equal(frame.url, 'https://frame.example/')
    throw new Error('new origin denied')
  } }), /new origin denied/u)
})

test('a detached OOPIF session is discarded so an explicit retry attaches afresh', async () => {
  const { session, requests } = oopifSession()
  const request = session.client.request
  let failed = false
  session.client.request = (method, ...args) => {
    if (method === 'Page.createIsolatedWorld' && !failed) { failed = true; throw new Error('session detached') }
    return request(method, ...args)
  }
  await assert.rejects(switchBrowserFrameContext(session, { frameId: 'remote' }), /session detached/u)
  assert.equal(session.frameTargetSessions.size, 0)
  await switchBrowserFrameContext(session, { frameId: 'remote' })
  assert.equal(requests.filter((entry) => entry.method === 'Target.attachToTarget').length, 2)
})

function frameTree() {
  return {
    frame: {
      id: 'main-frame', url: 'https://app.example.test/', securityOrigin: 'https://app.example.test',
      mimeType: 'text/html',
    },
    childFrames: [{
      frame: {
        id: 'cross-frame', parentId: 'main-frame', name: 'checkout',
        url: 'https://payments.example.test/', securityOrigin: 'https://payments.example.test',
        mimeType: 'text/html',
      },
      childFrames: [{
        frame: {
          id: 'nested-frame', parentId: 'cross-frame', name: 'nested',
          url: 'about:blank', securityOrigin: 'https://payments.example.test', mimeType: 'text/html',
        },
      }],
    }],
  }
}

test('browser frame trees are bounded and retain explicit lineage metadata', () => {
  const projected = flattenBrowserFrameTree(frameTree())
  assert.equal(projected.truncated, false)
  assert.deepEqual(projected.frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    depth: frame.depth,
    main: frame.main,
    url: frame.url,
  })), [
    {
      frameId: 'main-frame', parentFrameId: null, depth: 0, main: true,
      url: 'https://app.example.test/',
    },
    {
      frameId: 'cross-frame', parentFrameId: 'main-frame', depth: 1, main: false,
      url: 'https://payments.example.test/',
    },
    {
      frameId: 'nested-frame', parentFrameId: 'cross-frame', depth: 2, main: false,
      url: 'about:blank',
    },
  ])
  const bounded = flattenBrowserFrameTree(frameTree(), { maxFrames: 2, maxDepth: 1 })
  assert.equal(bounded.frames.length, 2)
  assert.equal(bounded.truncated, true)
})

test('frame switching creates an isolated context and subsequent DOM evaluation uses it', async () => {
  const requests = []
  const authorized = []
  const session = {
    sessionId: null,
    activeFrameId: null,
    activeFrameContextId: null,
    activeFrameUrl: '',
    mainFrameId: null,
    client: {
      async request(method, params) {
        requests.push({ method, params })
        if (method === 'Page.getFrameTree') return { frameTree: frameTree() }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 }
        if (method === 'Runtime.evaluate') return { result: { value: { title: 'Cross frame' } } }
        return {}
      },
    },
  }
  const selected = await switchBrowserFrameContext(session, {
    frameId: 'cross-frame',
    authorizeFrame: async (frame) => { authorized.push(frame.url) },
  })
  assert.equal(selected.frameId, 'cross-frame')
  assert.deepEqual(authorized, ['https://payments.example.test/'])
  assert.equal(session.activeFrameContextId, 42)
  assert.deepEqual(activeBrowserFrameEvaluationParams(session), { contextId: 42 })
  await _browserInternals.evaluate(session, 'document.title')
  assert.deepEqual(requests.find((request) => request.method === 'Runtime.evaluate').params, {
    expression: 'document.title',
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    contextId: 42,
  })

  await switchBrowserFrameContext(session, { frameId: 'main-frame' })
  assert.equal(session.activeFrameId, 'main-frame')
  assert.equal(session.activeFrameContextId, null)
  assert.deepEqual(activeBrowserFrameEvaluationParams(session), {})
})

test('failed frame context creation preserves the previously authorized active frame', async () => {
  const session = {
    sessionId: null,
    activeFrameId: 'nested-frame',
    activeFrameContextId: 17,
    activeFrameUrl: 'about:blank',
    mainFrameId: 'old-main',
    client: {
      async request(method) {
        if (method === 'Page.getFrameTree') return { frameTree: frameTree() }
        throw new Error('isolated world unavailable')
      },
    },
  }
  await assert.rejects(
    switchBrowserFrameContext(session, { frameId: 'cross-frame' }),
    /isolated world unavailable/,
  )
  assert.equal(session.activeFrameId, 'nested-frame')
  assert.equal(session.activeFrameContextId, 17)
  assert.equal(session.activeFrameUrl, 'about:blank')
})

test('frame authorization denial occurs before isolated-world creation and preserves context', async () => {
  const methods = []
  const session = {
    sessionId: null,
    activeFrameId: 'main-frame',
    activeFrameContextId: null,
    activeFrameUrl: 'https://app.example.test/',
    mainFrameId: 'main-frame',
    client: {
      async request(method) {
        methods.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: frameTree() }
        throw new Error(`unexpected CDP method: ${method}`)
      },
    },
  }
  await assert.rejects(
    switchBrowserFrameContext(session, {
      frameId: 'cross-frame',
      authorizeFrame: () => { throw new Error('connected app is not authorized') },
    }),
    /not authorized/,
  )
  assert.deepEqual(methods, ['Page.getFrameTree'])
  assert.equal(session.activeFrameId, 'main-frame')
  assert.equal(session.activeFrameContextId, null)
})

test('frame navigation invalidates the old isolated context before another DOM action', async () => {
  const navigated = frameTree()
  navigated.childFrames[0].frame.url = 'https://mail.google.com/mail/u/0/'
  navigated.childFrames[0].frame.securityOrigin = 'https://mail.google.com'
  const session = {
    sessionId: null,
    activeFrameId: 'cross-frame',
    activeFrameContextId: 42,
    activeFrameUrl: 'https://payments.example.test/',
    mainFrameId: 'main-frame',
    client: { request: async () => ({ frameTree: navigated }) },
  }
  const result = await listBrowserFrames(session)
  assert.equal(result.activeFrameId, 'cross-frame')
  assert.equal(result.activeFrameUrl, 'https://mail.google.com/mail/u/0/')
  assert.equal(result.frameContextActive, false)
  assert.equal(session.activeFrameContextId, null)
  assert.deepEqual(activeBrowserFrameEvaluationParams(session), {})
})

test('frame listing resets a stale context when the selected frame disappeared', async () => {
  const session = {
    sessionId: null,
    activeFrameId: 'removed-frame',
    activeFrameContextId: 99,
    activeFrameUrl: 'https://removed.example.test/',
    mainFrameId: null,
    client: { request: async () => ({ frameTree: frameTree() }) },
  }
  const result = await listBrowserFrames(session)
  assert.equal(result.activeFrameId, 'main-frame')
  assert.equal(result.frames.find((frame) => frame.main).active, true)
  assert.equal(session.activeFrameId, null)
  assert.equal(session.activeFrameContextId, null)
  assert.equal(session.mainFrameId, 'main-frame')
})
