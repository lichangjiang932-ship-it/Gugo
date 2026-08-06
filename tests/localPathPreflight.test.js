import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLocalPathPreflight,
  buildLocalPathEvidenceInstruction,
  buildLocalPathToolInstruction,
  extractLocalAbsolutePaths,
  isLocalPathAuthorized,
  resolveLocalPathToolNames,
} from '../src/lib/localPathPreflight.js'

test('extracts quoted Windows paths including spaces without partial duplicates', () => {
  assert.deepEqual(extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 "D:\\destok\\My Project"'), ['D:\\destok\\My Project'])
})

test('keeps balanced parentheses inside Windows paths and strips sentence closers only', () => {
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 D:\\destok\\your-model-atelier(1)\\README.md\u3002'),
    ['D:\\destok\\your-model-atelier(1)\\README.md'],
  )
  assert.deepEqual(extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 D:\\demo\\README.md)'), ['D:\\demo\\README.md'])
})

test('extracts UNC and common Unix absolute paths while ignoring URLs and relative paths', () => {
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bfb\u53d6 \\\\server\\share\\repo \u548c /home/user/repo\uff0c\u5ffd\u7565 https://example.com/a \u548c src/app.js'),
    ['\\\\server\\share\\repo', '/home/user/repo'],
  )
})

test('preflight requires access intent and chooses least required mode', () => {
  assert.deepEqual(buildLocalPathPreflight('\u793a\u4f8b D:\\demo\\repo'), { paths: [], accessMode: 'read_only' })
  assert.deepEqual(buildLocalPathPreflight('\u8bf7\u8bfb\u53d6 D:\\demo\\repo'), {
    paths: ['D:\\demo\\repo'], accessMode: 'read_only',
  })
  assert.deepEqual(buildLocalPathPreflight('\u8bf7\u4fee\u6539 D:\\demo\\repo\\src\\app.js'), {
    paths: ['D:\\demo\\repo\\src\\app.js'], accessMode: 'read_write',
  })
})

test('preflight recognizes the exact read wording shown in the UI report', () => {
  assert.deepEqual(buildLocalPathPreflight('\u4f60\u80fd\u9605\u8bfb"D:\\destok\\money"\u8fd9\u4e2a\u9879\u76ee\u5417'), {
    paths: ['D:\\destok\\money'], accessMode: 'read_only',
  })
})

test('authorized directory covers descendants and respects read-write mode', () => {
  const status = {
    allFilesEnabled: false,
    grants: [{ path: 'D:\\destok\\money', resourceType: 'directory', accessMode: 'read_only', available: true }],
  }
  assert.equal(isLocalPathAuthorized('d:\\DESTOK\\money\\src\\app.js', status), true)
  assert.equal(isLocalPathAuthorized('D:\\destok\\money2', status), false)
  assert.equal(isLocalPathAuthorized('D:\\destok\\money\\src', status, 'read_write'), false)
})

test('file grants require exact matches and all-files bypasses individual grants', () => {
  const status = { grants: [{ path: '/tmp/a.txt', resourceType: 'file', accessMode: 'read_write', available: true }] }
  assert.equal(isLocalPathAuthorized('/tmp/a.txt', status, 'read_write'), true)
  assert.equal(isLocalPathAuthorized('/tmp/a.txt/child', status), false)
  assert.equal(isLocalPathAuthorized('/any/path', { allFilesEnabled: true }, 'read_write'), true)
})

test('authorized-path instruction requires real file tool use', () => {
  const instruction = buildLocalPathToolInstruction(['D:\\destok\\money'])
  assert.match(instruction, /list_directory/)
  assert.match(instruction, /directory listing is discovery evidence/i)
  assert.match(instruction, /never infer file contents from names alone/i)
  assert.match(instruction, /must not claim/i)
  assert.match(instruction, /D:\\destok\\money/)
})

test('authorized local paths force the minimum filesystem tools even when settings disabled them', () => {
  assert.deepEqual(resolveLocalPathToolNames([], { paths: ['D:\\destok\\money'], accessMode: 'read_only' }), [
    'list_directory', 'read_file',
  ])
  assert.deepEqual(resolveLocalPathToolNames(['web_search'], { paths: ['D:\\destok\\money'], accessMode: 'read_write' }), [
    'web_search', 'list_directory', 'read_file', 'write_file', 'edit_file',
  ])
})

test('verified filesystem evidence forbids unsupported local-access claims', () => {
  const instruction = buildLocalPathEvidenceInstruction([{
    path: 'D:\\destok\\money', tool: 'list_directory', ok: true, content: '{"entries":[{"name":"README.md"}]}',
  }])
  assert.match(instruction, /VERIFIED LOCAL FILESYSTEM ACCESS/)
  assert.match(instruction, /README\.md/)
  assert.match(instruction, /Do not answer that local access is unavailable/)
  assert.match(instruction, /call read_file for representative documentation/i)
  assert.match(instruction, /do not guess from filenames/i)
})
