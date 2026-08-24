import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRetainedLocalFileReferences,
  buildVerifiedLocalFileReferences,
  localFileOpenPayload,
  mergeArtifactReferences,
  removeVerifiedLocalFilesFromRetained,
  retainedLocalFileOpenPayload,
  verifiedLocalFileOpenPayload,
} from '../src/lib/localFileReferences.js'
import { findArtifactReferenceByLocalPath } from '../src/lib/artifactReferences.js'

const target = 'D:\\workspace\\qa-second-revision-test.html'

function call(name, args, result, status = 'success') {
  return {
    name,
    arguments: JSON.stringify(args),
    result: JSON.stringify(result),
    status,
  }
}

function write(content = '<!doctype html><title>Ready</title><h1>Ready</h1>') {
  return call('write_file', { path: 'qa-second-revision-test.html', content }, {
    ok: true,
    path: target,
    changes: [{ path: target, additions: 1, deletions: 1 }],
  })
}

function read({ content = '<!doctype html><title>Ready</title><h1>Ready</h1>', path = target, offset = 0, returnedLines = 1, totalLines = 1 } = {}) {
  return call('read_file', { path: 'qa-second-revision-test.html', offset, limit: returnedLines }, {
    ok: true,
    path,
    offset,
    returnedLines,
    totalLines,
    content,
  })
}

test('verified local write becomes a clickable inline preview reference', () => {
  const source = '<!doctype html><html><head><title>Local QA</title></head><body><h1>Ready</h1></body></html>'
  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [write(source), read({ content: '<!doctype html>', returnedLines: 1, totalLines: 8 })],
    messageId: 'message-local-1',
  })

  assert.equal(reference.filename, 'qa-second-revision-test.html')
  assert.equal(reference.path, target)
  assert.equal(reference.url, '/__local-file-reference__/d%3A%2Fworkspace%2Fqa-second-revision-test.html')
  assert.equal(reference.verifiedLocalFile, true)
  assert.equal(reference.previewArtifact.content, source)
  assert.equal(reference.previewArtifact.preview.type, 'html')
  assert.equal(reference.previewArtifact.preview.filename, 'qa-second-revision-test.html')
  assert.deepEqual(reference.changeStats, { additions: 1, deletions: 1 })
  assert.equal(verifiedLocalFileOpenPayload(reference), reference.previewArtifact)
})

test('a verified local file retains the managed artifact id published by the same mutation', () => {
  const mutation = write('<h1>Current file</h1>')
  mutation.result = JSON.stringify({
    ok: true,
    path: target,
    artifactId: 'managed-snapshot-1',
    artifacts: [{
      id: 'managed-snapshot-1',
      filename: 'qa-second-revision-test.html',
      url: '/api/artifacts/qa-second-revision-test.html',
    }],
  })
  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [mutation, read({ content: '<h1>Current file</h1>' })],
  })

  assert.deepEqual(reference.relatedArtifactIds, ['managed-snapshot-1'])
})

test('edit references require a complete readback after the mutation', () => {
  const edited = call('edit_file', { path: 'qa-second-revision-test.html' }, {
    ok: true,
    path: target,
    changes: [{ path: target, additions: 1, deletions: 1 }],
  })
  assert.deepEqual(buildVerifiedLocalFileReferences({
    toolCalls: [edited, read({ content: 'first page', returnedLines: 10, totalLines: 20 })],
  }), [])

  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [edited, read({
      content: '<!doctype html><title>Complete</title><h1>Complete</h1>',
      returnedLines: 20,
      totalLines: 20,
    })],
  })
  assert.equal(reference.previewArtifact.content, '<!doctype html><title>Complete</title><h1>Complete</h1>')
  assert.equal(reference.previewArtifact.preview.type, 'html')
})

test('failed, mismatched, stale, and unverified mutations never create local links', () => {
  const other = 'D:\\workspace\\other.html'
  const failedWrite = write()
  failedWrite.status = 'error'
  failedWrite.error = 'denied'

  const cases = [
    [write()],
    [read(), write()],
    [failedWrite, read()],
    [write(), read({ path: other })],
    [write(), read(), write('<!doctype html><title>unverified newer write</title>')],
  ]
  for (const toolCalls of cases) {
    assert.deepEqual(buildVerifiedLocalFileReferences({ toolCalls }), [])
  }
})

test('same-named files in different directories keep distinct workbench identities', () => {
  const firstPath = 'D:\\workspace\\first\\index.html'
  const secondPath = 'D:\\workspace\\second\\index.html'
  const writeAt = (path, content) => call('write_file', { path, content }, {
    ok: true,
    path,
    changes: [{ path, additions: 1, deletions: 0 }],
  })
  const readAt = (path, content) => call('read_file', { path }, {
    ok: true,
    path,
    offset: 0,
    returnedLines: 1,
    totalLines: 1,
    content,
  })
  const references = buildVerifiedLocalFileReferences({
    messageId: 'same-name-turn',
    toolCalls: [
      writeAt(firstPath, '<h1>First</h1>'),
      readAt(firstPath, '<h1>First</h1>'),
      writeAt(secondPath, '<h1>Second</h1>'),
      readAt(secondPath, '<h1>Second</h1>'),
    ],
  })

  assert.equal(references.length, 2)
  assert.equal(references[0].filename, 'index.html')
  assert.equal(references[1].filename, 'index.html')
  assert.notEqual(references[0].identity, references[1].identity)
  assert.notEqual(references[0].previewArtifact.artifactIdentity, references[1].previewArtifact.artifactIdentity)
})

test('an unmatched absolute path never falls back to a same-named file', () => {
  const approved = {
    id: 'approved-report',
    filename: 'report.pdf',
    path: 'C:\\approved\\report.pdf',
    url: '/api/local-files/verified/approved-report?turnId=turn-1',
  }

  assert.equal(findArtifactReferenceByLocalPath(
    [approved],
    'D:\\different\\report.pdf',
  ), null)
  assert.equal(findArtifactReferenceByLocalPath(
    [approved],
    'C:\\approved\\report.pdf',
  ), approved)
})

test('a complete readback wins over stale write arguments', () => {
  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [
      write('<h1>requested</h1>'),
      read({ content: '<h1>actual file</h1>', returnedLines: 1, totalLines: 1 }),
    ],
  })

  assert.equal(reference.previewArtifact.content, '<h1>actual file</h1>')
})

test('declared command outputs use executor-reported changedPaths', () => {
  const generated = '<!doctype html><title>Generated</title><h1>Generated</h1>'
  const command = call('bash_exec', {
    command: 'python generate_page.py',
    expected_outputs: [target],
  }, {
    ok: true,
    exitCode: 0,
    changedPaths: [target],
  })

  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [
      command,
      read({ content: generated, returnedLines: 1, totalLines: 1 }),
    ],
    messageId: 'command-generated-page',
  })

  assert.equal(reference.path, target)
  assert.equal(reference.previewArtifact.content, generated)

  assert.deepEqual(buildVerifiedLocalFileReferences({
    toolCalls: [
      call('bash_exec', {
        command: 'python generate_page.py',
        expected_outputs: [target],
      }, {
        ok: true,
        exitCode: 0,
        changedPaths: [],
      }),
      read({ content: generated, returnedLines: 1, totalLines: 1 }),
    ],
  }), [])
})

test('patch_file revisions become clickable after readback and dry runs stay unlinked', () => {
  const patched = call('patch_file', {
    path: target,
    start_line: 1,
    end_line: 1,
    replacement: '<h1>Patched</h1>',
  }, {
    ok: true,
    path: target,
    beforeSha256: 'before',
    afterSha256: 'after',
  })
  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [patched, read({ content: '<h1>Patched</h1>' })],
  })
  assert.equal(reference.path, target)

  const previewOnly = call('patch_file', {
    path: target,
    dry_run: true,
  }, {
    ok: true,
    dryRun: true,
    path: target,
  })
  assert.deepEqual(buildVerifiedLocalFileReferences({
    toolCalls: [previewOnly, read({ content: '<h1>Unchanged</h1>' })],
  }), [])
})

test('persisted receipts open the authenticated real-file URL without embedding file content', () => {
  const [reference] = buildVerifiedLocalFileReferences({
    messageId: 'turn-receipt:assistant',
    turnId: 'turn-receipt',
    verifiedLocalFiles: [{
      id: 'receipt-123',
      path: target,
      filename: 'qa-second-revision-test.html',
      size: 12_345,
      verifiedAt: 123,
    }],
    toolCalls: [{
      name: 'read_file',
      status: 'success',
      result: '{"ok":true,"content":"this legacy body must be ignored"}',
    }],
  })

  assert.equal(reference.path, target)
  assert.equal(reference.url, '/api/local-files/verified/receipt-123?turnId=turn-receipt')
  assert.equal(reference.previewArtifact.content, '')
  assert.equal(reference.previewArtifact.preview, null)
  assert.deepEqual(reference.previewArtifact.directFile, {
    id: 'receipt-123',
    filename: 'qa-second-revision-test.html',
    title: 'qa-second-revision-test.html',
    type: 'html',
    url: '/api/local-files/verified/receipt-123?turnId=turn-receipt',
    path: target,
    size: 12_345,
    summary: '12345 bytes',
  })
})

test('structured change stats aggregate per path and deduplicate restored tool calls by id', () => {
  const secondPath = 'D:\\workspace\\second-output.js'
  const mutation = (id, name, changes) => ({
    id,
    ...call(name, { path: target }, { ok: true, path: target, changes }),
  })
  const repeatedEdit = mutation('edit-target', 'edit_file', [
    { path: target, additions: 3, deletions: 2 },
  ])
  const toolCalls = [
    mutation('write-both', 'write_file', [
      { path: target, additions: 2, deletions: 1 },
      { path: secondPath, additions: 4, deletions: 0 },
    ]),
    repeatedEdit,
    { ...repeatedEdit },
    mutation('edit-target-again', 'edit_file', [
      { path: target, additions: 3, deletions: 2 },
    ]),
  ]
  const receipts = [{
    id: 'first-receipt',
    path: target,
    filename: 'qa-second-revision-test.html',
  }, {
    id: 'second-receipt',
    path: secondPath,
    filename: 'second-output.js',
  }]

  const references = buildVerifiedLocalFileReferences({
    toolCalls,
    verifiedLocalFiles: receipts,
    turnId: 'change-stats-turn',
  })
  const byPath = new Map(references.map((reference) => [reference.path, reference]))
  assert.deepEqual(byPath.get(target).changeStats, { additions: 8, deletions: 5 })
  assert.deepEqual(byPath.get(secondPath).changeStats, { additions: 4, deletions: 0 })

  const [retained] = buildRetainedLocalFileReferences({
    toolCalls,
    retainedLocalFiles: [receipts[0]],
    turnId: 'change-stats-turn',
  })
  assert.deepEqual(retained.changeStats, { additions: 8, deletions: 5 })
})

test('invalid, failed, and dry-run change data never produces change stats', () => {
  const invalidJsonCall = {
    id: 'invalid-json',
    name: 'edit_file',
    arguments: JSON.stringify({ path: target }),
    result: '{not-json',
    status: 'success',
  }
  const invalidChanges = [
    { id: 'failed', status: 'error', args: {}, result: { ok: true, path: target, changes: [{ path: target, additions: 1, deletions: 1 }] } },
    { id: 'dry-run', args: { path: target, dry_run: true }, result: { ok: true, path: target, changes: [{ path: target, additions: 1, deletions: 1 }] } },
    { id: 'negative', args: {}, result: { ok: true, path: target, changes: [{ path: target, additions: -1, deletions: 0 }] } },
    { id: 'fractional', args: {}, result: { ok: true, path: target, changes: [{ path: target, additions: 1, deletions: 0.5 }] } },
    { id: 'string-count', args: {}, result: { ok: true, path: target, changes: [{ path: target, additions: '1', deletions: 0 }] } },
    { id: 'missing-count', args: {}, result: { ok: true, path: target, changes: [{ path: target, additions: 1 }] } },
    { id: 'missing-path', args: {}, result: { ok: true, path: target, changes: [{ additions: 1, deletions: 0 }] } },
    { id: 'missing-changes', args: {}, result: { ok: true, path: target } },
  ].map(({ id, status = 'success', args, result }) => ({
    id,
    ...call('edit_file', args, result, status),
  }))

  const [reference] = buildVerifiedLocalFileReferences({
    toolCalls: [invalidJsonCall, ...invalidChanges],
    verifiedLocalFiles: [{
      id: 'invalid-stats-receipt',
      path: target,
      filename: 'qa-second-revision-test.html',
    }],
    turnId: 'invalid-stats-turn',
  })

  assert.equal(Object.hasOwn(reference, 'changeStats'), false)
})

test('retained mutation receipts stay previewable without claiming verification', () => {
  const [reference] = buildRetainedLocalFileReferences({
    messageId: 'retained-turn:assistant',
    turnId: 'retained-turn',
    retainedLocalFiles: [{
      id: 'retained receipt/1',
      path: target,
      filename: 'qa-second-revision-test.html',
      size: 4096,
      retainedAt: 456,
    }],
  })

  assert.equal(
    reference.url,
    '/api/local-files/retained/retained%20receipt%2F1?turnId=retained-turn',
  )
  assert.equal(reference.retainedLocalFile, true)
  assert.equal(reference.verificationPending, true)
  assert.equal(Object.hasOwn(reference, 'verifiedLocalFile'), false)
  assert.equal(reference.previewArtifact.retainedLocalFile, true)
  assert.equal(reference.previewArtifact.verificationPending, true)
  assert.equal(reference.previewArtifact.directFile.retainedLocalFile, true)
  assert.equal(reference.previewArtifact.directFile.verificationPending, true)
  assert.equal(verifiedLocalFileOpenPayload(reference), null)
  assert.equal(retainedLocalFileOpenPayload(reference), reference.previewArtifact)
  assert.equal(localFileOpenPayload(reference), reference.previewArtifact)
})

test('verified files supersede retained files by receipt id or canonical path', () => {
  const unrelated = {
    id: 'retained-unrelated',
    path: 'D:\\workspace\\other.html',
    filename: 'other.html',
  }
  const retained = [{
    id: 'same-id',
    path: 'D:\\workspace\\old-name.html',
    filename: 'old-name.html',
  }, {
    id: 'old-path-id',
    path: 'D:\\Workspace\\nested\\..\\REPORT.HTML',
    filename: 'REPORT.HTML',
  }, unrelated]
  const verified = [{
    id: 'same-id',
    path: 'D:\\workspace\\renamed.html',
    filename: 'renamed.html',
  }, {
    id: 'new-path-id',
    path: 'd:/workspace/report.html',
    filename: 'report.html',
  }]

  assert.deepEqual(removeVerifiedLocalFilesFromRetained(retained, verified), [unrelated])
})

test('artifact reference merge renders only the verified link after an in-place upgrade', () => {
  const retained = buildRetainedLocalFileReferences({
    messageId: 'upgrade:assistant',
    turnId: 'upgrade',
    retainedLocalFiles: [{
      id: 'retained-id',
      path: 'D:\\Workspace\\REPORT.HTML',
      filename: 'REPORT.HTML',
    }],
  })
  const verified = buildVerifiedLocalFileReferences({
    messageId: 'upgrade:assistant',
    turnId: 'upgrade',
    verifiedLocalFiles: [{
      id: 'verified-id',
      path: 'd:/workspace/report.html',
      filename: 'report.html',
    }],
  })

  const references = mergeArtifactReferences({
    retainedLocalFileReferences: retained,
    verifiedLocalFileReferences: verified,
  })
  assert.equal(references.length, 1)
  assert.equal(references[0].verifiedLocalFile, true)
  assert.equal(references[0].id, 'local-file:verified-id')
})
