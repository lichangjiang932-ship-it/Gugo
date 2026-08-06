import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  isLoopbackHostname,
  isSafeExternalUrl,
  isTrustedNavigation,
  resolveDesktopDevUrl,
} from '../desktop/security.js'
import {
  DEFAULT_DESKTOP_PORT,
  resolveDesktopDataPaths,
  resolveDesktopPluginRoots,
  resolveDesktopPort,
} from '../desktop/runtime.js'

test('desktop dev URL only accepts loopback HTTP origins', () => {
  assert.equal(resolveDesktopDevUrl('http://127.0.0.1:5175'), 'http://127.0.0.1:5175/')
  assert.equal(resolveDesktopDevUrl('http://localhost:5175/path'), 'http://localhost:5175/path')
  assert.equal(resolveDesktopDevUrl('https://example.com'), null)
  assert.equal(resolveDesktopDevUrl('file:///tmp/index.html'), null)
})

test('desktop loopback detection covers IPv4 and IPv6 without trusting wildcards', () => {
  assert.equal(isLoopbackHostname('127.12.4.9'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('0.0.0.0'), false)
  assert.equal(isLoopbackHostname('192.168.1.20'), false)
})

test('desktop navigation stays on the exact application origin', () => {
  const origin = 'http://127.0.0.1:43123'
  assert.equal(isTrustedNavigation(`${origin}/settings`, origin), true)
  assert.equal(isTrustedNavigation('http://127.0.0.1:43124/', origin), false)
  assert.equal(isTrustedNavigation('https://example.com/', origin), false)
  assert.equal(isTrustedNavigation('javascript:alert(1)', origin), false)
})

test('external links only allow HTTP and HTTPS', () => {
  assert.equal(isSafeExternalUrl('https://github.com/'), true)
  assert.equal(isSafeExternalUrl('https://user:secret@example.com/'), false)
  assert.equal(isSafeExternalUrl('mailto:test@example.com'), false)
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32'), false)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
})

test('desktop runtime keeps a stable valid port and isolated data paths', () => {
  assert.equal(resolveDesktopPort(), DEFAULT_DESKTOP_PORT)
  assert.equal(resolveDesktopPort('6200'), 6200)
  assert.equal(resolveDesktopPort('0'), DEFAULT_DESKTOP_PORT)
  assert.equal(resolveDesktopPort('70000'), DEFAULT_DESKTOP_PORT)
  assert.deepEqual(resolveDesktopDataPaths('C:/Users/test/AppData/Roaming/Gugo'), {
    dataDir: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data'),
    database: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data/app.db'),
    artifacts: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data/artifacts'),
  })
})

test('desktop plugin discovery only returns existing, de-duplicated roots', () => {
  const existing = new Set([
    path.resolve('D:/destok/codex-plugins').toLowerCase(),
    path.resolve('C:/Users/test/codex-plugins').toLowerCase(),
  ])
  const roots = resolveDesktopPluginRoots({
    configured: JSON.stringify(['D:/destok/codex-plugins', 'D:/DESTOK/codex-plugins']),
    homeDir: 'C:/Users/test',
    platform: 'win32',
    existsSync: (candidate) => existing.has(path.resolve(candidate).toLowerCase()),
  })
  assert.deepEqual(roots, [
    path.resolve('D:/destok/codex-plugins'),
    path.resolve('C:/Users/test/codex-plugins'),
  ])
})
