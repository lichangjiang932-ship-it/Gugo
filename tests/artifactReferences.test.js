import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
