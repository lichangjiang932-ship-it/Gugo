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

const REPORT = 'Generated out.xlsx with 3 columns and merged cells.'
const TRAJECTORY = [
  '【Thought】Check the source table structure first.',
  '【Action】read_file path=report.md',
  '【Observation】The table has 3 columns and merged cells.',
].join('\n')
const FINAL_TEXT = `${TRAJECTORY}\n【任务完成报告】\n${REPORT}`

function streamedMessage() {
  let state = { activeSessionId: 'report-session', sessions: [{ id: 'report-session', messages: [{
    id: 'report-message', role: 'assistant', content: '', meta: { streaming: true, executionStarted: true },
  }] }] }
  let sequence = 0
  return {
    message: () => state.sessions[0].messages[0],
    async emit(type, payload) {
      const eventSequence = sequence++
      return dispatchTurnEvent(createTurnEvent({
        id: `report-event-${eventSequence}`, sessionId: 'report-session', turnId: 'report-turn',
        sequence: eventSequence, createdAt: 1_000 + eventSequence, type, payload,
      }), { taskId: 'report-task', messageTarget: { sessionId: 'report-session', messageId: 'report-message' },
        dispatch: (action) => { state = reduceMessageState(state, action) || state },
      })
    },
  }
}

async function renderHarness(t, { withTool = true, finalText = FINAL_TEXT } = {}) {
  const dom = setupDom()
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  const state = streamedMessage()
  const render = () => act(async () => root.render(<I18nProvider><MessageRow msg={state.message()}
    rowKey="report-message" generatingMessageId={state.message().meta.streaming ? 'report-message' : ''}
    lang="en" t={translate} /></I18nProvider>))
  t.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  await state.emit('turn.started', {})
  if (withTool) {
    await state.emit('assistant.delta', { text: 'Working on it.\n\n' })
    await state.emit('tool.call', { toolCallId: 'read', name: 'read_file', args: { path: 'report.md' } })
    await state.emit('tool.completed', { toolCallId: 'read', name: 'read_file', result: { ok: true } })
  }
  await state.emit('assistant.delta', { text: finalText })
  await render()
  await state.emit('turn.completed', { text: finalText })
  await render()
  return { element, root, render, state }
}

test('a completed turn shows the report at the top and folds every intermediate step', async (t) => {
  const { element, render } = await renderHarness(t)

  // Top level: report only.
  assert.match(element.textContent, /Generated out\.xlsx/u)
  // Intermediate ReAct text must not leak into the top-level answer.
  assert.doesNotMatch(element.textContent, /Check the source table structure/u)
  assert.doesNotMatch(element.textContent, /read_file path=report\.md/u)
  assert.doesNotMatch(element.textContent, /The table has 3 columns/u)
  // Nor may the raw markers render as prose anywhere.
  assert.doesNotMatch(element.textContent, /【任务完成报告】/u)
  assert.doesNotMatch(element.textContent, /【Thought】/u)
  assert.doesNotMatch(element.textContent, /【Observation】/u)

  // Default collapsed: the trajectory is not in the DOM yet.
  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.ok(toggle, 'one collapsed area owns the execution detail')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the trajectory starts collapsed')
  assert.equal(element.querySelector('[data-testid="trajectory-entries"]'), null)

  await act(async () => toggle.click())
  await render()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  const entries = [...element.querySelectorAll('[data-testid="trajectory-entry"]')]
  assert.deepEqual(entries.map((entry) => entry.getAttribute('data-trajectory-kind')),
    ['thought', 'action', 'observation'])
  assert.match(entries[0].textContent, /Check the source table structure/u)
  assert.match(entries[1].textContent, /read_file path=report\.md/u)
  assert.match(entries[2].textContent, /The table has 3 columns/u)
  // Labels are localized, not raw marker text.
  assert.deepEqual(entries.map((entry) => entry.querySelector('[data-testid="trajectory-entry-label"]').textContent),
    ['Thought', 'Action', 'Observation'])
  // Expanding must not duplicate the report inside the trajectory.
  assert.equal(element.textContent.split(REPORT).length - 1, 1)
})

test('a message without ReAct markers keeps the previous rendering', async (t) => {
  // Old turns, other flows and models that ignore the format must be untouched.
  const { element } = await renderHarness(t, {
    withTool: false,
    finalText: 'Plain answer with **markdown**.',
  })
  assert.match(element.textContent, /Plain answer with/u)
  assert.equal(element.querySelector('[data-testid="trajectory-entries"]'), null)
  assert.equal(element.querySelector('[data-testid="trajectory-entry"]'), null)
})

test('a report without a trajectory still renders the report alone', async (t) => {
  const { element } = await renderHarness(t, {
    withTool: false,
    finalText: '【任务完成报告】\nOnly the summary was written.',
  })
  assert.match(element.textContent, /Only the summary was written/u)
  assert.doesNotMatch(element.textContent, /【任务完成报告】/u)
  assert.equal(element.querySelector('[data-testid="trajectory-entry"]'), null)
})

test('a trajectory without a report marker keeps the steps open instead of blanking the answer', async (t) => {
  // The model may forget the report marker. Raw `【Thought】` must never reach
  // the top level, but folding everything away would leave an empty answer for
  // a completed turn — so the steps stay open and act as the answer.
  const { element } = await renderHarness(t, {
    withTool: false,
    finalText: '【Thought】thinking out loud\n【Action】do_thing',
  })
  assert.doesNotMatch(element.textContent, /【Thought】/u)
  assert.doesNotMatch(element.textContent, /【Action】/u)
  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.ok(toggle, 'the steps are folded even without a report section')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the steps are the answer here, so they stay open')
  assert.match(element.textContent, /thinking out loud/u)
})
