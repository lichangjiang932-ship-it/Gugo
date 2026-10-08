import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import { isBinaryChangePath } from '../../src/lib/currentFileContent.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key) => key

test('a change with no path says its content is unavailable and reads nothing', async () => {
  const dom = setupDom()
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return new Response('{}')
  }
  // react-dom/client must load after setupDom (see the JSX test bootstrap note).
  const { createRoot } = await import('react-dom/client')
  const { default: CurrentFileChange } = await import('../../src/components/CurrentFileChange.jsx')
  const root = createRoot(document.getElementById('root'))
  try {
    for (const file of [{ path: '' }, { path: '   ' }, {}, null]) {
      await act(async () => root.render(<CurrentFileChange file={file} counts={{ additions: 2, deletions: 0 }} t={t} />))
      const message = document.querySelector('[data-testid="current-file-unavailable"]')
      assert.ok(message, `no path renders the unavailable message for ${JSON.stringify(file)}`)
      assert.equal(message.textContent, 'chat.changes.currentUnavailable')
      assert.equal(document.querySelector('[data-testid="current-file-change"]'), null)
    }
    assert.deepEqual(requests, [], 'nothing is fetched without a path')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('common binary formats are not read as text', () => {
  for (const path of [
    'data/app.sqlite', 'cache.sqlite3', 'store.db', 'art/cover.psd', 'logo.ai', 'ui.sketch', 'ui.fig',
    'firmware.bin', 'blob.dat', 'disk.iso', 'App.dmg', 'setup.msi', 'app-release.apk', 'lib/app.jar',
    'Main.class', 'libfoo.so', 'libfoo.dylib', 'main.o', 'libfoo.a', 'foo.lib', '__pycache__/m.cpython-312.pyc',
    'module.wasm', 'backup.rar', 'logs.xz', 'logs.bz2', 'logs.zst', 'release.tgz', 'IMG_0001.HEIC',
    'scan.tif', 'scan.tiff', 'photo.avif', 'favicon.ico', 'clip.mkv', 'clip.avi', 'song.flac', 'song.ogg',
    'voice.m4a', 'font.eot', 'app.pdb', 'addon.node', 'assets.pak', 'deck.key', 'deck.keynote', 'sheet.numbers',
    'doc.pages', 'doc.odt', 'sheet.ods', 'deck.odp', 'C:\\Users\\me\\Desktop\\report.PDF',
  ]) {
    assert.equal(isBinaryChangePath(path), true, path)
  }
  for (const path of ['src/app.js', 'README.md', 'config.yaml', 'Makefile', 'notes', 'styles.css', 'query.sql']) {
    assert.equal(isBinaryChangePath(path), false, path)
  }
})
