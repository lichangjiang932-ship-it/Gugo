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
  // Starters are chosen by context: code tasks in a project, general ones without.
  assert.match(messagesSource, /const starters = project \? CODE_STARTERS : GENERAL_STARTERS/)
  assert.match(messagesSource, /starters\.map/)
  assert.match(messagesSource, /welcome\.title/)
  assert.match(messagesSource, /welcome\.hint/)
  assert.match(messagesSource, /onPromptSelect\?\./)
  assert.match(messagesSource, /data-testid="gugo-mark"/)
  assert.doesNotMatch(messagesSource, /<Sparkles className="h-6 w-6"/)
  assert.doesNotMatch(messagesSource, /<div className="min-h-0 flex-1" aria-hidden="true" \/>/)
  assert.match(viewSource, /onPromptSelect=\{setInput\}/)
})

test('each starter has a title, a description and a sendable prompt in both languages', async () => {
  const { translateKey } = await import('../src/i18n/translations.js')
  const keys = [...messagesSource.matchAll(/\{ key: '(\w+)', icon:/g)].map((match) => match[1])
  assert.deepEqual(keys, ['codeExplain', 'codeBug', 'codeFeature', 'codeReview', 'research', 'doc', 'data', 'slides'])
  for (const lang of ['zh', 'en']) {
    for (const key of keys) {
      for (const part of ['Title', 'Desc', 'Prompt']) {
        const value = translateKey(`welcome.${key}${part}`, lang)
        assert.ok(value && value !== `welcome.${key}${part}`, `${lang}: welcome.${key}${part}`)
      }
    }
  }
})
