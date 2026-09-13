import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnEvent } from '../shared/turnEvents.js'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { artifactReferenceOpenPayload, buildServerArtifactReferences } from '../src/lib/artifactReferences.js'

test('single-artifact tool result preserves previewRevision through client dispatch and opening', async () => {
  const artifacts = []
  const revision = 'a'.repeat(64)
  const result = { ok: true, artifactId: 'same-pptx', filename: 'deck.pptx', url: '/api/artifacts/deck.pptx', previewRevision: revision }
  await dispatchTurnEvent(createTurnEvent({
    id: 'styled-pptx-completed', sessionId: 's', turnId: 't', sequence: 1, type: 'tool.completed', createdAt: 1,
    payload: { toolCallId: 'pptx-call', name: 'create_pptx', artifactId: result.artifactId, result },
  }), { dispatch: () => {}, taskId: 'task', onArtifact: (artifact) => artifacts.push(artifact) })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].previewRevision, revision)
  const [reference] = buildServerArtifactReferences({ artifacts, messageId: 'message' })
  const opened = artifactReferenceOpenPayload(reference, 'message')
  assert.equal(opened.directFile.previewRevision, revision)
  assert.equal(opened.directFile.url, result.url)
  assert.equal(opened.directFile.id, result.artifactId)
})

test('legacy artifact results without a revision keep their original shape', async () => {
  const artifacts = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'legacy-file-completed', sessionId: 's', turnId: 't', sequence: 1, type: 'tool.completed', createdAt: 1,
    payload: { toolCallId: 'doc-call', name: 'create_docx', result: {
      ok: true, artifactId: 'document', filename: 'document.docx', url: '/api/artifacts/document.docx',
    } },
  }), { dispatch: () => {}, taskId: 'task', onArtifact: (artifact) => artifacts.push(artifact) })
  assert.deepEqual(artifacts, [{ id: 'document', filename: 'document.docx', url: '/api/artifacts/document.docx', name: 'create_docx', toolCallId: 'doc-call' }])
})
