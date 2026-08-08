import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildArtifactReferenceIdentity,
  buildMessageArtifactPreview,
  buildServerArtifactReferences,
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
