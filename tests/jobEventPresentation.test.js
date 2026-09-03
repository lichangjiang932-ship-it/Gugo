import assert from 'node:assert/strict'
import test from 'node:test'

import { translations, translateKey } from '../src/i18n/translations.js'
import {
  legacyJobEventMessage,
  localizedJobEventMessage,
} from '../src/pages/taskRun/jobEventPresentation.js'

function translator(language) {
  return (key, params = {}) => String(translateKey(key, language)).replace(
    /\{(\w+)\}/g,
    (_, name) => Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`,
  )
}

test('code-only Job events use supported languages and fall back to English without server copy', () => {
  const expected = {
    zh: '任务已创建',
    en: 'Task created',
    ja: 'Task created',
    ko: 'Task created',
    'zh-TW': 'Task created',
  }
  for (const [language, message] of Object.entries(expected)) {
    assert.equal(localizedJobEventMessage({
      code: 'JOB_CREATED',
      message: '不应跨越新事件边界的服务端文案',
      params: {},
    }, translator(language)), message)
  }
})

test('Job event params are interpolated by the client translation', () => {
  assert.equal(localizedJobEventMessage({
    code: 'JOB_STEP_VERIFIED',
    params: { title: 'Build', evidenceCount: 3 },
  }, translator('en')), 'Step “Build” completed with 3 verification records')
})

test('stable model failure codes localize without using a new event message fallback', () => {
  const message = localizedJobEventMessage({
    code: 'JOB_FAILED',
    message: '服务端诊断文案',
    params: {},
    payload: { code: 'MODEL_TIMEOUT' },
  }, translator('en'))
  assert.equal(message, `[MODEL_TIMEOUT] ${translations.en.modelProviders.errorTimeout}`)
  assert.doesNotMatch(message, /服务端诊断文案/u)
})

test('persisted pre-code Job events use the isolated legacy message parser', () => {
  const legacy = { type: 'created', message: '历史事件原文' }
  assert.equal(legacyJobEventMessage(legacy), '历史事件原文')
  assert.equal(localizedJobEventMessage(legacy, translator('en')), '历史事件原文')
  assert.equal(legacyJobEventMessage({ ...legacy, code: 'JOB_CREATED' }), '')
})

test('unknown future Job event codes remain diagnosable', () => {
  assert.equal(
    localizedJobEventMessage({ code: 'JOB_FUTURE_EVENT', params: {} }, translator('en')),
    'Task event: JOB_FUTURE_EVENT',
  )
})
