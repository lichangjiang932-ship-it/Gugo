import assert from 'node:assert/strict'
import test from 'node:test'
import { canViewDirectFileSource, loadDirectFileSource } from '../src/lib/directFileSource.js'

test('source preview is available only for readable text formats, not Office or opaque binaries', () => {
  for (const filename of ['notes.md', 'index.html', 'chart.svg', 'code.ts', 'data.json', 'table.csv', 'plain.txt']) {
    assert.equal(canViewDirectFileSource({ filename }), true, filename)
  }
  for (const filename of ['report.pdf', 'sheet.xlsx', 'deck.pptx', 'doc.docx', 'binary.exe']) {
    assert.equal(canViewDirectFileSource({ filename }), false, filename)
  }
})

test('HTML source uses the current identity in headers, removes stale URL tokens and never renders content', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { origin: 'http://localhost' },
    localStorage: { getItem: () => 'synthetic-current-token' },
  }
  const source = '<script>not executed</script>\n<h1>source stays exact</h1>'
  const requests = []
  try {
    const text = await loadDirectFileSource({
      file: { filename: 'index.html' }, url: '/api/local-files/verified/file?turnId=turn&token=expired&preview=1',
      fetchImpl: async (url, init) => { requests.push({ url, init }); return new Response(source) },
    })
    assert.equal(text, source)
    assert.equal(requests[0].url, '/api/local-files/verified/file?turnId=turn&preview=1')
    assert.deepEqual(requests[0].init.headers, { Authorization: 'Bearer synthetic-current-token' })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('cross-origin and inline sources never receive local identity headers', async () => {
  const requests = []
  for (const url of ['https://example.invalid/report.md', 'data:text/plain,inline', 'blob:http://localhost/source']) {
    await loadDirectFileSource({ file: { filename: 'report.md' }, url,
      fetchImpl: async (input, init) => { requests.push({ input, init }); return new Response('# Source') },
    })
    assert.equal(requests.at(-1).input, url)
    assert.deepEqual(requests.at(-1).init.headers, {})
  }
})

test('source preview distinguishes permissions, missing files and oversized responses', async () => {
  for (const [status, code] of [[401, 'SOURCE_PREVIEW_DENIED'], [403, 'SOURCE_PREVIEW_DENIED'], [404, 'SOURCE_PREVIEW_MISSING'], [503, 'SOURCE_PREVIEW_FAILED']]) {
    await assert.rejects(loadDirectFileSource({ file: { filename: 'report.md' }, url: '/report',
      fetchImpl: async () => new Response('', { status }),
    }), { code })
  }
  for (const response of [
    new Response('short', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(loadDirectFileSource({ file: { filename: 'report.md' }, url: '/report', fetchImpl: async () => response }), { code: 'SOURCE_PREVIEW_TOO_LARGE' })
  }
})

test('source rejects unsafe URL protocols, embedded credentials and unsupported types before fetch', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return new Response('must not fetch') }
  for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'https://user:pass@example.invalid/source']) {
    await assert.rejects(loadDirectFileSource({ file: { filename: 'note.txt' }, url, fetchImpl }), { code: 'SOURCE_PREVIEW_DENIED' })
  }
  await assert.rejects(loadDirectFileSource({ file: { filename: 'binary.exe' }, url: '/binary', fetchImpl }), { code: 'SOURCE_PREVIEW_UNSUPPORTED' })
  assert.equal(calls, 0)
})
