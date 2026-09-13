import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ActivityStream from '../../src/pages/ChatSplit/chatMessages/ActivityStream.jsx'
import LiveElapsed from '../../src/components/LiveElapsed.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function render(meta, language = 'en') {
  const previousWindow = globalThis.window
  const hadWindow = Object.hasOwn(globalThis, 'window')
  globalThis.window = { localStorage: { getItem: (key) => key === 'lang' ? language : null } }
  try {
    return renderToStaticMarkup(<I18nProvider><ActivityStream msg={{ meta }} /></I18nProvider>)
  } finally {
    if (hadWindow) globalThis.window = previousWindow
    else delete globalThis.window
  }
}

test('large PPT argument generation shows exact progress, not fake tool execution', () => {
  const meta = {
    streaming: true, reasoning: 'never reveal this reasoning',
    modelActivity: { kind: 'tool_arguments', phase: 'tool_arguments', toolName: 'create_pptx', toolArgumentsChars: 12345 },
  }
  const markup = render(meta)
  assert.match(markup, /Preparing arguments for Create PowerPoint/)
  assert.match(markup, /12,345 characters received/)
  assert.match(markup, /the tool has not run yet/)
  assert.doesNotMatch(markup, /never reveal this reasoning|tool-call-step|still running/)
  assert.match(render(meta, 'zh'), /正在为「生成 PPT」生成参数/)
})

test('an idle stream reports last observed counters and quiet duration without claiming new work', () => {
  const markup = render({
    streaming: true,
    modelActivity: { kind: 'model', phase: 'idle', toolName: 'create_pptx', toolArgumentsChars: 9000, idleMs: 37000 },
  })
  assert.match(markup, /Waiting for the model to continue/)
  assert.match(markup, /9,000 characters received/)
  assert.match(markup, /No new content for 37 seconds/)
  assert.doesNotMatch(markup, /still running|Completed/)
})

test('unknown connection state does not present stale argument counters as current execution facts', () => {
  const markup = render({
    streaming: true, serverConnectionState: 'reconnecting',
    modelActivity: { kind: 'tool_arguments', phase: 'tool_arguments', toolArgumentsChars: 9000 },
  })
  assert.match(markup, /Reconnecting/)
  assert.doesNotMatch(markup, /the tool has not run yet|9,000/)
})

test('elapsed clock uses the recorded start and does not reset to zero on remount', () => {
  const originalNow = Date.now
  Date.now = () => 100000
  try {
    assert.match(renderToStaticMarkup(<LiveElapsed startedAt={39000} />), /1:01/)
    assert.match(renderToStaticMarkup(<LiveElapsed startedAt={100001} />), /&lt;1s/)
    assert.match(renderToStaticMarkup(<LiveElapsed startedAt={null} />), /&lt;1s/)
  } finally { Date.now = originalNow }
})

test('a completed answer cannot keep an active retry notice from an earlier attempt', () => {
  const markup = render({ streaming: false, reasoning: 'private reasoning', modelFallback: { kind: 'retry', attempt: 2 } })
  assert.match(markup, /Thought through/)
  assert.doesNotMatch(markup, /Retrying model|private reasoning/)
})
