import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultSettingsSection,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_DIAGNOSTICS,
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_PET,
  SETTINGS_TAB_WEB_SEARCH,
  resolveSettingsNavFromSearch,
  resolveSettingsSectionFromSearch,
  settingsPathAfterLogin,
  settingsPathForSection,
} from '../src/lib/settingsNavigation.js'

test('after login lands on settings; the removed account tab falls back to features', () => {
  assert.equal(settingsPathAfterLogin({ hasPassword: false }), '/settings')
  assert.equal(settingsPathAfterLogin({ hasPassword: true }), '/settings')
  assert.equal(settingsPathAfterLogin(null), '/settings')

  assert.equal(resolveSettingsNavFromSearch('?tab=account'), SETTINGS_TAB_FEATURES)
  assert.equal(resolveSettingsNavFromSearch(''), SETTINGS_TAB_FEATURES)
  assert.equal(resolveSettingsNavFromSearch('?tab=models'), SETTINGS_TAB_MODELS)
  assert.equal(resolveSettingsSectionFromSearch('?tab=models'), SETTINGS_TAB_MODELS)
})

test('every settings module round-trips through its canonical URL as an independent destination', () => {
  const sections = [
    [SETTINGS_TAB_FEATURES, '/settings'],
    [SETTINGS_TAB_MODELS, '/settings?tab=models'],
    [SETTINGS_TAB_WEB_SEARCH, '/settings?tab=web-search'],
    [SETTINGS_TAB_INTEGRATIONS, '/settings?tab=integrations'],
    [SETTINGS_TAB_FILES, '/settings?tab=files'],
    [SETTINGS_TAB_PERMISSIONS, '/settings?tab=permissions'],
    [SETTINGS_TAB_APPEARANCE, '/settings?tab=appearance'],
    [SETTINGS_TAB_LANGUAGE, '/settings?tab=language'],
    [SETTINGS_TAB_PET, '/settings?tab=pet'],
    [SETTINGS_TAB_DIAGNOSTICS, '/settings?tab=diagnostics'],
    [SETTINGS_TAB_DATA, '/settings?tab=data'],
  ]

  for (const [section, expectedPath] of sections) {
    const path = settingsPathForSection(section)
    const search = new URL(`http://localhost${path}`).search
    assert.equal(path, expectedPath)
    assert.equal(resolveSettingsSectionFromSearch(search), section)
    assert.equal(resolveSettingsNavFromSearch(search), section)
    assert.equal(defaultSettingsSection(section), section)
  }
})

test('settings page defaults and unknown tabs resolve to canonical safe destinations', () => {
  assert.equal(defaultSettingsSection('unknown'), SETTINGS_TAB_FEATURES)
  assert.equal(settingsPathForSection('unknown'), '/settings')
  assert.equal(resolveSettingsSectionFromSearch('?tab=unknown'), SETTINGS_TAB_FEATURES)
  assert.equal(resolveSettingsNavFromSearch('?tab=unknown'), SETTINGS_TAB_FEATURES)
})
