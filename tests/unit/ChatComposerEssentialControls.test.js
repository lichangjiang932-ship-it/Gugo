import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from '../sourceTree.js'

const chatComposerSource = fs.readFileSync(
  new URL('../../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url),
  'utf8',
)
const chatSendActionsSource = fs.readFileSync(
  new URL('../../src/pages/ChatSplit/chatSendActions.js', import.meta.url),
  'utf8',
)
const composerSource = readSourceTree('../src/pages/ChatSplit/chatComposer/') + chatComposerSource

test('chat composer keeps only essential input controls', () => {
  assert.match(composerSource, /<textarea/)
  assert.match(composerSource, /<Plus/)
  assert.match(composerSource, /<PermissionModeSwitcher/)
  assert.match(composerSource, /<ModelPicker/)
  assert.match(composerSource, /data-testid="context-ring"/)
  assert.match(composerSource, /<Send/)
  assert.doesNotMatch(composerSource, />Enter<\/span>/)
  assert.doesNotMatch(
    composerSource,
    /LocalFilesModal|local-files-chat-action|QUICK_SKILLS|SlashAutocomplete|onContextClick/,
  )
})

test('chat composer keeps keyboard history without rendering shortcut hints in the input', () => {
  assert.doesNotMatch(
    chatComposerSource,
    /inputHistoryNavigation|historyHint|sendHint|<kbd|↑\s*\/?\s*↓|查看历史|Enter\s*(?:发送|Send)/i,
  )
  assert.match(chatComposerSource, /handleKeyDown\(e\)/)
  assert.match(chatSendActionsSource, /if \(isChatCompositionEvent\(event\)\) return/)
  assert.match(chatSendActionsSource, /if \(navigateInputHistory\(event\)\) return/)
  assert.match(chatSendActionsSource, /if \(shouldSubmitChatKey\(event\)\)/)
})

test('project selection is shown only before a workspace is selected or any message is sent', () => {
  const chatSplitViewSource = fs.readFileSync(
    new URL('../../src/pages/ChatSplit/ChatSplitView.jsx', import.meta.url),
    'utf8',
  )
  assert.match(
    chatSplitViewSource,
    /showWorkspacePicker=\{messages\.length === 0 && !String\(selectedWorkspacePath \|\| ''\)\.trim\(\)\}/,
  )
  assert.match(chatComposerSource, /\{showWorkspacePicker && \(/)
  assert.doesNotMatch(chatComposerSource, /!String\(selectedWorkspacePath/)
})
