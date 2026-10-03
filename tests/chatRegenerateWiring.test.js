import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Message editing was removed from the chat surface; what remains is the
// model-failure resend path, which must stay wired without regenerating the
// assistant for an ordinary user edit.
test('chat keeps model failure resend without assistant regeneration wiring', () => {
  const source = [
    '../src/pages/ChatSplit/index.jsx',
    '../src/pages/ChatSplit/chatReplayActions.js',
  ].map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

  assert.doesNotMatch(source, /handleRegenerateMessage|canRegenerateAssistantMessage|onRegenerateMessage/)
  assert.doesNotMatch(source, /handleEditMessage|onEditMessage=/)
  assert.doesNotMatch(source, /flushSync/)
  assert.match(source, /buildModelFailureRetryRequest/)
  assert.match(source, /handleRetryModelFailure/)
  assert.match(source, /if \(!modelReadiness\.canSend\)[\s\S]{0,160}showModelUnavailable\(modelReadiness\)/)
  assert.match(source, /onRetryModelFailure=\{handleRetryModelFailure\}/)
})
