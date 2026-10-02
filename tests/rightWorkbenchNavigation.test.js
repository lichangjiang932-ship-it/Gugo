import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBrowserUrl } from '../src/lib/browserUrlPolicy.js'

test('workbench navigation accepts HTTP(S) websites and explicit localhost ports', () => {
  for (const [input, expected] of [
    ['example.com/docs', 'https://example.com/docs'],
    [' https://example.com/a?q=1#section ', 'https://example.com/a?q=1#section'],
    ['http://localhost:8080/', 'http://localhost:8080/'],
    ['localhost:8080', 'https://localhost:8080/'],
    ['127.0.0.1:8080/demo', 'https://127.0.0.1:8080/demo'],
  ]) assert.equal(normalizeBrowserUrl(input), expected, input)
})

test('workbench navigation never disguises local paths, credentials or other schemes as websites', () => {
  for (const input of [
    'file:///C:/reports/result.html', 'FILE:///tmp/report.pdf',
    'C:\\reports\\result.html', 'C:/reports/result.html', 'C:result.html',
    '\\\\server\\share\\report.pdf', '//server/share/report.pdf',
    '/home/alice/result.html', './reports/result.html', '../result.html', '~/result.html',
    'javascript:alert(1)', 'data:text/html,hello', 'blob:https://example.com/id',
    'vscode://file/C:/reports/result.html', 'ftp://example.com/file',
    'https://alice:secret@example.com/', 'alice:secret@example.com',
    'https://example.com\\private', 'https://example.com/\nnext', '', 'https://',
  ]) assert.equal(normalizeBrowserUrl(input), '', input)
})

test('the address bar reads input the way a browser does', async () => {
  const { resolveBrowserInput, BROWSER_SEARCH_URL } = await import('../src/lib/browserUrlPolicy.js')
  for (const [input, expected] of [
    // A dev server speaks http: https://localhost:5173 just fails to connect.
    ['localhost:5173', 'http://localhost:5173/'],
    ['localhost', 'http://localhost/'],
    ['127.0.0.1:8080/demo', 'http://127.0.0.1:8080/demo'],
    ['192.168.1.20:3000', 'http://192.168.1.20:3000/'],
    ['example.com/docs', 'https://example.com/docs'],
    ['https://localhost:8443/', 'https://localhost:8443/'],
  ]) assert.deepEqual(resolveBrowserInput(input), { kind: 'url', url: expected }, input)
  // Words are a search, not an "invalid address" error.
  assert.deepEqual(resolveBrowserInput('react useEffect cleanup'),
    { kind: 'search', url: `${BROWSER_SEARCH_URL}react%20useEffect%20cleanup` })
  assert.equal(resolveBrowserInput('vite').kind, 'search')
  // What the strict policy refuses is never turned into a search either.
  for (const input of ['file:///C:/a.html', 'C:\\a.html', 'javascript:alert(1)', 'https://alice:secret@example.com/',
    'alice:secret@example.com', '~/notes.md', 'https://']) {
    assert.equal(resolveBrowserInput(input).kind, 'refused', input)
  }
  assert.equal(resolveBrowserInput('  ').kind, 'empty')
})
