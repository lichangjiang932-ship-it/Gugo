import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { lookup, translations } from '../src/i18n/translations.js'

test('chat page keeps Coding Workbench and task actions out of the conversation chrome', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /CodingWorkbench|showCodingWorkbench|<ChatHeader/)
  const settingsPanels = fs.readFileSync(new URL('../src/components/settings/SettingsSecondaryPanels.jsx', import.meta.url), 'utf8')
  assert.match(settingsPanels, /\['\/agents', Users,/)
})

test('chat composer removes local-file and quick-skill clutter', () => {
  const composer = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(composer, /LocalFilesModal|local-files-chat-action|QUICK_SKILLS|SlashAutocomplete/)

  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(settings, /import LocalFilesPanel/)
  assert.doesNotMatch(settings, /return <LocalFilesPanel/)
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(lookup(translations[lang], 'localFiles.chatAction'))
  }
})

test('model management has a dedicated settings page and refreshes the chat model picker', () => {
  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  const composer = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  const composerActions = fs.readFileSync(new URL('../src/pages/ChatSplit/chatComposer/ComposerActions.jsx', import.meta.url), 'utf8')
  const modelPicker = fs.readFileSync(new URL('../src/pages/ChatSplit/ModelPicker.jsx', import.meta.url), 'utf8')
  const chat = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const runtimeCatalog = fs.readFileSync(new URL('../src/pages/ChatSplit/useChatRuntimeCatalog.js', import.meta.url), 'utf8')
  const rail = fs.readFileSync(new URL('../src/components/leftRail/useLeftRailController.js', import.meta.url), 'utf8')
  assert.match(settings, /function renderModels\(\)/)
  assert.match(settings, /case SETTINGS_TAB_MODELS:/)
  assert.match(composer, /<ComposerActions/)
  assert.match(composerActions, /<ModelPicker/)
  assert.match(modelPicker, /chat\.modelPicker\.manage/)
  assert.match(chat, /onManageModels={handleManageModels}/)
  assert.match(chat, /auth:required/)
  assert.match(chat, /path: '\/settings\?tab=models'/)
  assert.match(rail, /addEventListener\('auth:required'/)
  assert.match(rail, /login\.target \|\| defaultPath/)
  assert.match(runtimeCatalog, /addEventListener\('model-providers:changed'/)
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(lookup(translations[lang], 'chat.modelPicker.manage'))
  }
})

test('unused phone, hooks, cron, and global-shortcut routes are not exposed', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../src/pages/SettingsView.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /GlobalShortcuts|SkillCommandsSync|MobileKeysView|HooksView|CronJobsPage/)
  assert.match(app, /<CommandPalette \/>/)
  assert.doesNotMatch(app, /path="\/(?:mobile-keys|hooks|cron)"/)
  assert.doesNotMatch(settings, /path: '\/(?:mobile-keys|hooks|cron)'/)
  assert.doesNotMatch(settings, /function renderShortcuts/)
})

test('the root route opens chat directly without the removed 3D cover', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(app, /<Route path="\/" element={<Navigate to="\/chat" replace \/>} \/>/)
  assert.doesNotMatch(app, /CoverPage|CoverScene/)
  for (const file of ['CoverPage.jsx', 'CoverScene.jsx', 'index.jsx']) {
    assert.equal(fs.existsSync(new URL(`../src/pages/CoverPage/${file}`, import.meta.url)), false, file)
  }
  for (const dependency of ['@react-three/fiber', '@react-three/postprocessing', 'three']) {
    assert.equal(pkg.dependencies?.[dependency], undefined, dependency)
  }
})

test('Coding Workbench stays detached from the chat surface', () => {
  const chat = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const preferences = fs.readFileSync(new URL('../src/lib/chatUiPreferences.js', import.meta.url), 'utf8')
  assert.doesNotMatch(preferences, /CODING_WORKBENCH_STORAGE_KEY/)
  assert.doesNotMatch(chat, /useState\(readCodingWorkbenchOpen\)|<CodingWorkbench/)
})
