import assert from 'node:assert/strict'
import test from 'node:test'

import { localizeLoginError } from '../src/components/leftRail/useLeftRailController.js'
import leftRailLogin from '../src/i18n/domains/leftRailLogin.js'

function localizedT(locale, key) {
  if (key === 'errors.unknown') {
    return locale === 'zh' ? '出现未知错误。' : 'An unknown error occurred.'
  }
  const prefix = 'leftRailLogin.'
  return key.startsWith(prefix) ? leftRailLogin[locale][key.slice(prefix.length)] : key
}

test('left rail login errors use only local code mappings, never server messages', () => {
  assert.equal(
    localizeLoginError({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '邮箱或密码不正确',
    }, (key) => localizedT('zh', key)),
    '邮箱或密码不正确。',
  )
  assert.equal(
    localizeLoginError({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '邮箱或密码不正确',
    }, (key) => localizedT('en', key)),
    'The email or password is incorrect.',
  )
  assert.equal(
    localizeLoginError({
      code: 'SERVER_PRIVATE_DETAIL',
      message: '服务端内部中文详情',
    }, (key) => localizedT('en', key)),
    'An unknown error occurred.',
  )
})
