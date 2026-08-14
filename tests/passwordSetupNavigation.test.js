import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_MODELS,
  resolveSettingsNavFromSearch,
  settingsPathAfterLogin,
} from '../src/lib/settingsNavigation.js'

test('after login lands on settings; the removed account tab falls back to features', () => {
  assert.equal(settingsPathAfterLogin({ hasPassword: false }), '/settings')
  assert.equal(settingsPathAfterLogin({ hasPassword: true }), '/settings')
  assert.equal(settingsPathAfterLogin(null), '/settings')

  assert.equal(resolveSettingsNavFromSearch('?tab=account'), SETTINGS_TAB_FEATURES)
  assert.equal(resolveSettingsNavFromSearch(''), SETTINGS_TAB_FEATURES)
  assert.equal(resolveSettingsNavFromSearch('?tab=models'), SETTINGS_TAB_MODELS)
})
