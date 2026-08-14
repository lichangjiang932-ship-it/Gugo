import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from '../sourceTree.js'

const composerSource = readSourceTree('../src/pages/ChatSplit/chatComposer/') + fs.readFileSync(
  new URL('../../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url),
  'utf8',
)

test('chat composer keeps only essential input controls', () => {
  assert.match(composerSource, /<textarea/)
  assert.match(composerSource, /<Paperclip/)
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
