import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import ActivityStream from '../../src/pages/ChatSplit/chatMessages/ActivityStream.jsx'

function render(msg, language = 'en') {
  const previousWindow = globalThis.window
  const hadWindow = Object.hasOwn(globalThis, 'window')
  const storage = {
    getItem: (key) => key === 'lang' ? language : null,
    setItem: () => {},
  }
  globalThis.window = { localStorage: storage }
  try {
    return renderToStaticMarkup(
      <I18nProvider>
        <ActivityStream msg={msg} />
      </I18nProvider>,
    )
  } finally {
    if (hadWindow) globalThis.window = previousWindow
    else delete globalThis.window
  }
}

test('readiness shows the tool being prepared without creating a tool trace', () => {
  const markup = render({
    meta: {
      streaming: true,
      modelActivity: { kind: 'tool_call_ready', toolName: 'bash_exec' },
      toolCalls: [],
    },
  })
  assert.match(markup, /data-testid="model-activity"/)
  assert.match(markup, /bash_exec/)
})

test('pure reasoning keeps a compact status and never exposes raw text', () => {
  const markup = render({
    content: '',
    meta: { streaming: true, reasoning: 'secret chain of thought', modelActivity: { kind: 'reasoning', phase: 'streaming' } },
  })
  assert.match(markup, /role="status"/)
  assert.match(markup, /data-testid="live-elapsed"/)
  assert.match(markup, /&lt;1s/)
  assert.doesNotMatch(markup, />0s</)
  assert.match(markup, /reasoning through the next step/)
  assert.doesNotMatch(markup, /secret chain of thought/)
})

test('completed reasoning keeps a compact safe summary without exposing raw text', () => {
  const markup = render({
    content: 'Final answer.',
    meta: { streaming: false, reasoning: 'private reasoning payload' },
  })
  assert.match(markup, /data-state="complete"/)
  assert.match(markup, /Thought through/)
  assert.doesNotMatch(markup, /private reasoning payload/)
  assert.doesNotMatch(markup, /data-testid="live-elapsed"/)
})

test('model heartbeat phases explain cold start and temporary stream idle', () => {
  const waiting = render({
    meta: { streaming: true, modelActivity: { kind: 'model', phase: 'waiting_first_token' } },
  })
  assert.match(waiting, /Request sent/)
  assert.match(waiting, /first model output/)

  const idle = render({
    meta: { streaming: true, modelActivity: { kind: 'model', phase: 'idle' } },
  })
  assert.match(idle, /output paused/)
  assert.match(idle, /still running/)
})

test('running tool activity is rendered only by the durable tool timeline', () => {
  const markup = render({
    meta: {
      streaming: true,
      toolCalls: [
        { id: 'read-1', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success' },
        { id: 'bash-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running', liveOutput: 'PASS\n2 passing' },
      ],
    },
  })
  assert.equal(markup, '')
})

test('completed tool details are not duplicated while the model continues', () => {
  const markup = render({
    meta: {
      streaming: true,
      toolCalls: [
        { id: 'bad-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'error' },
      ],
    },
  })
  assert.match(markup, /data-testid="model-activity"/)
  assert.doesNotMatch(markup, /npm test/)
})

test('provider fallback renders a retry/switch notice line', () => {
  const failover = render({
    meta: { streaming: true, modelFallback: { kind: 'failover', from: 'primary', to: 'backup', modelName: 'm1' } },
  })
  assert.match(failover, /data-testid="model-fallback"/)
  assert.match(failover, /Switched model provider/)
  assert.match(failover, /backup/)

  const retry = render({
    meta: { streaming: true, modelFallback: { kind: 'retry', attempt: 3, modelName: 'm1' } },
  })
  assert.match(retry, /data-testid="model-fallback"/)
  assert.match(retry, /Retrying model/)
  assert.match(retry, /\(3\)/)
})

test('absent fallback metadata renders no fallback line', () => {
  const markup = render({
    meta: { streaming: true, modelActivity: { kind: 'tool_call_ready', toolName: 'bash_exec' }, toolCalls: [] },
  })
  assert.doesNotMatch(markup, /data-testid="model-fallback"/)
})

test('reconnection status overrides a stale running tool state', () => {
  const markup = render({
    meta: {
      streaming: true,
      serverConnectionState: 'reconnecting',
      modelActivity: { kind: 'model' },
      toolCalls: [{ id: 'bash-1', name: 'bash_exec', status: 'running' }],
    },
  })
  assert.match(markup, /data-testid="model-activity"/)
  assert.match(markup, /Reconnecting/)
})

test('activity status follows the supported UI languages and falls back to English', () => {
  const expected = {
    zh: '模型正在思考下一步…',
    en: 'Model is reasoning through the next step…',
    ja: 'Model is reasoning through the next step…',
    ko: 'Model is reasoning through the next step…',
    'zh-TW': 'Model is reasoning through the next step…',
  }
  for (const [language, copy] of Object.entries(expected)) {
    const markup = render({ meta: { streaming: true, modelActivity: { kind: 'reasoning' } } }, language)
    assert.match(markup, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), language)
  }
})
