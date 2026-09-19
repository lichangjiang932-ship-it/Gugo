import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { dispatchTurnEvent } from '../../src/lib/turnClient/turnEventDispatch.js'
import { reduceMessageState } from '../../src/store/reducers/messageReducer.js'

const translate = (key, vars = {}) => translateKey(key, 'en').replace(/\{(\w+)\}/g, (_, name) => vars[name])

function streamedMessage() {
  let state = { activeSessionId: 'timeline-session', sessions: [{ id: 'timeline-session', messages: [{
    id: 'timeline-message', role: 'assistant', content: '', meta: { streaming: true, executionStarted: true },
  }] }] }
  let sequence = 0
  return {
    message: () => state.sessions[0].messages[0],
    async emit(type, payload) {
      const eventSequence = sequence++
      return dispatchTurnEvent(createTurnEvent({
        id: `timeline-event-${eventSequence}`, sessionId: 'timeline-session', turnId: 'timeline-turn',
        sequence: eventSequence, createdAt: 1_000 + eventSequence, type, payload,
      }), { taskId: 'timeline-task', messageTarget: { sessionId: 'timeline-session', messageId: 'timeline-message' },
        dispatch: (action) => { state = reduceMessageState(state, action) || state },
      })
    },
  }
}

function visibleSegments(element) {
  return [...element.querySelectorAll('[data-quotable="true"] .chat-markdown, [data-quotable="true"] .chat-run-timeline')]
    .filter((entry) => !entry.closest('[data-testid="tool-step-details"]'))
}

for (const terminal of ['turn.completed', 'turn.cancelled']) {
  test(`public Markdown and tool events stay interleaved through ${terminal} without duplicate text or private reasoning`, async () => {
    const dom = setupDom()
    const element = document.getElementById('root')
    const root = createRoot(element)
    const state = streamedMessage()
    const opening = '**First check**\n\nI will inspect the file.\n\n'
    const middle = '**Next check**\n\nI found the affected path.\n\n'
    const ending = terminal === 'turn.completed' ? '**Verified result**\n\nThe check passed.' : '**Partial result**\n\nThe check has not finished.'
    const render = () => act(async () => root.render(<I18nProvider><MessageRow msg={state.message()}
      rowKey="timeline-message" generatingMessageId={state.message().meta.streaming ? 'timeline-message' : ''}
      lang="en" t={translate} /></I18nProvider>))
    try {
      await state.emit('turn.started', {})
      await state.emit('assistant.delta', { text: opening })
      await state.emit('reasoning.delta', { text: 'PRIVATE-REASONING-SENTINEL', iteration: 0 })
      await state.emit('tool.call', { toolCallId: 'read', name: 'read_file', args: { path: 'file.txt' } })
      await state.emit('tool.started', { toolCallId: 'read', name: 'read_file' })
      await render()
      assert.deepEqual(visibleSegments(element).map((entry) => entry.classList.contains('chat-markdown') ? 'text' : 'tools'), ['text', 'tools'])
      assert.equal(element.querySelector('strong')?.textContent, 'First check')
      assert.equal(state.message().meta.toolCalls[0].textOffset, opening.length)
      await state.emit('tool.completed', { toolCallId: 'read', name: 'read_file', result: { ok: true } })
      await state.emit('assistant.delta', { text: middle })
      await state.emit('tool.call', { toolCallId: 'verify', name: 'run_command', args: { command: 'node check.mjs' } })
      await render()
      const firstTool = element.querySelector('[data-testid="tool-step-toggle"]')
      await act(async () => firstTool.click())
      assert.equal(firstTool.getAttribute('aria-expanded'), 'true')
      if (terminal === 'turn.completed') {
        await state.emit('tool.completed', { toolCallId: 'verify', name: 'run_command', result: { ok: true, exitCode: 0 } })
      }
      await state.emit('assistant.delta', { text: ending })
      await render()
      assert.equal(element.querySelector('[data-testid="tool-step-toggle"]'), firstTool, 'stream updates retain the opened tool view')
      assert.deepEqual(visibleSegments(element).map((entry) => entry.classList.contains('chat-markdown') ? 'text' : 'tools'),
        ['text', 'tools', 'text', 'tools', 'text'])
      const fullText = opening + middle + ending
      await state.emit(terminal, terminal === 'turn.completed' ? { text: fullText } : { code: 'TURN_CANCELLED', partialText: fullText })
      await render()
      assert.deepEqual(visibleSegments(element).map((entry) => entry.classList.contains('chat-markdown') ? 'text' : 'tools'),
        ['text', 'tools', 'text', 'tools', 'text'], 'terminal display must not silently hide public narration')
      assert.equal(element.querySelector('[data-testid="execution-toggle"]').getAttribute('aria-expanded'), 'true')
      for (const text of ['First check', 'Next check', terminal === 'turn.completed' ? 'Verified result' : 'Partial result']) {
        assert.equal(element.textContent.split(text).length - 1, 1, `public segment rendered exactly once: ${text}`)
      }
      assert.doesNotMatch(element.textContent, /PRIVATE-REASONING-SENTINEL/u)
      assert.equal(element.querySelector('[data-testid="execution-diagnostics"]'), null)
      if (terminal === 'turn.cancelled') {
        assert.equal(state.message().meta.cancelled, true)
        assert.equal(state.message().meta.toolCalls[1].status, 'cancelled')
        assert.equal(element.querySelector('.chat-thinking-line[data-state="complete"]'), null)
      }
      await act(async () => root.render(null))
      await render()
      assert.equal(element.querySelector('[data-testid="execution-toggle"]').getAttribute('aria-expanded'), 'true', 'restored public process remains readable')
      const toggle = element.querySelector('[data-testid="execution-toggle"]')
      await act(async () => toggle.click())
      await render()
      assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'an explicit user collapse remains respected')
    } finally { await act(async () => root.unmount()); dom.window.close() }
  })
}

test('a choice block before a tool cannot shift the tool past the following public answer', async () => {
  const dom = setupDom()
  const element = document.getElementById('root')
  const root = createRoot(element)
  const before = 'Before choice [[choice:a:Option A|b:Option B]]\n\n'
  const after = '**After tool**'
  const msg = { id: 'choice-timeline', role: 'assistant', content: before + after,
    meta: { streaming: false, toolCalls: [{ id: 'choice-read', name: 'read_file', status: 'success',
      arguments: '{"path":"fixture.txt"}', textOffset: before.length }] } }
  try {
    await act(async () => root.render(<I18nProvider><MessageRow msg={msg} rowKey={msg.id}
      generatingMessageId="" lang="en" t={translate} /></I18nProvider>))
    const segments = visibleSegments(element)
    assert.deepEqual(segments.map((entry) => entry.classList.contains('chat-markdown') ? 'text' : 'tools'), ['text', 'tools', 'text'])
    assert.equal(segments[0].textContent, 'Before choice')
    assert.equal(element.querySelector('.chat-assistant-answer strong')?.textContent, 'After tool')
    assert.doesNotMatch(element.querySelector('[data-quotable="true"]').textContent, /\[\[choice:/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
