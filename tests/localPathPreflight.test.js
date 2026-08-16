import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLocalPathPreflight,
  buildLocalPathEvidenceInstruction,
  buildLocalPathToolInstruction,
  extractLocalAbsolutePaths,
  isLocalPathAuthorized,
  localPathResourceType,
  resolveLocalPathResources,
  resolveLocalPathToolNames,
} from '../src/lib/localPathPreflight.js'

test('extracts quoted Windows paths including spaces without partial duplicates', () => {
  assert.deepEqual(extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 "D:\\destok\\My Project"'), ['D:\\destok\\My Project'])
})

test('keeps balanced parentheses inside Windows paths and strips sentence closers only', () => {
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 D:\\destok\\Gugo\\README.md\u3002'),
    ['D:\\destok\\Gugo\\README.md'],
  )
  assert.deepEqual(extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 D:\\demo\\README.md)'), ['D:\\demo\\README.md'])
})

test('message preflight removes explanatory authorization notes from Windows path suggestions', () => {
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 D:\\foo\uFF08\u4ECE\u672A\u6388\u6743\uFF09\u3002'),
    ['D:\\foo'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 "D:\\Reports (not authorized)."'),
    ['D:\\Reports'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u5728 D:\\gugo-pdf-fill-e2e2-20260810-1415\uFF08\u4ECE\u672A\u6388\u6743\uFF09\u4E2D\u8F93\u51FA\u586B\u5199\u540E\u7684 PDF'),
    ['D:\\gugo-pdf-fill-e2e2-20260810-1415'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u5728 D:\\draft\uFF08\u5C1A\u672A\u6388\u6743\uFF09\u4E2D\u521B\u5EFA\u6587\u4EF6'),
    ['D:\\draft'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u5728 D:\\dir\uFF08limit \u81f3\u5c11 100\uFF09\u4e2d\u521b\u5efa\u6587\u4ef6'),
    ['D:\\dir'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u67e5\u770b \\\\server\\share\\dir\uFF08limit \u81f3\u5c11 100\uFF09'),
    ['\\\\server\\share\\dir'],
  )
})

test('message preflight preserves ordinary parenthesized Windows directory names', () => {
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 "D:\\Reports\uFF082026\uFF09\u3002"'),
    ['D:\\Reports\uFF082026\uFF09'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u8bfb\u53d6 "D:\\Reports (Archive)."'),
    ['D:\\Reports (Archive)'],
  )
  assert.deepEqual(
    extractLocalAbsolutePaths('\u8bf7\u5728 "D:\\Reports\uFF082026\uFF09\u4E2D\u8F93\u51FA\u6587\u4EF6"'),
    ['D:\\Reports\uFF082026\uFF09'],
  )
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

test('an explicit permission bypass authorizes local paths without a separate file grant', () => {
  assert.equal(isLocalPathAuthorized('/any/path', {
    allFilesEnabled: false,
    bypassEnabled: true,
    grants: [],
  }, 'read_write'), true)
})

test('authorized-path instruction requires real file tool use', () => {
  const instruction = buildLocalPathToolInstruction(['D:\\destok\\money'])
  assert.match(instruction, /list_directory/)
  assert.match(instruction, /directory listing is discovery evidence/i)
  assert.match(instruction, /never infer file contents from names alone/i)
  assert.match(instruction, /must not claim/i)
  assert.match(instruction, /D:\\destok\\money/)
})

test('exact-file instructions forbid relative and parent-directory substitution', () => {
  const path = 'D:\\destok\\answer-sheet.pdf'
  const instruction = buildLocalPathToolInstruction([path], 'read_write', [{
    path,
    resourceType: 'file',
    accessMode: 'read_write',
  }])

  assert.match(instruction, /answer-sheet\.pdf \(file\)/)
  assert.match(instruction, /Never replace one with "\."/)
  assert.match(instruction, /Do not call list_directory on those files or on their parent directories/)
  assert.match(instruction, /exact-file grant cannot be used as a bash_exec working directory/i)
  assert.match(instruction, /Even for an in-place change, first call request_directory/i)
  assert.match(instruction, /access_mode "read_write"/i)
  assert.match(instruction, /file parent directory as suggested_path/i)
  assert.match(instruction, /after that directory is granted, use bash_exec/i)
})

test('resource types come from the exact authorized grant', () => {
  const filePath = 'D:\\destok\\answer-sheet.pdf'
  const directoryPath = 'D:\\destok\\project'
  const resources = resolveLocalPathResources([filePath, directoryPath], {
    grants: [
      { path: filePath, resourceType: 'file', accessMode: 'read_only', available: true },
      { path: directoryPath, resourceType: 'directory', accessMode: 'read_write', available: true },
    ],
  })

  assert.deepEqual(resources, [
    { path: filePath, resourceType: 'file', accessMode: 'read_only' },
    { path: directoryPath, resourceType: 'directory', accessMode: 'read_write' },
  ])
  assert.equal(localPathResourceType({ resources }, filePath), 'file')
  assert.equal(localPathResourceType({ resources }, `${directoryPath}\\src`), 'unknown')
})

test('authorized local paths force the minimum filesystem tools even when settings disabled them', () => {
  assert.deepEqual(resolveLocalPathToolNames([], { paths: ['D:\\destok\\money'], accessMode: 'read_only' }), [
    'list_directory', 'read_file',
  ])
  assert.deepEqual(resolveLocalPathToolNames(['web_search'], { paths: ['D:\\destok\\money'], accessMode: 'read_write' }), [
    'web_search', 'list_directory', 'read_file', 'write_file', 'edit_file', 'bash_exec',
  ])
  assert.deepEqual(resolveLocalPathToolNames([], {
    paths: ['D:\\destok\\answer-sheet.pdf'],
    accessMode: 'read_only',
    resources: [{ path: 'D:\\destok\\answer-sheet.pdf', resourceType: 'file' }],
  }), ['read_file'])
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

test('PDF no_text evidence confirms byte access without claiming authoritative content', () => {
  const unreadableMarker = 'PLACEHOLDER_MUST_NOT_BECOME_PDF_CONTENT'
  const instruction = buildLocalPathEvidenceInstruction([{
    path: 'D:\\demo\\scan.pdf',
    tool: 'read_file',
    ok: true,
    mimeType: 'application/pdf',
    extractionStatus: 'no_text',
    requiresVision: true,
    content: JSON.stringify({
      ok: true,
      path: 'D:\\demo\\scan.pdf',
      mimeType: 'application/pdf',
      extractionStatus: 'no_text',
      requiresVision: true,
      content: unreadableMarker,
    }),
  }])

  assert.match(instruction, /Access succeeded: yes/)
  assert.match(instruction, /Content extracted: no/)
  assert.match(instruction, /Requires vision: yes/)
  assert.match(instruction, /path and bytes are accessible/i)
  assert.match(instruction, /text and page layout have not been verified/i)
  assert.doesNotMatch(instruction, new RegExp(unreadableMarker))
  assert.doesNotMatch(instruction, /Extracted PDF text:/)
})

test('PDF text evidence includes explicitly extracted body', () => {
  const instruction = buildLocalPathEvidenceInstruction([{
    path: 'D:\\demo\\report.pdf',
    tool: 'read_file',
    ok: true,
    mimeType: 'application/pdf',
    extractionStatus: 'text',
    requiresVision: false,
    content: JSON.stringify({
      ok: true,
      path: 'D:\\demo\\report.pdf',
      mimeType: 'application/pdf',
      extractionStatus: 'text',
      requiresVision: false,
      content: 'Quarterly revenue grew 42%.',
    }),
  }])

  assert.match(instruction, /Content extracted: yes/)
  assert.match(instruction, /Extracted PDF text:/)
  assert.match(instruction, /Quarterly revenue grew 42%\./)
})

test('failed PDF read is not labeled verified and does not inject payload content', () => {
  const failedMarker = 'FAILED_PDF_CONTENT_MUST_NOT_ENTER_PROMPT'
  const instruction = buildLocalPathEvidenceInstruction([{
    path: 'D:\\demo\\failed.pdf',
    tool: 'read_file',
    ok: false,
    mimeType: 'application/pdf',
    extractionStatus: 'no_text',
    requiresVision: true,
    content: JSON.stringify({
      ok: false,
      code: 'PDF_READ_FAILED',
      error: 'PDF extraction failed',
      path: 'D:\\demo\\failed.pdf',
      mimeType: 'application/pdf',
      extractionStatus: 'no_text',
      requiresVision: true,
      content: failedMarker,
    }),
  }])

  assert.match(instruction, /LOCAL FILESYSTEM ACCESS PROBE/)
  assert.doesNotMatch(instruction, /VERIFIED LOCAL FILESYSTEM ACCESS/)
  assert.match(instruction, /Access succeeded: no/)
  assert.match(instruction, /PDF_READ_FAILED/)
  assert.match(instruction, /PDF extraction failed/)
  assert.doesNotMatch(instruction, new RegExp(failedMarker))
  assert.doesNotMatch(instruction, /do not answer that local access is unavailable/i)
})

test('combined local probe failure omits nested unverified content', () => {
  const nestedMarker = 'NESTED_FAILED_CONTENT_MUST_NOT_ENTER_PROMPT'
  const instruction = buildLocalPathEvidenceInstruction([{
    path: 'D:\\demo\\failed.pdf',
    tool: 'local_path_probe',
    ok: false,
    content: JSON.stringify({
      listDirectoryError: JSON.stringify({ code: 'NOT_A_DIRECTORY', error: 'not a directory' }),
      readFileError: JSON.stringify({
        code: 'PDF_READ_FAILED',
        error: 'could not extract PDF',
        content: nestedMarker,
      }),
    }),
  }])

  assert.match(instruction, /list_directory: NOT_A_DIRECTORY - not a directory/)
  assert.match(instruction, /read_file: PDF_READ_FAILED - could not extract PDF/)
  assert.doesNotMatch(instruction, new RegExp(nestedMarker))
  assert.doesNotMatch(instruction, /VERIFIED LOCAL FILESYSTEM ACCESS/)
})
