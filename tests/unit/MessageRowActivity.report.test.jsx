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

async function renderHarness(t, { withTool = true, toolName = 'read_file', finalText = FINAL_TEXT } = {}) {
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
    await state.emit('tool.call', { toolCallId: 'read', name: toolName, args: { path: 'report.md' } })
    await state.emit('tool.completed', { toolCallId: 'read', name: toolName, result: { ok: true } })
  }
  await state.emit('assistant.delta', { text: finalText })
  await render()
  await state.emit('turn.completed', { text: finalText })
  await render()
  return { element, root, render, state }
}

test('a running turn renders the same rounds when the narrative precedes the tool call', async (t) => {
  const dom = setupDom()
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  const state = streamedMessage()
  const render = () => act(async () => root.render(<I18nProvider><MessageRow msg={state.message()}
    rowKey="report-message" generatingMessageId={state.message().meta.streaming ? 'report-message' : ''}
    lang="en" t={translate} /></I18nProvider>))
  t.after(async () => { await act(async () => root.unmount()); dom.window.close() })

  await state.emit('turn.started', {})
  // The model writes its ReAct narrative first and only then calls a tool, so the
  // narrative is still inside `execution` while the turn runs. It must already be
  // presented as rounds — the finished layout — instead of plain markdown that is
  // replaced wholesale on completion.
  await state.emit('assistant.delta', { text: TRAJECTORY })
  await state.emit('tool.call', { toolCallId: 'read-later', name: 'read_file', args: { path: 'report.md' } })
  await render()
  assert.ok(element.querySelector('[data-testid="agent-rounds"]'), 'the running turn uses the rounds layout')
  assert.match(element.textContent, /Check the source table structure/u)
  assert.doesNotMatch(element.textContent, /【Thought】/u, 'raw markers are never shown as prose')
})

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

  // Default collapsed: the process is not in the DOM yet.
  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.ok(toggle, 'one collapsed area owns the execution detail')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the process starts collapsed')
  assert.equal(element.querySelector('[data-testid="agent-rounds"]'), null)

  await act(async () => toggle.click())
  await render()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  // The narrative names one action and the run recorded one call, so the process
  // renders as the loop: 思考 → 行动 →（真实调用）→ 观察.
  const order = [...element.querySelectorAll('[data-testid="agent-round"], [data-testid="tool-call-step"]')]
    .map((node) => node.getAttribute('data-round-kind') || 'tool')
  assert.deepEqual(order, ['thought', 'action', 'tool', 'observation'])
  const rounds = [...element.querySelectorAll('[data-testid="agent-round"]')]
  assert.match(rounds[0].querySelector('[data-testid="agent-round-body"]').textContent, /Check the source table structure/u)
  assert.match(rounds[1].querySelector('[data-testid="agent-round-body"]').textContent, /read_file path=report\.md/u)
  assert.match(rounds[2].querySelector('[data-testid="agent-round-body"]').textContent, /The table has 3 columns/u)
  // Each of these steps is a single sentence, so there is no opening line to
  // preview — and a label with nothing beside it would be a bare tag, so the
  // row is not drawn at all; the prose stands on its own.
  assert.equal(
    rounds.every((round) => round.querySelector('[data-testid="agent-round-label"]') === null),
    true,
    'a step with no opening line carries no label row',
  )
  // Expanding must not duplicate the report inside the process.
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

test('an empty report body says so instead of leaving the message blank', async (t) => {
  // Regression: `【任务完成报告】` with nothing after it counted as a present
  // report, which folded the steps away *and* left the top level empty — the
  // message looked like it had lost its reply.
  const { element } = await renderHarness(t, { withTool: false, finalText: '【任务完成报告】' })
  assert.equal(element.querySelector('[data-testid="assistant-empty-answer"]') !== null, true,
    'a completed turn with no text says so')
  assert.doesNotMatch(element.textContent, /【任务完成报告】/u)
})

test('an empty report body keeps the steps visible rather than folding them shut', async (t) => {
  const { element } = await renderHarness(t, {
    withTool: true,
    finalText: '【任务完成报告】\n\n【Thought】I did the read and stopped there.',
  })
  // The steps are the only content, so they must not be hidden behind a fold
  // that claims a report exists.
  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(element.textContent, /I did the read and stopped there/u)
  assert.equal(element.querySelector('[data-testid="assistant-empty-answer"]'), null)
})

test('a narrative that matches the recorded calls renders as one interleaved loop', async (t) => {
  // The complaint this answers: every call appeared in a block at the top, then
  // the whole narrative underneath. With one action and one recorded call the
  // process is shown as the loop it describes instead.
  const { element, render } = await renderHarness(t, {
    withTool: true,
    finalText: [
      '【Thought】先读取表格结构。',
      '【Action】read_file path=report.md',
      '【Observation】表格有 3 列。',
      '【任务完成报告】',
      '已生成 out.xlsx。',
    ].join('\n'),
  })
  // The process is folded by default, so it is opened before anything is read.
  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the loop starts folded')
  await act(async () => toggle.click())
  await render()

  const order = [...element.querySelectorAll('[data-testid="agent-round"], [data-testid="tool-call-step"]')]
    .map((node) => node.getAttribute('data-round-kind') || 'tool')
  assert.deepEqual(order, ['thought', 'action', 'tool', 'observation'],
    'the real call sits between the action that asked for it and the observation')

  // The two-block presentation is gone in this mode, and the report is still the
  // only thing shown at the top level.
  assert.equal(element.querySelector('.chat-run-timeline'), null)
  assert.match(element.textContent, /已生成 out\.xlsx/u)
  assert.equal(element.querySelector('[data-testid="trajectory-entries"]'), null)
})

test('a call inside the loop opens onto its own detail', async (t) => {
  // Regression: the loop renders rows on their own, and the open/closed state
  // used to live only in the run timeline — so a call in the loop had nothing to
  // open with and could not be inspected at all.
  const { element, render } = await renderHarness(t, { withTool: true })
  await act(async () => element.querySelector('[data-testid="execution-toggle"]').click())
  await render()

  const step = element.querySelector('[data-testid="tool-call-step"]')
  const toggle = step.querySelector('[data-testid="tool-step-toggle"]')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(step.querySelector('[data-testid="tool-step-details"]'), null)
  await act(async () => toggle.click())
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.ok(step.querySelector('[data-testid="tool-step-details"]'), 'the call opens onto its arguments and result')
})

test('the header takes the opening sentence and the body the rest — never the same text twice', async (t) => {
  const { element, render } = await renderHarness(t, {
    withTool: false,
    finalText: [
      '【Thought】先确认表格结构再写入文件。合并单元格会影响列宽，原始文件里还有三处脚注要保留。',
      '【任务完成报告】',
      '完成。',
    ].join('\n'),
  })
  await act(async () => element.querySelector('[data-testid="execution-toggle"]').click())
  await render()

  const round = element.querySelector('[data-testid="agent-round"]')
  assert.equal(round.querySelector('[data-testid="agent-round-summary"]').textContent, '先确认表格结构再写入文件。')
  const body = round.querySelector('[data-testid="agent-round-body"]').textContent
  assert.match(body, /三处脚注/u)
  // What the header shows is not repeated below it.
  assert.doesNotMatch(body, /先确认表格结构/u)
})

test('a write the file card cannot describe still appears as its own row', async (t) => {
  // The file card renders nothing when the outcome cannot be read. Falling back
  // to the generic row keeps a step the runtime really made from disappearing —
  // which is how "写入" went missing from the timeline.
  const { element, render } = await renderHarness(t, {
    withTool: true,
    toolName: 'write_file',
    finalText: [
      '【Thought】写一个文件。',
      '【Action】write_file path=report.md',
      '【Observation】写好了。',
      '【任务完成报告】',
      '完成。',
    ].join('\n'),
  })
  await act(async () => element.querySelector('[data-testid="execution-toggle"]').click())
  await render()

  assert.equal(element.querySelector('[data-testid="file-write-card"]'), null, 'nothing to describe, so no card')
  const rows = [...element.querySelectorAll('[data-testid="tool-call-step"]')]
  assert.equal(rows.length, 1, 'the recorded write is still shown')
  assert.equal(rows[0].getAttribute('data-kind'), 'write')
})

test('each call is paired in order and never attributed to a later action', async (t) => {
  // Two actions but only one recorded call. The call belongs to the first action
  // — it was the first one asked for — and the second action stays unpaired
  // rather than borrowing it.
  const { element, render } = await renderHarness(t, {
    withTool: true,
    finalText: [
      '【Thought】先看一眼。',
      '【Action】read_file path=report.md',
      '【Observation】读到了。',
      '【Action】write_file path=out.xlsx',
      '【Observation】写完了。',
      '【任务完成报告】',
      '已完成。',
    ].join('\n'),
  })
  await act(async () => element.querySelector('[data-testid="execution-toggle"]').click())
  await render()

  const order = [...element.querySelectorAll('[data-testid="agent-round"], [data-testid="tool-call-step"]')]
    .map((node) => node.getAttribute('data-round-kind') || 'tool')
  assert.deepEqual(order, ['thought', 'action', 'tool', 'observation', 'action', 'observation'])
  assert.equal(element.querySelectorAll('[data-testid="tool-call-step"]').length, 1,
    'one recorded call, shown once')
  assert.equal(element.querySelector('[data-testid="agent-rounds"]') !== null, true)
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

test('the collapsible container folds the steps and never shows its own tags', async (t) => {
  // The shape the output contract asks for, and the shape a real turn produced:
  // the summary sits outside the container, the steps inside it.
  const { element } = await renderHarness(t, {
    withTool: false,
    finalText: [
      'Generated out.xlsx with 3 columns and merged cells.',
      '',
      '<collapsible title="完整执行过程（点击展开）">',
      '【Thought】Check the source table structure first.',
      '【Action】read_file path=report.md',
      '【Observation】The table has 3 columns.',
      '</collapsible>',
    ].join('\n'),
  })

  // The summary outside the container is the report, and it is what is shown.
  assert.match(element.textContent, /Generated out\.xlsx with 3 columns/u)
  // No marker text may reach the reader: not the tags, not the labels, and not
  // the model's own title (the interface supplies its own toggle label).
  assert.doesNotMatch(element.textContent, /collapsible/u)
  assert.doesNotMatch(element.textContent, /【Thought】|【Action】|【Observation】/u)
  assert.doesNotMatch(element.textContent, /完整执行过程/u)

  const toggle = element.querySelector('[data-testid="execution-toggle"]')
  assert.ok(toggle, 'the container is folded into one disclosure')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'it starts collapsed')
  assert.equal(element.querySelector('[data-testid="agent-rounds"]'), null, 'collapsed: not rendered yet')

  await act(async () => toggle.click())
  const rounds = [...element.querySelectorAll('[data-testid="agent-round"]')]
  assert.deepEqual(rounds.map((round) => round.getAttribute('data-round-kind')),
    ['thought', 'action', 'observation'])
  // The step's substance sits under its header in every state, and there is
  // nothing to open: opening it could only repeat the one text this step has.
  const body = rounds[0].querySelector('[data-testid="agent-round-body"]')
  assert.ok(body, 'the prose is present while the step is folded')
  assert.match(body.textContent, /Check the source table structure/u)
  assert.equal(rounds[0].querySelector('[data-testid="agent-round-toggle"]'), null, 'no drawer on a prose step')
  // This step is one short sentence, so a header gist would only restate it.
  assert.equal(rounds[0].querySelector('[data-testid="agent-round-summary"]'), null)
  assert.doesNotMatch(element.querySelector('[data-testid="agent-rounds"]').textContent, /Generated out\.xlsx/u)
})
