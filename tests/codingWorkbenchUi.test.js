import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { lookup, translations } from '../src/i18n/translations.js'

test('chat page wires code mode to the Coding Workbench panel', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(source, /CodingWorkbench/)
  assert.match(source, /agentMode === 'code'/)
})

test('Coding Workbench exposes diff, checks, and commit/push controls', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/CodingWorkbench.jsx', import.meta.url), 'utf8')
  assert.match(source, /codingWorkbench\.unifiedDiff/)
  assert.match(source, /codingWorkbench\.runLint/)
  assert.match(source, /codingWorkbench\.runTests/)
  assert.match(source, /codingWorkbench\.runBuild/)
  assert.match(source, /codingWorkbench\.commitAndPush/)
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(lookup(translations[lang], 'codingWorkbench.unifiedDiff'))
    assert.ok(lookup(translations[lang], 'codingWorkbench.commitAndPush'))
  }
})
