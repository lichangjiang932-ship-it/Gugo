import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { lookup, translations } from '../src/i18n/translations.js'

test('chat page exposes Coding Workbench without Chat/Plan/Code mode switching', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(source, /CodingWorkbench/)
  assert.match(source, /showCodingWorkbench/)
  const header = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatHeader.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(header, /AGENT_MODES|onAgentModeChange/)
  assert.doesNotMatch(header, /onAgentChange|\bactiveAgent\b|\bUsers\b/)
  assert.equal((header.match(/onClick={onNavigateTask}/g) || []).length, 1)
  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  assert.match(settings, /path: '\/agents'.*人物与性格/)
})

test('chat composer keeps local-file authorization beside all skills and removes the duplicate settings page', () => {
  const composer = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  assert.match(composer, /LocalFilesModal/)
  assert.match(composer, /local-files-chat-action/)
  assert.ok(composer.indexOf('+ 全部技能') < composer.indexOf("t('localFiles.chatAction')"))

  const modal = fs.readFileSync(new URL('../src/components/LocalFilesModal.jsx', import.meta.url), 'utf8')
  assert.match(modal, /<LocalFilesPanel \/>/)
  assert.match(modal, /event\.key === 'Escape'/)
  assert.match(modal, /event\.target === event\.currentTarget/)

  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(settings, /import LocalFilesPanel/)
  assert.doesNotMatch(settings, /return <LocalFilesPanel/)
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(lookup(translations[lang], 'localFiles.chatAction'))
  }
})

test('model management has a dedicated settings page and refreshes the chat model picker', () => {
  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  const header = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatHeader.jsx', import.meta.url), 'utf8')
  const chat = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const rail = fs.readFileSync(new URL('../src/components/LeftRail.jsx', import.meta.url), 'utf8')
  assert.match(settings, /function renderModels\(\)/)
  assert.match(settings, /case SETTINGS_TAB_MODELS:/)
  assert.match(header, /管理模型/)
  assert.match(chat, /auth:required/)
  assert.match(chat, /path: '\/settings\?tab=models'/)
  assert.match(rail, /addEventListener\('auth:required'/)
  assert.match(rail, /loginTarget \|\| defaultPath/)
  assert.match(chat, /addEventListener\('model-providers:changed'/)
})

test('unused phone, hooks, cron, and global-shortcut routes are not exposed', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /GlobalShortcuts|CommandPalette|SkillCommandsSync|MobileKeysView|HooksView|CronJobsPage/)
  assert.doesNotMatch(app, /path="\/(?:mobile-keys|hooks|cron)"/)
  assert.doesNotMatch(settings, /path: '\/(?:mobile-keys|hooks|cron)'/)
  assert.doesNotMatch(settings, /function renderShortcuts/)
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
