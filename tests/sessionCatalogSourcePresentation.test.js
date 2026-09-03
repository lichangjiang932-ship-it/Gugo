import assert from 'node:assert/strict'
import test from 'node:test'

import { presentSessionCatalogSource } from '../src/components/leftRail/sessionCatalogSourcePresentation.js'
import { translateKey } from '../src/i18n/translations.js'

test('history source presentation makes backend differences visible without exposing database paths', () => {
  const source = {
    backendInstanceId: 'sqlite:0123456789abcdef',
    workspaceScope: { path: 'D:\\work\\atelier' },
  }
  const t = (key, vars) => translateKey(key, 'en').replace(
    /\{(\w+)\}/g,
    (_, name) => vars[name],
  )
  assert.deepEqual(presentSessionCatalogSource(source, null, t), {
    changed: false,
    fingerprint: '01234567',
    label: 'atelier · #01234567',
    title: 'History source: sqlite:0123456789abcdef\nWorkspace: D:\\work\\atelier',
  })
  assert.equal(presentSessionCatalogSource(source, { previous: {} }, t).changed, true)
  assert.equal(presentSessionCatalogSource(null), null)
})

test('history source tooltip has Chinese and English translations', () => {
  assert.equal(
    translateKey('nav.historySourceTitle', 'zh'),
    '历史数据源：{source}\n工作区：{workspace}',
  )
  assert.equal(
    translateKey('nav.historySourceChangedTitle', 'en'),
    'History source changed: {source}\nWorkspace: {workspace}',
  )
})
