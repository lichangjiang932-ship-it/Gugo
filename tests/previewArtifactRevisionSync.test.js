import assert from 'node:assert/strict'
import test from 'node:test'
import { appendServerArtifact } from '../src/lib/serverArtifactRevisions.js'
import { artifactReferenceOpenPayload } from '../src/lib/artifactReferences.js'
import { reducer } from '../src/store/appReducer.js'

const original = { id: 'pptx-1', filename: 'deck.pptx', type: 'pptx', url: '/api/artifacts/deck.pptx', previewRevision: 'a'.repeat(64), title: 'Original' }
const revised = { ...original, previewRevision: 'b'.repeat(64) }

function initialState({ open = true } = {}) {
  const state = {
    sessions: [{ id: 'session-1', serverRevision: 5, messages: [
      { id: 'original-message', role: 'assistant', content: 'Original file', meta: {
        serverTurnId: 'turn-1', serverLastSequence: 3, streaming: false, serverArtifacts: [original],
      } },
      { id: 'revision-message', role: 'assistant', content: '', meta: {
        serverTurnId: 'turn-2', serverLastSequence: 1, streaming: true, serverArtifacts: [],
      } },
    ] }], activeSessionId: 'session-1', previewArtifact: null, previewTabs: [], previewActiveId: '',
  }
  return open ? reducer(state, { type: 'OPEN_PREVIEW_ARTIFACT', payload: artifactReferenceOpenPayload(original, 'original-message') }) : state
}

const revise = (revision = revised) => ({
  type: 'UPDATE_LAST_MESSAGE_META', sessionId: 'session-1', messageId: 'revision-message',
  serverTurnId: 'turn-2', serverSequence: 2, payload: { serverArtifacts: [revision] },
})

test('normal and resume streams share revision-aware same-id upsert while legacy duplicate behavior stays intact', () => {
  const artifacts = []
  const updates = []
  const dispatch = (type, payload) => updates.push({ type, payload })
  assert.equal(appendServerArtifact(original, artifacts, dispatch), true)
  assert.equal(appendServerArtifact({ ...original }, artifacts, dispatch), false)
  assert.equal(appendServerArtifact({ id: original.id, previewRevision: revised.previewRevision }, artifacts, dispatch), true)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].previewRevision, revised.previewRevision)
  assert.equal(artifacts[0].filename, original.filename)
  assert.equal(artifacts[0].url, original.url)
  assert.equal(artifacts[0].title, original.title)
  assert.equal(original.previewRevision, 'a'.repeat(64), 'prior artifact objects are not mutated')
  assert.equal(appendServerArtifact({ id: original.id, filename: 'stale.pptx' }, artifacts, dispatch), false)
  assert.equal(artifacts[0].filename, original.filename)
  assert.equal(updates.length, 2)
  assert.equal(updates[0].payload.serverArtifacts[0].previewRevision, original.previewRevision)
})

test('accepted newer artifact metadata refreshes the already-open PPT tab without opening a duplicate', () => {
  const state = initialState()
  const next = reducer(state, revise())
  assert.equal(next.previewTabs.length, 1)
  assert.equal(next.previewActiveId, state.previewActiveId)
  assert.equal(next.previewArtifact.directFile.previewRevision, revised.previewRevision)
  assert.equal(next.previewArtifact.messageId, 'original-message')
  assert.equal(next.previewArtifact.directFile.url, original.url)
  assert.equal(next.previewArtifact.directFile.id, original.id)
  assert.equal(state.previewArtifact.directFile.previewRevision, original.previewRevision)
})

test('updating an inactive PPT tab does not steal the active preview or create tabs for unselected artifacts', () => {
  let state = initialState()
  state = reducer(state, { type: 'OPEN_PREVIEW_ARTIFACT', payload: artifactReferenceOpenPayload({
    id: 'notes', filename: 'notes.md', type: 'markdown', url: '/api/artifacts/notes.md',
  }, 'original-message') })
  const next = reducer(state, { ...revise(), payload: { serverArtifacts: [revised,
    { ...revised, id: 'unopened', url: '/api/artifacts/unopened.pptx' }] } })
  assert.equal(next.previewTabs.length, 2)
  assert.equal(next.previewActiveId, state.previewActiveId)
  assert.equal(next.previewArtifact, state.previewArtifact)
  assert.equal(next.previewTabs[0].artifact.directFile.previewRevision, revised.previewRevision)
  assert.equal(next.previewTabs[1], state.previewTabs[1])
})

test('old event sequences and wrong turn owners cannot refresh a preview through rejected metadata', () => {
  const state = initialState()
  for (const overrides of [{ serverSequence: 0 }, { serverTurnId: 'another-turn' }, { messageId: 'missing' }]) {
    const next = reducer(state, { ...revise(), ...overrides })
    assert.equal(next.previewTabs, state.previewTabs)
    assert.equal(next.previewArtifact, state.previewArtifact)
  }
})

test('accepted server snapshots update opened previews; stale snapshots cannot roll them back', () => {
  const state = initialState()
  const messages = state.sessions[0].messages.map((message) => message.id === 'original-message'
    ? { ...message, meta: { ...message.meta, serverArtifacts: [revised] } } : message)
  const next = reducer(state, { type: 'APPLY_SERVER_SESSION_SNAPSHOT', payload: {
    sessionId: 'session-1', snapshot: { complete: true, revision: 6, messages },
  } })
  assert.equal(next.previewArtifact.directFile.previewRevision, revised.previewRevision)
  const stale = reducer(next, { type: 'APPLY_SERVER_SESSION_SNAPSHOT', payload: {
    sessionId: 'session-1', snapshot: { complete: true, revision: 4, messages: state.sessions[0].messages },
  } })
  assert.equal(stale.previewTabs, next.previewTabs)
  assert.equal(stale.previewArtifact, next.previewArtifact)
})

test('another session, another URL, closed previews, and legacy metadata do not change an opened file reference', () => {
  const state = initialState()
  state.sessions.push({ id: 'session-2', messages: [{ id: 'other-message', role: 'assistant', meta: {} }] })
  for (const action of [
    { ...revise(), sessionId: 'session-2', messageId: 'other-message' },
    revise({ ...revised, url: '/api/artifacts/different.pptx' }),
    revise({ ...original, previewRevision: undefined }),
  ]) {
    const next = reducer(state, action)
    assert.equal(next.previewTabs, state.previewTabs)
    assert.equal(next.previewArtifact, state.previewArtifact)
  }
  const closed = initialState({ open: false })
  const nextClosed = reducer(closed, revise())
  assert.equal(nextClosed.previewTabs, closed.previewTabs)
  assert.equal(nextClosed.previewArtifact, null)
})
