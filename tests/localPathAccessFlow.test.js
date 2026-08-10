import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLocalFilePreviewArtifact,
  createLocalPathAccessEnsurer,
  createLocalPathAccessProbe,
} from '../src/lib/localPathAccessFlow.js'
import { buildServerToolsConfig } from '../src/pages/ChatSplit/serverTurnFlow.js'

test('successful read probe becomes a visible, bounded local-file preview', () => {
  const artifact = buildLocalFilePreviewArtifact([{
    path: 'D:\\demo\\README.md',
    tool: 'read_file',
    ok: true,
    content: JSON.stringify({
      path: 'D:\\demo\\README.md',
      content: '# Hello\nworld',
      returnedLines: 2,
      totalLines: 5,
    }),
  }], { messageId: 'turn-1:assistant' })

  assert.equal(artifact.messageId, 'turn-1:assistant')
  assert.equal(artifact.content, '# Hello\nworld')
  assert.deepEqual(artifact.preview, {
    type: 'text',
    title: 'README.md',
    label: 'FILE',
    summary: '2/5 lines',
    filename: 'README.md',
    path: 'D:\\demo\\README.md',
    truncated: true,
  })
})

test('PDF no_text probe preserves extraction metadata without creating a readable preview', async () => {
  const path = 'D:\\demo\\scan.pdf'
  const probe = createLocalPathAccessProbe('zh', {
    execute: async (call) => call.name === 'list_directory'
      ? { ok: false, content: JSON.stringify({ error: 'not a directory' }) }
      : {
          ok: true,
          content: JSON.stringify({
            ok: true,
            path,
            mimeType: 'application/pdf',
            extractionStatus: 'no_text',
            requiresVision: true,
            content: '[PDF bytes available; no readable text extracted]',
          }),
        },
  })

  const [result] = await probe({ paths: [path], accessMode: 'read_only' })

  assert.equal(result.ok, true)
  assert.equal(result.mimeType, 'application/pdf')
  assert.equal(result.extractionStatus, 'no_text')
  assert.equal(result.requiresVision, true)
  assert.equal(buildLocalFilePreviewArtifact([result]), null)
})

test('PDF text probe keeps extracted body in a typed text preview', () => {
  const path = 'D:\\demo\\report.pdf'
  const artifact = buildLocalFilePreviewArtifact([{
    path,
    tool: 'read_file',
    ok: true,
    mimeType: 'application/pdf',
    extractionStatus: 'text',
    requiresVision: false,
    content: JSON.stringify({
      ok: true,
      path,
      mimeType: 'application/pdf',
      extractionStatus: 'text',
      requiresVision: false,
      content: 'Quarterly revenue grew 42%.',
      returnedLines: 1,
      totalLines: 1,
      truncated: true,
    }),
  }], { messageId: 'turn-pdf:assistant' })

  assert.equal(artifact.content, 'Quarterly revenue grew 42%.')
  assert.deepEqual(artifact.preview, {
    type: 'text',
    title: 'report.pdf',
    label: 'PDF',
    summary: '1 lines (truncated)',
    filename: 'report.pdf',
    path,
    truncated: true,
    mimeType: 'application/pdf',
    extractionStatus: 'text',
    requiresVision: false,
  })
})

test('conflicting PDF extraction metadata fails closed', () => {
  const path = 'D:\\demo\\conflict.pdf'
  const artifact = buildLocalFilePreviewArtifact([{
    path,
    tool: 'read_file',
    ok: true,
    mimeType: 'application/pdf',
    extractionStatus: 'text',
    requiresVision: false,
    content: JSON.stringify({
      ok: true,
      path,
      mimeType: 'application/pdf',
      extractionStatus: 'no_text',
      requiresVision: true,
      content: 'This must not be previewed.',
    }),
  }])

  assert.equal(artifact, null)
})

test('conflicting non-PDF success flags do not create a preview', () => {
  const path = 'D:\\demo\\failed.txt'
  const artifact = buildLocalFilePreviewArtifact([{
    path,
    tool: 'read_file',
    ok: true,
    content: JSON.stringify({
      ok: false,
      path,
      content: 'This failed payload must not be previewed.',
    }),
  }])

  assert.equal(artifact, null)
})

test('directory probes open a bounded text preview while failed reads remain hidden', () => {
  const artifact = buildLocalFilePreviewArtifact([{
    path: 'D:\\demo',
    tool: 'list_directory',
    ok: true,
    content: JSON.stringify({
      path: 'D:\\demo',
      total: 3,
      truncated: false,
      entries: [
        { name: 'src', type: 'directory', size: null },
        { name: 'README.md', type: 'file', size: 120 },
        { name: '.git', type: 'directory', size: null },
      ],
    }),
  }], { messageId: 'turn-dir:assistant' })

  assert.equal(artifact.messageId, 'turn-dir:assistant')
  assert.match(artifact.content, /\[DIR \] src/)
  assert.match(artifact.content, /\[FILE\] README\.md {2}120 bytes/)
  assert.deepEqual(artifact.preview, {
    type: 'text',
    title: 'demo',
    label: 'DIR',
    summary: '3 entries',
    filename: 'demo-listing.txt',
    path: 'D:\\demo',
    truncated: false,
  })
  assert.equal(buildLocalFilePreviewArtifact([{ tool: 'list_directory', ok: true, content: '{}' }]), null)
  assert.equal(buildLocalFilePreviewArtifact([{ tool: 'read_file', ok: false, content: '{}' }]), null)
})

test('local path probes time out quickly without waiting for a stuck executor', async () => {
  const probe = createLocalPathAccessProbe('zh', {
    execute: async () => new Promise(() => {}),
    timeoutMs: 15,
  })
  const startedAt = Date.now()
  const [result] = await probe({ paths: ['D:\\stuck'], accessMode: 'read_only' })

  assert.equal(result.ok, false)
  assert.equal(JSON.parse(result.content).code, 'LOCAL_PATH_PROBE_TIMEOUT')
  assert.ok(Date.now() - startedAt < 1000)
})

test('authorization failures stop probing without opening a second read attempt', async () => {
  const calls = []
  const probe = createLocalPathAccessProbe('zh', {
    execute: async (call, options) => {
      calls.push({ call, options })
      return { ok: false, content: JSON.stringify({ code: 'PATH_NOT_AUTHORIZED' }) }
    },
  })
  const [result] = await probe({ paths: ['D:\\locked'], accessMode: 'read_only' })

  assert.equal(result.ok, false)
  assert.equal(result.tool, 'list_directory')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].call.name, 'list_directory')
  assert.equal(calls[0].options.suppressDirectoryApproval, true)
  assert.ok(calls[0].options.signal instanceof AbortSignal)
})

test('local path probes honor the active turn abort signal', async () => {
  const controller = new AbortController()
  const probe = createLocalPathAccessProbe('zh', {
    execute: async (_call, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
    timeoutMs: 1000,
  })
  const pending = probe({ paths: ['D:\\cancelled'], accessMode: 'read_only' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('a stalled access-status lookup cannot block the inline approval card', async () => {
  const approvals = []
  let statusSignal = null
  const ensureAccess = createLocalPathAccessEnsurer(async (request) => {
    approvals.push(request)
    return { approved: true, path: request.path, accessMode: 'read_only', resourceType: 'directory' }
  }, {
    getAccessStatus: async ({ signal }) => {
      statusSignal = signal
      return new Promise(() => {})
    },
    statusTimeoutMs: 15,
  })

  const startedAt = Date.now()
  const access = await ensureAccess('\u9605\u8bfb "D:\\stuck"')

  assert.equal(access.proceed, true)
  assert.deepEqual(access.paths, ['D:\\stuck'])
  assert.equal(approvals.length, 1)
  assert.ok(statusSignal instanceof AbortSignal)
  assert.equal(statusSignal.aborted, true)
  assert.ok(Date.now() - startedAt < 1000)
})

test('a fresh chat authorizes, reads, enables least-privilege tools, and opens the file preview', async () => {
  const path = 'D:\\destok\\Gugo\\README.md'
  const approvals = []
  const ensureAccess = createLocalPathAccessEnsurer(async (request) => {
    approvals.push(request)
    return { approved: true, path, accessMode: 'read_only', resourceType: 'file' }
  }, {
    getAccessStatus: async () => ({ allFilesEnabled: false, grants: [] }),
  })

  const access = await ensureAccess(`请阅读 ${path}`)
  assert.equal(access.proceed, true)
  assert.deepEqual(access.paths, [path])
  assert.deepEqual(approvals, [{
    path,
    suggestGrantPath: path,
    requiredAccessMode: 'read_only',
    source: 'message_preflight',
  }])
  assert.deepEqual(buildServerToolsConfig({
    list_directory: false,
    read_file: false,
    write_file: false,
    edit_file: false,
  }, access), {
    enabled: ['read_file'],
    disabled: ['edit_file', 'list_directory', 'write_file'],
  })

  const calls = []
  const probe = createLocalPathAccessProbe('zh', {
    execute: async (call) => {
      calls.push(call)
      return {
        ok: true,
        content: JSON.stringify({ path, content: '# Fresh chat', returnedLines: 1, totalLines: 1 }),
      }
    },
  })
  const artifact = buildLocalFilePreviewArtifact(await probe(access), { messageId: 'fresh:assistant' })
  assert.deepEqual(calls.map((call) => call.name), ['read_file'])
  assert.equal(JSON.parse(calls[0].arguments).path, path)
  assert.equal(artifact.messageId, 'fresh:assistant')
  assert.equal(artifact.preview.path, path)
  assert.equal(artifact.preview.title, 'README.md')
  assert.equal(artifact.content, '# Fresh chat')
})
