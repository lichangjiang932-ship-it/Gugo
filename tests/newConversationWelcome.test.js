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

test('the welcome names a missing model instead of looking ready to work', async () => {
  const welcomeSource = fs.readFileSync(
    new URL('../src/pages/ChatSplit/chatMessages/NewConversationWelcome.jsx', import.meta.url),
    'utf8',
  )
  assert.match(welcomeSource, /data-testid="welcome-model-blocker"/)
  assert.match(welcomeSource, /data-testid="welcome-configure-model"/)
  assert.match(welcomeSource, /BLOCKING_READINESS_KINDS\.has\(String\(modelReadinessKind\)\)/)
  // A load in progress resolves on its own, and a chat-only provider can still
  // send — neither is something the reader has to act on, so neither is blocking.
  assert.doesNotMatch(welcomeSource, /'loading'|'provider-chat-only'/)
  assert.match(viewSource, /modelReadinessKind=\{modelReadiness\?\.kind \|\| ''\}/)
  assert.match(viewSource, /onConfigureModel=\{onOpenModelPicker\}/)
  const { translateKey } = await import('../src/i18n/translations.js')
  for (const lang of ['zh', 'en']) {
    for (const key of ['welcome.modelNotReady', 'welcome.modelNotReadyAction']) {
      assert.ok(translateKey(key, lang) && translateKey(key, lang) !== key, `${lang}: ${key}`)
    }
  }
})
