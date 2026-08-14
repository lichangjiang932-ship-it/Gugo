import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildArtifactReferenceIdentity,
  buildMessageArtifactPreview,
  buildServerArtifactReferences,
  findArtifactReferenceByLocalPath,
  normalizeArtifactLocalPath,
  normalizeArtifactReferenceType,
} from '../src/lib/artifactReferences.js'

test('artifact references normalize file extensions and attach matching previews', () => {
  assert.equal(normalizeArtifactReferenceType({ filename: 'demo.htm' }), 'html')
  assert.equal(normalizeArtifactReferenceType({ type: '.md', filename: 'notes.bin' }), 'text')

  const references = buildServerArtifactReferences({
    artifacts: [{ id: 'a1', filename: 'calculator.html', url: '/api/artifacts/a1' }],
    content: '<!doctype html><title>Calculator</title>',
    messageId: 'message-1',
    preview: { type: 'html', filename: 'generated.html', label: 'HTML' },
  })

  assert.equal(references.length, 1)
  assert.equal(references[0].type, 'html')
  assert.equal(references[0].previewArtifact.preview.filename, 'calculator.html')
  assert.equal(references[0].previewArtifact.messageId, 'message-1')
})

test('unmatched generated files still produce a stable direct-file reference', () => {
  const [reference] = buildServerArtifactReferences({
    artifacts: [{ filename: 'archive.zip', url: '/api/artifacts/archive' }],
    messageId: 'message-2',
    preview: { type: 'html', filename: 'page.html' },
  })

  assert.equal(reference.type, 'zip')
  assert.equal(reference.previewArtifact, null)
  assert.equal(reference.id, '/api/artifacts/archive')
})

test('artifact identity stays stable across streamed preview and persisted server artifact objects', () => {
  const streamedIdentity = buildArtifactReferenceIdentity({
    filename: 'calculator.html',
    messageId: 'message-1',
    type: 'html',
  })
  const [persisted] = buildServerArtifactReferences({
    artifacts: [{ id: 'server-file-9', filename: 'calculator.html', type: 'html', url: '/api/artifacts/server-file-9' }],
    messageId: 'message-1',
    preview: { type: 'html', filename: 'calculator.html' },
  })

  assert.equal(persisted.identity, streamedIdentity)
  assert.equal(persisted.previewArtifact.artifactIdentity, streamedIdentity)
})

test('failed managed file turns never turn narration into fake previews', () => {
  for (const [skillId, artifactType] of [
    ['webpage', 'html'],
    ['ppt', 'pptx'],
    ['doc', 'docx'],
    ['excel', 'xlsx'],
  ]) {
    assert.equal(buildMessageArtifactPreview({
      role: 'assistant',
      content: 'The file was not created. Copy this answer into a new file yourself.',
      meta: { skillId, artifactType, failed: true, streaming: false },
    }), null, `${artifactType} failure text must not become an artifact`)
  }
})

test('managed file skill aliases cannot turn failure prose into previews', () => {
  for (const skillId of ['html', 'website', 'write-doc', 'analyze-excel', 'ppt-master']) {
    assert.equal(buildMessageArtifactPreview({
      role: 'assistant',
      content: 'Generation failed. Copy this text into a file yourself.',
      meta: { skillId },
    }), null, `${skillId} must require verifiable artifact evidence`)
  }
})

test('managed file labels require real source or persisted bytes', () => {
  assert.equal(buildMessageArtifactPreview({
    role: 'assistant',
    content: 'Save the code above as landing-page.html.',
    meta: { skillId: 'webpage', artifactType: 'html' },
  }), null)

  const rawHtml = buildMessageArtifactPreview({
    role: 'assistant',
    content: '<!doctype html><html><head><title>Landing</title></head><body><main>Ready</main></body></html>',
    meta: { skillId: 'webpage', artifactType: 'html' },
  })
  assert.equal(rawHtml.type, 'html')
  assert.equal(rawHtml.inferred, true)

  const sourcedDoc = buildMessageArtifactPreview({
    role: 'assistant',
    content: 'The document is ready.',
    meta: {
      skillId: 'doc',
      artifactType: 'docx',
      artifactSource: '# Report\n\n## Result\n\nComplete.',
    },
  })
  assert.equal(sourcedDoc.type, 'docx')
})

test('artifact source previews obey live, failure, and explicit delivery boundaries', () => {
  const artifactSource = '<!doctype html><html><body>Draft</body></html>'
  const baseMessage = {
    role: 'assistant',
    content: 'The page is ready.',
    meta: { artifactType: 'html', artifactTitle: 'Draft', artifactSource },
  }

  assert.equal(buildMessageArtifactPreview({
    ...baseMessage,
    meta: { ...baseMessage.meta, streaming: true },
  }), null)
  assert.equal(buildMessageArtifactPreview({
    ...baseMessage,
    meta: { ...baseMessage.meta, failed: true },
  }), null)
  assert.equal(buildMessageArtifactPreview({
    ...baseMessage,
    meta: {
      ...baseMessage.meta,
      serverArtifacts: [{ id: 'draft', filename: 'draft.html', type: 'html', url: '/api/artifacts/draft' }],
      serverDeliveryArtifactIds: [],
    },
  }), null)

  const selected = buildMessageArtifactPreview({
    ...baseMessage,
    meta: {
      ...baseMessage.meta,
      serverArtifacts: [{ id: 'final', filename: 'final.html', type: 'html', url: '/api/artifacts/final' }],
      serverDeliveryArtifactIds: ['final'],
    },
  })
  assert.equal(selected.type, 'html')
})

test('absolute Windows paths resolve only to a unique registered artifact', () => {
  const reference = {
    id: 'execution-check',
    filename: 'execution-check-2.txt',
    title: 'execution-check.txt',
    url: '/api/artifacts/execution-check',
  }

  assert.equal(
    normalizeArtifactLocalPath('file:///D:/Gugo/output/../output/execution-check.txt'),
    'd:/gugo/output/execution-check.txt',
  )
  assert.equal(
    findArtifactReferenceByLocalPath([reference], 'D:\\Gugo\\output\\execution-check.txt'),
    reference,
  )
  assert.equal(
    findArtifactReferenceByLocalPath([reference], 'D:/Gugo/output/unregistered.txt'),
    null,
  )
  assert.equal(
    findArtifactReferenceByLocalPath([{ ...reference, url: '' }], 'D:/Gugo/output/execution-check.txt'),
    null,
  )
})

test('duplicate artifact basenames require a matching normalized full path', () => {
  const first = {
    id: 'first-report',
    filename: 'report.pdf',
    fullPath: 'D:\\first\\report.pdf',
    url: '/api/artifacts/first-report',
  }
  const second = {
    id: 'second-report',
    filename: 'report.pdf',
    fullPath: 'D:\\second\\report.pdf',
    url: '/api/artifacts/second-report',
  }

  assert.equal(findArtifactReferenceByLocalPath([first, second], 'd:/FIRST/./report.pdf'), first)
  assert.equal(findArtifactReferenceByLocalPath([first, second], 'D:\\other\\report.pdf'), null)
})
