import assert from 'node:assert/strict'
import test from 'node:test'

import { findToolCallArtifacts } from '../src/lib/toolCallArtifacts.js'

test('toolCallId artifacts merge with unowned artifacts explicitly named by the result', () => {
  const artifacts = [
    { id: 'direct-1', toolCallId: 'call-1', filename: 'one.txt', url: '/api/artifacts/direct-1' },
    { id: 'result-1', filename: 'two.txt', url: '/api/artifacts/result-1' },
  ]
  const matched = findToolCallArtifacts({
    id: 'call-1',
    result: JSON.stringify({ artifactId: 'result-1' }),
  }, artifacts)

  assert.deepEqual(matched.map((artifact) => artifact.id), ['direct-1', 'result-1'])
})

test('durable result artifact IDs restore associations after a snapshot reload', () => {
  const artifacts = [
    { id: 'report-1', filename: 'report.pdf', url: '/api/artifacts/report-1' },
    { id: 'preview-1', filename: 'page.png', url: '/api/artifacts/preview-1' },
    { id: 'unrelated', filename: 'report.pdf', url: '/api/artifacts/unrelated' },
  ]
  const matched = findToolCallArtifacts({
    id: 'call-2',
    result: JSON.stringify({
      artifactId: 'report-1',
      artifacts: [{ id: 'report-1' }, { id: 'preview-1' }],
    }),
  }, artifacts)

  assert.deepEqual(matched.map((artifact) => artifact.id), ['report-1', 'preview-1'])
})

test('artifact recovery never guesses by filename or crosses an explicit owner', () => {
  const sameName = { id: 'other-id', filename: 'output.txt', url: '/api/artifacts/other-id' }
  assert.deepEqual(findToolCallArtifacts({
    id: 'call-3',
    result: JSON.stringify({ ok: true, filename: 'output.txt' }),
  }, [sameName]), [])

  assert.deepEqual(findToolCallArtifacts({
    id: 'call-3',
    artifactIds: ['owned-elsewhere'],
  }, [{
    id: 'owned-elsewhere',
    toolCallId: 'call-4',
    filename: 'output.txt',
    url: '/api/artifacts/owned-elsewhere',
  }]), [])
})

test('malformed tool results do not create an artifact association', () => {
  assert.deepEqual(findToolCallArtifacts({ id: 'call-5', result: '{broken' }, [
    { id: 'artifact-5', filename: 'file.txt', url: '/api/artifacts/artifact-5' },
  ]), [])
})
