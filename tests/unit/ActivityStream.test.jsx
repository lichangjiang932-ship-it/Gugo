import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import ActivityStream from '../../src/pages/ChatSplit/chatMessages/ActivityStream.jsx'

function render(msg) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ActivityStream msg={msg} />
    </I18nProvider>,
  )
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
    meta: { streaming: true, reasoning: 'secret chain of thought' },
  })
  assert.match(markup, /role="status"/)
  assert.doesNotMatch(markup, /secret chain of thought/)
})

test('tool activity renders interleaved text lines with a live output tail', () => {
  const markup = render({
    meta: {
      streaming: true,
      toolCalls: [
        { id: 'read-1', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success' },
        { id: 'bash-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running', liveOutput: 'PASS\n2 passing' },
      ],
    },
  })
  assert.match(markup, /chat-activity-stream/)
  assert.match(markup, /D:\/work\/a\.js/)
  assert.match(markup, /npm test/)
  assert.match(markup, /data-testid="activity-live-output"/)
  assert.match(markup, /2 passing/)
})

test('failed calls surface an error-styled line', () => {
  const markup = render({
    meta: {
      streaming: true,
      toolCalls: [
        { id: 'bad-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'error' },
      ],
    },
  })
  assert.match(markup, /chat-activity-line-error/)
  assert.match(markup, /npm test/)
})

test('provider fallback renders a retry/switch notice line', () => {
  const failover = render({
    meta: { streaming: true, modelFallback: { kind: 'failover', from: 'primary', to: 'backup', modelName: 'm1' } },
  })
  assert.match(failover, /data-testid="model-fallback"/)
  assert.match(failover, /已切换模型提供方/)
  assert.match(failover, /backup/)

  const retry = render({
    meta: { streaming: true, modelFallback: { kind: 'retry', attempt: 3, modelName: 'm1' } },
  })
  assert.match(retry, /data-testid="model-fallback"/)
  assert.match(retry, /正在重试模型/)
  assert.match(retry, /\(3\)/)
})

test('absent fallback metadata renders no fallback line', () => {
  const markup = render({
    meta: { streaming: true, modelActivity: { kind: 'tool_call_ready', toolName: 'bash_exec' }, toolCalls: [] },
  })
  assert.doesNotMatch(markup, /data-testid="model-fallback"/)
})
