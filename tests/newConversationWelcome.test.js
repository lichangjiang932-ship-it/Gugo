import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readSourceTree } from './sourceTree.js'

const messagesSource = readSourceTree('../src/pages/ChatSplit/chatMessages/')
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
  assert.match(messagesSource, /data-testid="gugo-mark"/)
  assert.doesNotMatch(messagesSource, /<Sparkles className="h-6 w-6"/)
  assert.doesNotMatch(messagesSource, /<div className="min-h-0 flex-1" aria-hidden="true" \/>/)
  assert.match(viewSource, /onPromptSelect=\{setInput\}/)
})
