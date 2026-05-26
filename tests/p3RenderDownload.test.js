/**
 * P3 \u6d4b\u8bd5 \u00b7 \u771f PPT \u6e32\u67d3 + \u4e0b\u8f7d + \u5fae\u4ea4\u4e92
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { probeRenderer, renderPptxPage, _testReset, _testStats } from '../server/services/artifactRender.js'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const fixture = new URL('../test-fixtures/sample.pptx', import.meta.url).pathname

/* \u2500\u2500\u2500\u2500\u2500\u2500 1\uff5e3: artifactRender \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 probeRenderer \u8fd4 libreoffice + pdftoppm \u8def\u5f84', async () => {
  _testReset()
  const probe = await probeRenderer()
  assert.equal(typeof probe.available, 'boolean')
  if (probe.available) {
    assert.ok(probe.libreoffice && fs.existsSync(probe.libreoffice), 'libreoffice \u8def\u5f84\u5b58\u5728')
    assert.ok(probe.pdftoppm && fs.existsSync(probe.pdftoppm), 'pdftoppm \u8def\u5f84\u5b58\u5728')
  }
})

test('P3 renderPptxPage \u80fd\u6e32\u67d3 sample.pptx \u7b2c 1 \u9875 \u4e3a PNG', { timeout: 60000 }, async (t) => {
  const probe = await probeRenderer()
  if (!probe.available) {
    t.skip('libreoffice / pdftoppm \u672a\u88c5')
    return
  }
  _testReset()
  // \u590d\u5236 fixture \u5230 tmp, \u907f\u514d\u6c61\u67d3 worktree
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-render-'))
  const tmpPptx = path.join(tmpDir, 'sample.pptx')
  fs.copyFileSync(fixture, tmpPptx)
  try {
    const buf = await renderPptxPage({ srcPath: tmpPptx, page: 1 })
    assert.ok(Buffer.isBuffer(buf), '\u8fd4 Buffer')
    assert.ok(buf.length > 100, 'PNG > 100 byte')
    // PNG signature
    assert.deepEqual(Array.from(buf.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'PNG \u9b54\u6570')
    // \u540c key \u518d\u8c03\u8d70\u7f13\u5b58 (\u4e0d\u62a5\u9519, \u8fd4\u540c buf)
    const buf2 = await renderPptxPage({ srcPath: tmpPptx, page: 1 })
    assert.equal(buf.length, buf2.length)
    // \u7f13\u5b58\u7d22\u5f15 1 \u9879
    const stats = _testStats()
    assert.ok(stats.entries >= 1)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    _testReset()
  }
})

test('P3 renderPptxPage \u8d85\u9875\u62a5 page out of range', { timeout: 60000 }, async (t) => {
  const probe = await probeRenderer()
  if (!probe.available) { t.skip(); return }
  _testReset()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-render-'))
  const tmpPptx = path.join(tmpDir, 'sample.pptx')
  fs.copyFileSync(fixture, tmpPptx)
  try {
    await assert.rejects(
      () => renderPptxPage({ srcPath: tmpPptx, page: 999 }),
      /page out of range/,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    _testReset()
  }
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 4: server \u8def\u7531\u6ce8\u518c \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 server /api/artifacts/:file/render \u8def\u7531\u63a5\u5165', () => {
  const app = read('../server/appServer.js')
  assert.match(app, /handleArtifactRender/)
  assert.ok(app.includes('\\/api\\/artifacts\\/[^/?#]+\\/render'), 'appServer \u6709 render \u5224\u522b')

  const svc = read('../server/services/artifactGen.js')
  assert.match(svc, /export async function handleArtifactRender/)
  // \u63a2\u6d4b\u4e0d\u53ef\u7528 \u2192 503
  assert.match(svc, /503[\s\S]{0,200}renderer unavailable/)
  // .pptx \u9650\u5b9a
  assert.match(svc, /only pptx rendering supported/)
  // page \u8303\u56f4\u68c0\u67e5
  assert.match(svc, /page < 1 \|\| page > 500/)
  // \u8d85\u5927 50MB
  assert.match(svc, /RENDER_MAX_BYTES\s*=\s*50/)
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 5: artifactRender \u5b9e\u73b0\u9632\u5fa1 \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 artifactRender \u6709 timeout + LRU + per-render \u72ec\u7acb profile', () => {
  const src = read('../server/services/artifactRender.js')
  // timeout
  assert.match(src, /LIBRE_TIMEOUT_MS/)
  assert.match(src, /SIGKILL/)
  assert.match(src, /timeout after \$\{timeoutMs\}ms/)
  // LRU
  assert.match(src, /evictUntilFits/)
  assert.match(src, /CACHE_MAX_BYTES/)
  assert.match(src, /200 \* 1024 \* 1024/)
  // \u72ec\u7acb profile \u907f\u514d\u5e76\u53d1\u9501
  assert.match(src, /UserInstallation=file:\/\//)
  // \u540c\u6e90\u53bb\u91cd
  assert.match(src, /inflight\.set/)
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 6\uff5e7: ArtifactPane \u63a5\u5165 render + \u4e0b\u8f7d \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 ArtifactPane HEAD \u63a2\u6d4b /render \u8def\u7531 + <img> \u52a0\u8f7d', () => {
  const src = read('../src/components/ArtifactPane.jsx')
  // HEAD \u63a2\u6d4b
  assert.match(src, /method:\s*'HEAD'/)
  assert.match(src, /\/render\?page=1/)
  // \u72b6\u6001\u673a
  assert.match(src, /renderAvail/)
  assert.match(src, /canRender/)
  // <img> \u5143\u7d20
  assert.match(src, /<img\b/)
  assert.match(src, /Thumb/)
  assert.match(src, /BigSlide/)
  // \u9aa8\u67b6\u5c4f
  assert.match(src, /p0-shimmer/)
  // token \u6ce8 query (img \u4e0d\u80fd\u5e26 Authorization \u5934)
  assert.match(src, /token/)
})

test('P3 ArtifactPane \u4e0b\u8f7d\u6309\u94ae\u8d70 window.location \u52a0 token', () => {
  const src = read('../src/components/ArtifactPane.jsx')
  assert.match(src, /handleDownload/)
  assert.match(src, /window\.location\.href/)
  // \u8d70 /api/artifacts/:file (\u4e0d\u52a0 /slides /render \u540e\u7f00)
  assert.match(src, /`\/api\/artifacts\/\$\{encodeURIComponent\(file\)\}\$\{params\.toString/)
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 8: tokens.css \u5fae\u4ea4\u4e92 \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 tokens.css \u52a0 p0-cursor / p0-shimmer + prefers-reduced-motion', () => {
  const src = read('../src/styles/tokens.css')
  // \u95ea\u70c1\u5149\u6807 \u2014 \u6696\u6a59 2px \u00d7 1em \u00d7 0.8s blink
  assert.match(src, /p0-cursor/)
  assert.match(src, /p0BlinkCursor/)
  assert.match(src, /0\.8s/)
  assert.match(src, /background:\s*var\(--p0-accent\)/)
  assert.match(src, /width:\s*2px/)
  // shimmer \u8d70 transform translateX (\u4e0d\u52a8 width/left)
  assert.match(src, /p0Shimmer/)
  assert.match(src, /translateX\(-100%\)/)
  assert.match(src, /translateX\(100%\)/)
  // prefers-reduced-motion \u7981\u52a8
  assert.match(src, /prefers-reduced-motion/)
  assert.match(src, /\.p0-cursor\s*\{\s*animation:\s*none/)
  // data-animations="false" \u4e5f\u7981
  assert.match(src, /data-animations="false"/)
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 9: ChatMessages \u6d41\u5f0f\u5149\u6807 + \u9608\u503c \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 ChatMessages \u6d41\u5f0f\u5149\u6807\u6362 p0-cursor + \u8d34\u5e95\u9608\u503c 60px', () => {
  const src = read('../src/pages/ChatSplit/ChatMessages.jsx')
  // \u65b0\u5149\u6807 class
  assert.match(src, /className="p0-cursor"/)
  // \u65e7\u7684 bg-ember/80 animate-pulse \u4e0d\u518d\u51fa\u73b0 (\u5728\u6d41\u5f0f\u5206\u652f)
  assert.ok(!/bg-ember\/80 ml-0\.5 align-middle animate-pulse/.test(src), '\u4e0d\u5e94\u518d\u6709\u65e7\u5149\u6807')
  // \u9608\u503c 60px
  assert.match(src, /distance < 60/)
  // \u4e0d\u518d\u662f 80
  assert.ok(!/distance < 80/.test(src), '\u65e7 80px \u9608\u503c\u5e94\u63d0\u9ad8\u5230 60')
})

/* \u2500\u2500\u2500\u2500\u2500\u2500 10: ChatSplit \u4e0b\u8f7d\u6587\u6848 + onDownload \u4f20\u5165 \u2500\u2500\u2500\u2500\u2500\u2500 */

test('P3 ChatSplit onDownload \u4e0d\u518d\u662f \u201c\u7559\u7ed9 P3 \u63a5\u5165\u201d stub', () => {
  const src = read('../src/pages/ChatSplit/index.jsx')
  assert.ok(!/\u4e0b\u8f7d\u7559\u7ed9 P3 \u63a5\u5165/.test(src), 'P3 \u540e stub \u6587\u6848\u5e94\u6e05')
  assert.match(src, /\u6b63\u5728\u4e0b\u8f7d/)
})
