import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-browser-frame-auth-'))
process.env.APP_DATA_DIR = root

const { closeDb, createUser } = await import('../server/db.js')
const { upsertIntegration } = await import('../server/services/integrationsStore.js')
const { _browserToolExecutorInternals } = await import('../server/services/browserToolExecutor.js')

const userId = 'browser-frame-auth-owner'
createUser({ id: userId, email: 'browser-frame-auth@example.test' })

const frameResult = {
  activeFrameId: 'main-frame',
  truncated: false,
  frames: [
    {
      frameId: 'main-frame', parentFrameId: null, depth: 0, main: true, active: true,
      name: '', url: 'https://example.com/', securityOrigin: 'https://example.com', mimeType: 'text/html',
    },
    {
      frameId: 'gmail-frame', parentFrameId: 'main-frame', depth: 1, main: false, active: false,
      name: 'mail', url: 'https://mail.google.com/mail/u/0/',
      securityOrigin: 'https://mail.google.com', mimeType: 'text/html',
    },
  ],
}

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('cross-origin connected-app frames are redacted until the current user connects them', async () => {
  const hidden = _browserToolExecutorInternals.projectAuthorizedBrowserFrames(userId, frameResult)
  assert.equal(hidden.frames[0].url, 'https://example.com/')
  assert.deepEqual(hidden.frames[1], {
    frameId: 'gmail-frame',
    parentFrameId: 'main-frame',
    depth: 1,
    main: false,
    active: false,
    restricted: true,
    name: 'Restricted connected-app frame',
    url: '',
    securityOrigin: '',
    mimeType: '',
  })
  assert.throws(
    () => _browserToolExecutorInternals.browserUrlAuthorized(
      userId,
      'https://mail.google.com/mail/u/0/',
    ),
    /not connected or is disabled/,
  )
  await assert.rejects(
    _browserToolExecutorInternals.assertActiveBrowserFrameAccess(
      userId,
      {},
      {
        framesImpl: async () => ({
          ...frameResult,
          activeFrameId: 'gmail-frame',
          activeFrameUrl: 'https://mail.google.com/mail/u/0/',
          frameContextActive: true,
        }),
      },
    ),
    /not connected or is disabled/,
  )
  await assert.rejects(
    _browserToolExecutorInternals.assertActiveBrowserFrameAccess(
      userId,
      {},
      {
        framesImpl: async () => ({
          activeFrameId: 'public-child',
          activeFrameUrl: 'https://example.com/',
          frameContextActive: false,
          frames: [{
            frameId: 'public-child', parentFrameId: 'main-frame', depth: 1,
            main: false, active: true, url: 'https://example.com/',
          }],
        }),
      },
    ),
    (error) => error?.code === 'BROWSER_FRAME_CONTEXT_STALE' && error?.statusCode === 409,
  )

  const integration = upsertIntegration({
    userId,
    provider: 'web_gmail',
    name: 'Gmail',
    enabled: true,
    config: { connectionMode: 'persistent_browser' },
    secret: {},
  })
  assert.equal(integration.kind, 'browser_app')
  const visible = _browserToolExecutorInternals.projectAuthorizedBrowserFrames(userId, frameResult)
  assert.equal(visible.frames[1].restricted, undefined)
  assert.equal(visible.frames[1].url, 'https://mail.google.com/mail/u/0/')
  assert.equal(
    _browserToolExecutorInternals.browserUrlAuthorized(
      userId,
      'https://mail.google.com/mail/u/0/',
    ),
    true,
  )
})
