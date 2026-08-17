import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultSettingsSection,
  SETTINGS_TAB_ABOUT,
  SETTINGS_TAB_AGENT_PRESETS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_DIAGNOSTICS,
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_PET,
  SETTINGS_TAB_PLUGINS,
  SETTINGS_TAB_WEB_SEARCH,
  resolveSettingsNavFromSearch,
  resolveSettingsSectionFromSearch,
  settingsPathAfterLogin,
  settingsPathForSection,
} from '../src/lib/settingsNavigation.js'

test('after login lands on general settings; removed tabs resolve safely', () => {
  assert.equal(settingsPathAfterLogin({ hasPassword: false }), '/settings')
  assert.equal(settingsPathAfterLogin({ hasPassword: true }), '/settings')
  assert.equal(settingsPathAfterLogin(null), '/settings')

  assert.equal(resolveSettingsNavFromSearch('?tab=account'), SETTINGS_TAB_GENERAL)
  assert.equal(resolveSettingsNavFromSearch(''), SETTINGS_TAB_GENERAL)
  assert.equal(resolveSettingsNavFromSearch('?tab=models'), SETTINGS_TAB_MODELS)
  assert.equal(resolveSettingsSectionFromSearch('?tab=models'), SETTINGS_TAB_MODELS)
})

test('every settings module round-trips through its canonical URL as an independent destination', () => {
  const sections = [
    [SETTINGS_TAB_FEATURES, '/settings'],
    [SETTINGS_TAB_GENERAL, '/settings'],
    [SETTINGS_TAB_MODELS, '/settings?tab=models'],
    [SETTINGS_TAB_APPEARANCE, '/settings?tab=appearance'],
    [SETTINGS_TAB_LANGUAGE, '/settings?tab=language'],
    [SETTINGS_TAB_PLUGINS, '/settings?tab=plugins'],
    [SETTINGS_TAB_WEB_SEARCH, '/settings?tab=web-search'],
    [SETTINGS_TAB_PERMISSIONS, '/settings?tab=permissions'],
    [SETTINGS_TAB_AGENT_PRESETS, '/settings?tab=agent-presets'],
    [SETTINGS_TAB_INTEGRATIONS, '/settings?tab=integrations'],
    [SETTINGS_TAB_DATA, '/settings?tab=data'],
    [SETTINGS_TAB_ABOUT, '/settings?tab=about'],
  ]

  for (const [section, expectedPath] of sections) {
    const path = settingsPathForSection(section)
    const search = new URL(`http://localhost${path}`).search
    assert.equal(path, expectedPath)
    const expectedSection = section === SETTINGS_TAB_FEATURES ? SETTINGS_TAB_GENERAL : section
    assert.equal(resolveSettingsSectionFromSearch(search), expectedSection)
    assert.equal(resolveSettingsNavFromSearch(search), expectedSection)
    assert.equal(defaultSettingsSection(section), expectedSection)
  }
})

test('settings page defaults and unknown tabs resolve to canonical safe destinations', () => {
  assert.equal(defaultSettingsSection('unknown'), SETTINGS_TAB_GENERAL)
  assert.equal(settingsPathForSection('unknown'), '/settings')
  assert.equal(resolveSettingsSectionFromSearch('?tab=unknown'), SETTINGS_TAB_GENERAL)
  assert.equal(resolveSettingsNavFromSearch('?tab=unknown'), SETTINGS_TAB_GENERAL)
  assert.equal(defaultSettingsSection(SETTINGS_TAB_FEATURES), SETTINGS_TAB_GENERAL)
  assert.equal(settingsPathForSection(SETTINGS_TAB_FEATURES), '/settings')
  for (const legacy of [SETTINGS_TAB_FILES, SETTINGS_TAB_PET]) {
    assert.equal(defaultSettingsSection(legacy), SETTINGS_TAB_GENERAL)
    assert.equal(settingsPathForSection(legacy), `/settings?tab=${legacy}`)
  }
  assert.equal(defaultSettingsSection(SETTINGS_TAB_DIAGNOSTICS), SETTINGS_TAB_ABOUT)
  assert.equal(settingsPathForSection(SETTINGS_TAB_DIAGNOSTICS), '/settings?tab=diagnostics')
  assert.equal(resolveSettingsSectionFromSearch('?tab=files'), SETTINGS_TAB_GENERAL)
  assert.equal(resolveSettingsSectionFromSearch('?tab=pet'), SETTINGS_TAB_GENERAL)
  assert.equal(resolveSettingsSectionFromSearch('?tab=diagnostics'), SETTINGS_TAB_ABOUT)
})
