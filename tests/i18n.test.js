// i18n v1 测试 —— 纯 Node（不依赖 React DOM）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  translations,
  translateKey,
  lookup,
  normalizeUiLanguage,
  SLASH_ACTION_COPY,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} from '../src/i18n/translations.js'

function leafKeys(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      out.push(...leafKeys(v, path))
    } else {
      out.push(path)
    }
  }
  return out
}

test('UI 仅保留并公开 zh / en 翻译数据', () => {
  assert.ok(translations.zh, 'zh 缺失')
  assert.ok(translations.en, 'en 缺失')
  assert.deepEqual(Object.keys(translations).sort(), ['en', 'zh'])
  assert.equal(DEFAULT_LANGUAGE, 'zh')
  assert.deepEqual(
    SUPPORTED_LANGUAGES.map((l) => l.code).sort(),
    ['en', 'zh'],
  )
})

test('旧语言持久值安全回退到英文', () => {
  assert.equal(normalizeUiLanguage(undefined), 'zh')
  assert.equal(normalizeUiLanguage('zh'), 'zh')
  assert.equal(normalizeUiLanguage('en-US'), 'en')
  assert.equal(normalizeUiLanguage('ja'), 'en')
  assert.equal(normalizeUiLanguage('ko'), 'en')
  assert.equal(normalizeUiLanguage('zh-TW'), 'en')
})

test('slash action copy only exposes symmetric zh / en data', () => {
  assert.deepEqual(Object.keys(SLASH_ACTION_COPY).sort(), ['en', 'zh'])
  assert.deepEqual(
    leafKeys(SLASH_ACTION_COPY.zh).sort(),
    leafKeys(SLASH_ACTION_COPY.en).sort(),
  )
})

test('QQ Mail local environment fallback is explained in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const hint = translations[lang]?.access?.qqMailPasswordHint || ''
    assert.match(hint, /MAIL_\*/)
    assert.ok(hint.length >= 20, `${lang} QQ Mail hint is incomplete`)
  }
})

test('input history navigation setting copy exists in both languages', () => {
  for (const lang of ['zh', 'en']) {
    assert.ok(translations[lang]?.settings?.inputHistoryNavigation)
    assert.ok(translations[lang]?.settings?.inputHistoryNavigationDescription)
  }
})

test('execution activity copy exists in both languages', () => {
  const keys = [
    'toolCallLabel', 'toolCalls', 'expandToolDetails', 'collapseToolDetails', 'toolCopyDetail',
    'toolStandingRule', 'toolStandingRuleScope', 'toolRetry', 'toolLiveOutputReplayNote',
    'activityReasoning', 'activityModelConnecting', 'activityWaitingFirstOutput', 'activityModelPaused',
    'activityModelRetrying', 'activityModelWorking', 'activityReceivingOutput', 'activityWorkingPhase',
    'activityProcessing', 'executionToolCount',
  ]
  const toolCounts = {
    zh: '{count} 个工具',
    en: '{count} tools',
  }
  for (const [language, expectedToolCount] of Object.entries(toolCounts)) {
    for (const key of keys) {
      assert.ok(translations[language]?.chatMessages?.[key], `${language}.chatMessages.${key}`)
    }
    assert.equal(translations[language].chatMessages.executionToolCount, expectedToolCount)
  }
})

test('external and model-provider fee warnings are explicit in both languages', () => {
  const markers = {
    zh: { external: '外部服务', provider: '上游模型供应商' },
    en: { external: 'external service', provider: 'upstream model provider' },
  }
  for (const [language, marker] of Object.entries(markers)) {
    assert.ok(translations[language].chatMessages.sideEffectUnknownBody.includes(marker.external), language)
    assert.ok(translations[language].sideEffectRecovery.safetyWarning.includes(marker.external), language)
    assert.ok(translations[language].chatMessages.modelRequestUnknownBody.includes(marker.provider), language)
    assert.ok(translations[language].modelRequestRecovery.warning.includes(marker.provider), language)
    assert.ok(translations[language].modelRequestRecovery.verify.includes(marker.provider), language)
  }
})

test('model provider settings omit the removed billing notice in both languages', () => {
  for (const language of ['zh', 'en']) {
    assert.equal(Object.hasOwn(translations[language]?.modelProviders || {}, 'byokNotice'), false, language)
  }
})

test('task center model readiness copy distinguishes configuration and Agent capability in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const copy = translations[lang]?.taskCenter?.modelReadiness
    assert.ok(copy?.unconfigured, `${lang}: unconfigured`)
    assert.ok(copy?.untested, `${lang}: untested`)
    assert.ok(copy?.chatOnly, `${lang}: chatOnly`)
    assert.ok(copy?.agentReady, `${lang}: agentReady`)
    assert.ok(copy?.unavailable, `${lang}: unavailable`)
    assert.ok(copy?.configure, `${lang}: configure`)
  }
})

test('directory authorization lifetime copy exists in both languages', () => {
  for (const lang of ['zh', 'en']) {
    assert.ok(translations[lang]?.localFiles?.authorizationLifetime)
    assert.ok(translations[lang]?.localFiles?.authorizationSession)
    assert.ok(translations[lang]?.localFiles?.authorizationPersistent)
  }
})

test('旧语言代码不保留翻译数据并统一回退到英文', () => {
  for (const lang of ['ja', 'ko', 'zh-TW']) {
    assert.equal(Object.hasOwn(translations, lang), false, `${lang} 不应保留物理翻译数据`)
    assert.equal(translateKey('nav.home', lang), translations.en.nav.home)
    assert.equal(translateKey('errors.chatFailure', lang), translations.en.errors.chatFailure)
  }
})

test('translations 结构合法：zh 和 en 都有 nav/settings/errors 至少 3 个 key', () => {
  for (const lang of ['zh', 'en']) {
    const dict = translations[lang]
    for (const domain of ['nav', 'settings', 'errors']) {
      assert.ok(dict[domain], `${lang}.${domain} 缺失`)
      const keys = Object.keys(dict[domain])
      assert.ok(keys.length >= 3, `${lang}.${domain} 至少 3 个 key，实际 ${keys.length}`)
    }
  }
})

test('nav 域至少 5 个 key 中英文都齐', () => {
  const zhNav = Object.keys(translations.zh.nav).sort()
  const enNav = Object.keys(translations.en.nav).sort()
  assert.ok(zhNav.length >= 5, `zh.nav 至少 5 个 key`)
  assert.ok(enNav.length >= 5, `en.nav 至少 5 个 key`)
  assert.deepEqual(zhNav, enNav, 'zh.nav 与 en.nav key 必须一一对应')
})

test('zh / en 全量 key 一一对应（缺一个就 fail）', () => {
  const zhKeys = leafKeys(translations.zh).sort()
  const enKeys = leafKeys(translations.en).sort()
  const onlyInZh = zhKeys.filter((k) => !enKeys.includes(k))
  const onlyInEn = enKeys.filter((k) => !zhKeys.includes(k))
  assert.deepEqual(onlyInZh, [], `只在 zh 中存在：${onlyInZh.join(', ')}`)
  assert.deepEqual(onlyInEn, [], `只在 en 中存在：${onlyInEn.join(', ')}`)
})

test('settings 域至少 8 个 key', () => {
  assert.ok(Object.keys(translations.zh.settings).length >= 8)
  assert.ok(Object.keys(translations.en.settings).length >= 8)
})

test('errors 域至少 5 个 key', () => {
  assert.ok(Object.keys(translations.zh.errors).length >= 5)
  assert.ok(Object.keys(translations.en.errors).length >= 5)
})

test('translateKey 基本命中：zh', () => {
  assert.equal(translateKey('nav.home', 'zh'), '首页')
  assert.equal(translateKey('nav.chat', 'zh'), '对话')
})

test('translateKey 基本命中：en', () => {
  assert.equal(translateKey('nav.home', 'en'), 'Home')
  assert.equal(translateKey('nav.settings', 'en'), 'Settings')
})

test('translateKey fallback：未知 key 返回末尾段，不抛错', () => {
  assert.equal(translateKey('nav.notARealKey', 'en'), 'notARealKey')
  assert.equal(translateKey('totally.unknown.path', 'zh'), 'path')
})

test('translateKey fallback：en 缺时回退到 zh', () => {
  // 临时塞一个只有 zh 有的 key
  translations.zh.__test_only = '只在中文里'
  try {
    assert.equal(translateKey('__test_only', 'en'), '只在中文里')
  } finally {
    delete translations.zh.__test_only
  }
})

test('lookup 工具函数', () => {
  assert.equal(lookup(translations.zh, 'nav.home'), '首页')
  assert.equal(lookup(translations.zh, 'nav.does.not.exist'), undefined)
  assert.equal(lookup(null, 'x'), undefined)
})

test('未知语言代码退化到 en', () => {
  assert.equal(translateKey('nav.home', 'fr'), 'Home')
})
