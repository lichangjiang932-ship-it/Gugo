import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBrowserUrl } from '../src/pages/ChatSplit/rightWorkbench/rightWorkbenchLayout.js'

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
