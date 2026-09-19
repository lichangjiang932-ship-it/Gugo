import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import { normalizeServerSessionSnapshot } from '../../src/lib/turnClient/sessionSnapshot.js'
import { mergeServerSessionMessages } from '../../src/store/sessionMessageSnapshotMerge.js'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-public-timeline-refresh-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
const { closeDb, createUser } = await import('../../server/db.js')
const { TurnEngine } = await import('../../server/services/TurnEngine.js')
const { createTestTurnEnginePersistence } = await import('../helpers/turnEnginePersistence.js')
const { getMessage, getSessionSnapshot, upsertMessage, upsertSession } = await import('../../server/services/sessionStore.js')
const { getTurnCheckpoint } = await import('../../server/services/turnCheckpointStore.js')
const { expandStoredMessages } = await import('../../server/services/turnMessageContext.js')
const userId = 'public-timeline-owner'
createUser({ id: userId, email: 'public-timeline@example.invalid' })
test.after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }) })

const opening = '**Inspect 👩‍💻**\n\nRead the file first.\n\n'
const middle = '**Verify**\n\nCheck the result.\n\n'
const finalText = '**Final answer**\n\nThe result is verified.'
const translate = (key, vars = {}) => translateKey(key, 'en').replace(/\{(\w+)\}/g, (_, name) => vars[name])
const toolMessage = (call, content) => ({ role: 'assistant', content,
  tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] })

async function persistedTurn(kind) {
  const sessionId = `public-timeline-${kind}`
  const turnId = `turn-${kind}`
  upsertSession({ id: sessionId, userId, title: kind })
  let ready
  const checkpointReady = new Promise((resolve) => { ready = resolve })
  const engine = new TurnEngine({ persistence: createTestTurnEnginePersistence(), scheduleMemoryExtraction() {},
    runLoop: async ({ messages, onModelDelta, onReasoningDelta, onToolCall, onToolStarted, onToolCompleted, saveCheckpoint, signal }) => {
      const first = { id: 'first', name: 'read_file', args: { path: 'fixture.txt' } }
      const second = { id: 'second', name: 'run_command', args: { command: 'node verify.mjs' } }
      await onModelDelta({ text: opening, iteration: 0 })
      await onReasoningDelta({ text: 'PRIVATE-REASONING-MUST-NOT-RESTORE', iteration: 0 })
      await onToolCall(first)
      await onToolStarted(first)
      await onToolCompleted({ call: first, result: { ok: true } })
      const checkpointMessages = [...messages, toolMessage(first, opening),
        { role: 'tool', tool_call_id: first.id, name: first.name, content: '{"ok":true}' }]
      await saveCheckpoint({ messages: checkpointMessages, iterations: 1, artifactIds: [],
        publicTimeline: { version: 1, text: 'UNTRUSTED-LOOP-CHECKPOINT-TEXT' } })
      await onModelDelta({ text: middle, iteration: 1 })
      await onToolCall(second)
      await onToolStarted(second)
      checkpointMessages.push(toolMessage(second, middle))
      if (kind === 'completed') {
        await onToolCompleted({ call: second, result: { ok: true, exitCode: 0 } })
        checkpointMessages.push({ role: 'tool', tool_call_id: second.id, name: second.name, content: '{"ok":true,"exitCode":0}' })
      }
      await saveCheckpoint({ messages: checkpointMessages, iterations: 2, artifactIds: [] })
      ready()
      if (kind === 'cancelled') {
        await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
        return { text: 'must not replace cancelled partial output', artifactIds: [], iterations: 2 }
      }
      await onModelDelta({ text: finalText, iteration: 2 })
      return { text: finalText, artifactIds: [], iterations: 2 }
    },
  })
  const scope = { userId, sessionId, turnId }
  await engine.startTurn({ ...scope, content: 'Inspect the isolated fixture.' })
  if (kind === 'cancelled') { await checkpointReady; await engine.cancelTurn(scope) }
  await engine.waitForTurn(scope)
  return scope
}

for (const kind of ['completed', 'cancelled']) {
  test(`a real persisted ${kind} Turn restores public text/tool order through snapshot and UI without changing canonical history`, async () => {
    const scope = await persistedTurn(kind)
    const stored = getMessage({ ...scope, messageId: `${scope.turnId}:assistant` })
    assert.equal(Boolean(stored?.modelContext?.publicTimeline), true, 'the terminal message needs an explicit host-produced public projection')
    const expectedCanonical = kind === 'completed' ? finalText : (opening + middle).trim()
    assert.equal(stored.content, expectedCanonical)
    assert.equal(expandStoredMessages([stored]).at(-1).content, expectedCanonical, 'model history remains canonical, not a repeated UI transcript')
    assert.doesNotMatch(JSON.stringify(stored.modelContext.publicTimeline), /PRIVATE-REASONING|UNTRUSTED-LOOP/)
    const checkpoint = getTurnCheckpoint(scope)
    assert.equal(checkpoint.state.publicTimeline.text, opening + middle)
    assert.deepEqual(checkpoint.state.publicTimeline.toolAnchors.map((entry) => entry.textOffset), [opening.length, opening.length + middle.length])
    closeDb()
    const cold = normalizeServerSessionSnapshot(getSessionSnapshot(scope))
    const restored = cold.messages.find((message) => message.id === stored.id)
    assert.equal(restored.content, expectedCanonical)
    assert.equal(Boolean(restored.meta.publicTimeline), true)
    const [merged] = mergeServerSessionMessages([{
      ...restored, content: 'stale local output', meta: { ...restored.meta, publicTimeline: null, serverLastSequence: 0 },
    }], [restored])
    assert.equal(merged.content, expectedCanonical)
    assert.deepEqual(merged.meta.publicTimeline, restored.meta.publicTimeline)
    const dom = setupDom()
    const element = document.getElementById('root')
    const root = createRoot(element)
    try {
      await act(async () => root.render(<I18nProvider><MessageRow msg={merged} rowKey={stored.id}
        generatingMessageId="" lang="en" t={translate} /></I18nProvider>))
      const segments = [...element.querySelectorAll('[data-quotable="true"] .chat-markdown, [data-quotable="true"] .chat-run-timeline')]
      assert.deepEqual(segments.map((entry) => entry.classList.contains('chat-markdown') ? 'text' : 'tools'),
        ['text', 'tools', 'text', 'tools', 'text'])
      assert.equal(element.textContent.split('Inspect 👩‍💻').length - 1, 1)
      assert.equal(element.textContent.split('Verify').length - 1, 1)
      assert.doesNotMatch(element.textContent, /PRIVATE-REASONING|UNTRUSTED-LOOP|must not replace/)
      if (kind === 'cancelled') {
        assert.equal(merged.meta.cancelled, true)
        assert.equal(segments.at(-1).textContent, translate('chat.serverTurn.cancelled'), 'a real cancellation notice remains visible after the partial transcript')
      }
    } finally { await act(async () => root.unmount()); dom.window.close() }
    assert.equal(getSessionSnapshot({ ...scope, userId: 'another-owner' }), null)
  })
}

test('legacy tool traces without a host public projection retain canonical text and never guess offsets', () => {
  const sessionId = 'public-timeline-legacy'
  upsertSession({ id: sessionId, userId, title: 'legacy' })
  upsertMessage({ id: 'legacy-answer', userId, sessionId, role: 'assistant', content: 'Only final answer',
    modelContext: { turnId: 'legacy-turn', toolTrace: [toolMessage({ id: 'legacy-call', name: 'read_file', args: {} }, 'Unproven prior narration'),
      { role: 'tool', tool_call_id: 'legacy-call', content: '{"ok":true}' }] } })
  const [message] = normalizeServerSessionSnapshot(getSessionSnapshot({ userId, sessionId })).messages
  assert.equal(message.content, 'Only final answer')
  assert.equal(Boolean(message.meta.publicTimeline), false)
  assert.equal(Object.hasOwn(message.meta.toolCalls[0], 'textOffset'), false)
})

test('a checkpoint-restored Turn continues its host public projection without replaying previous tools', async () => {
  const scope = { userId, sessionId: 'public-timeline-resume', turnId: 'turn-resume' }
  upsertSession({ id: scope.sessionId, userId, title: 'resume' })
  let attempts = 0
  let toolEvents = 0
  const engine = new TurnEngine({ persistence: createTestTurnEnginePersistence(), scheduleMemoryExtraction() {},
    runLoop: async ({ messages, onModelDelta, onToolCall, onToolCompleted, saveCheckpoint, loadCheckpoint }) => {
      attempts += 1
      if (attempts === 1) {
        const call = { id: 'resume-read', name: 'read_file', args: { path: 'fixture.txt' } }
        await onModelDelta({ text: opening, iteration: 0 })
        await onToolCall(call)
        toolEvents += 1
        await onToolCompleted({ call, result: { ok: true } })
        await saveCheckpoint({ messages: [...messages, toolMessage(call, opening),
          { role: 'tool', tool_call_id: call.id, name: call.name, content: '{"ok":true}' }], iterations: 1, artifactIds: [] })
        return { interrupted: true, partialText: opening, artifactIds: [], iterations: 1 }
      }
      const checkpoint = await loadCheckpoint()
      assert.equal(checkpoint.publicTimeline.text, opening)
      await onModelDelta({ text: finalText, iteration: 1 })
      return { text: finalText, artifactIds: [], iterations: 1 }
    },
  })
  await engine.startTurn({ ...scope, content: 'Inspect and explain the fixture.' })
  await engine.waitForTurn(scope)
  await engine.resumeTurn(scope)
  await engine.waitForTurn(scope)
  const stored = getMessage({ ...scope, messageId: `${scope.turnId}:assistant` })
  assert.equal(attempts, 2)
  assert.equal(toolEvents, 1)
  assert.equal(stored.content, finalText)
  assert.equal(stored.modelContext.publicTimeline.text, opening + finalText)
  assert.deepEqual(stored.modelContext.publicTimeline.toolAnchors.map((anchor) => anchor.textOffset), [opening.length])
})
