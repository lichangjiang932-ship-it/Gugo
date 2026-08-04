import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const messagesSource = fs.readFileSync(
  new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url),
  'utf8',
)
const viewSource = fs.readFileSync(
  new URL('../src/pages/ChatSplit/ChatSplitView.jsx', import.meta.url),
  'utf8',
)

test('new conversations render an actionable localized welcome state', () => {
  assert.match(messagesSource, /data-testid="new-conversation-welcome"/)
  assert.match(messagesSource, /STARTER_PROMPTS\.map/)
  assert.match(messagesSource, /chatMessages\.emptyTitle/)
  assert.match(messagesSource, /chatMessages\.emptyHint/)
  assert.match(messagesSource, /onPromptSelect\?\./)
  assert.doesNotMatch(messagesSource, /<div className="min-h-0 flex-1" aria-hidden="true" \/>/)
  assert.match(viewSource, /onPromptSelect=\{setInput\}/)
})
