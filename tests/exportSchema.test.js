import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCHEMA_VERSION,
  SESSIONS_SCHEMA,
  SETTINGS_SCHEMA,
  wrapSessionsExport,
  wrapSettingsExport,
  parseImport,
  InvalidExportError,
} from '../src/store/exportSchema.js'

test('SCHEMA_VERSION 是数字常量,schema id 包含 v<N>', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number')
  assert.ok(SESSIONS_SCHEMA.includes(`v${SCHEMA_VERSION}`))
  assert.ok(SETTINGS_SCHEMA.includes(`v${SCHEMA_VERSION}`))
})

test('wrapSessionsExport 包裹 __schema + exportedAt', () => {
  const out = wrapSessionsExport([{ id: 's1', title: 't1', messages: [] }])
  assert.equal(out.__schema, SESSIONS_SCHEMA)
  assert.ok(out.exportedAt)
  assert.equal(out.payload.length, 1)
})

test('wrapSessionsExport 非数组兜底为空数组', () => {
  const out = wrapSessionsExport(null)
  assert.deepEqual(out.payload, [])
})

test('wrapSettingsExport 包裹 __schema', () => {
  const out = wrapSettingsExport({ theme: 'dark' })
  assert.equal(out.__schema, SETTINGS_SCHEMA)
  assert.equal(out.payload.theme, 'dark')
})

test('wrapSettingsExport 非对象兜底为空对象', () => {
  const out = wrapSettingsExport(null)
  assert.deepEqual(out.payload, {})
})

test('parseImport 接受 v1 sessions 包', () => {
  const wrapped = wrapSessionsExport([{ id: 's1', title: 't1', messages: [] }])
  const parsed = parseImport(JSON.stringify(wrapped))
  assert.equal(parsed.kind, 'sessions')
  assert.equal(parsed.schema, SESSIONS_SCHEMA)
  assert.equal(parsed.payload.length, 1)
})

test('parseImport 接受 v1 settings 包', () => {
  const wrapped = wrapSettingsExport({ theme: 'dark', accentColor: '#fff' })
  const parsed = parseImport(JSON.stringify(wrapped))
  assert.equal(parsed.kind, 'settings')
  assert.equal(parsed.payload.theme, 'dark')
})

test('parseImport 兼容老版本裸 sessions 数组', () => {
  const legacy = [{ id: 's1', title: 't1', messages: [] }]
  const parsed = parseImport(JSON.stringify(legacy))
  assert.equal(parsed.kind, 'sessions')
  assert.equal(parsed.schema, 'legacy.sessions')
  assert.equal(parsed.payload.length, 1)
})

test('parseImport 校验老格式里的非法 message', () => {
  const legacy = [{ id: 's1', title: 't', messages: [{ role: 'user' /* 缺 content */ }] }]
  assert.throws(() => parseImport(JSON.stringify(legacy)), InvalidExportError)
})

test('parseImport 拒绝非 JSON', () => {
  assert.throws(() => parseImport('not json {'), InvalidExportError)
})

test('parseImport 拒绝未知 schema id', () => {
  const wrong = { __schema: 'foo.bar.v1', payload: {} }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝缺 __schema', () => {
  const wrong = { payload: {} }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝缺 payload', () => {
  const wrong = { __schema: SESSIONS_SCHEMA }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝 sessions 包但 payload 不是数组', () => {
  const wrong = { __schema: SESSIONS_SCHEMA, payload: { not: 'array' } }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝 settings 包但 payload 不是对象', () => {
  const wrong = { __schema: SETTINGS_SCHEMA, payload: 'string' }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝 settings.theme 类型错误', () => {
  const wrong = { __schema: SETTINGS_SCHEMA, payload: { theme: 123 } }
  assert.throws(() => parseImport(JSON.stringify(wrong)), InvalidExportError)
})

test('parseImport 拒绝 null 输入', () => {
  assert.throws(() => parseImport('null'), InvalidExportError)
})

test('InvalidExportError 暴露 .reason', () => {
  try {
    parseImport('not json')
    assert.fail('should throw')
  } catch (err) {
    assert.ok(err instanceof InvalidExportError)
    assert.equal(typeof err.reason, 'string')
    assert.ok(err.reason.length > 0)
  }
})
