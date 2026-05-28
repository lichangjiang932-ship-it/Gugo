import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SETTINGS_TAB_ACCOUNT,
  SETTINGS_TAB_FEATURES,
  resolveSettingsNavFromSearch,
  settingsPathAfterLogin,
  shouldPromptPasswordSetup,
} from '../src/lib/settingsNavigation.js'

test('login without a password goes directly to account password setup', () => {
  assert.equal(
    settingsPathAfterLogin({ hasPassword: false }),
    '/settings?tab=account&setupPassword=1',
  )
  assert.equal(settingsPathAfterLogin({ hasPassword: true }), '/settings')
  assert.equal(settingsPathAfterLogin(null), '/settings')
})

test('settings query opens account tab and prompts only when password is missing', () => {
  assert.equal(resolveSettingsNavFromSearch('?tab=account'), SETTINGS_TAB_ACCOUNT)
  assert.equal(resolveSettingsNavFromSearch(''), SETTINGS_TAB_FEATURES)

  assert.equal(
    shouldPromptPasswordSetup('?tab=account&setupPassword=1', { hasPassword: false }),
    true,
  )
  assert.equal(
    shouldPromptPasswordSetup('?tab=account&setupPassword=1', { hasPassword: true }),
    false,
  )
})
