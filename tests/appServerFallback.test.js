import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'

function createStaticFixture() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-app-fallback-'))
  fs.writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><body>gugo-spa-shell</body></html>',
  )
  return staticDir
}

test('unknown API paths return JSON 404 without disabling the SPA fallback', async (t) => {
  const staticDir = createStaticFixture()
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    staticDir,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(staticDir, { recursive: true, force: true })
  })

  const origin = `http://127.0.0.1:${server.address().port}`
  for (const requestPath of [
    '/api/billing/packages',
    '/api/unknown-endpoint?source=regression',
    '/api',
  ]) {
    const response = await fetch(`${origin}${requestPath}`)
    const rawBody = await response.text()

    assert.equal(response.status, 404, requestPath)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(JSON.parse(rawBody), {
      error: {
        code: 'API_NOT_FOUND',
        message: 'API endpoint not found',
      },
    })
    assert.doesNotMatch(rawBody, /gugo-spa-shell/)
  }

  const spaResponse = await fetch(`${origin}/settings/models?tab=providers`)
  const spaHtml = await spaResponse.text()
  assert.equal(spaResponse.status, 200)
  assert.equal(spaResponse.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.match(spaHtml, /gugo-spa-shell/)
})
