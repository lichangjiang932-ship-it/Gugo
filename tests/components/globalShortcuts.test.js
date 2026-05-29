import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchShortcut } from '../../src/lib/shortcuts.js'

test('matchShortcut: Alt+N → new-session', () => {
  assert.equal(matchShortcut({ key: 'n', altKey: true }), 'new-session')
  // 大写 N 也认（Shift+Alt 不行，下面单测；这里测试 toLowerCase）
  assert.equal(matchShortcut({ key: 'N', altKey: true }), 'new-session')
})

test('matchShortcut: Alt+L → clear-session', () => {
  assert.equal(matchShortcut({ key: 'l', altKey: true }), 'clear-session')
})

test('matchShortcut: Alt+, → open-settings', () => {
  assert.equal(matchShortcut({ key: ',', altKey: true }), 'open-settings')
})

test('matchShortcut: Alt+B → open-history', () => {
  assert.equal(matchShortcut({ key: 'b', altKey: true }), 'open-history')
})

test('matchShortcut: Ctrl+N 不触发（避免浏览器拦截）', () => {
  assert.equal(matchShortcut({ key: 'n', ctrlKey: true }), null)
  assert.equal(matchShortcut({ key: 'l', ctrlKey: true }), null)
  assert.equal(matchShortcut({ key: ',', ctrlKey: true }), null)
  assert.equal(matchShortcut({ key: 'b', ctrlKey: true }), null)
})

test('matchShortcut: Cmd/Meta+N 不触发', () => {
  assert.equal(matchShortcut({ key: 'n', metaKey: true }), null)
  assert.equal(matchShortcut({ key: 'b', metaKey: true }), null)
})

test('matchShortcut: Alt 同时带 Ctrl/Cmd/Shift 不触发（避免组合撞车）', () => {
  assert.equal(matchShortcut({ key: 'n', altKey: true, ctrlKey: true }), null)
  assert.equal(matchShortcut({ key: 'n', altKey: true, metaKey: true }), null)
  assert.equal(matchShortcut({ key: 'n', altKey: true, shiftKey: true }), null)
})

test('matchShortcut: 裸按键不触发', () => {
  assert.equal(matchShortcut({ key: 'n' }), null)
  assert.equal(matchShortcut({ key: 'b' }), null)
  assert.equal(matchShortcut({ key: 'Escape' }), null)
})

test('matchShortcut: 未绑定的键 + Alt 也不触发', () => {
  assert.equal(matchShortcut({ key: 'a', altKey: true }), null)
  assert.equal(matchShortcut({ key: 'x', altKey: true }), null)
  assert.equal(matchShortcut({ key: '1', altKey: true }), null)
})

test('matchShortcut: 边界 — null / undefined / 无 key', () => {
  assert.equal(matchShortcut(null), null)
  assert.equal(matchShortcut(undefined), null)
  assert.equal(matchShortcut({}), null)
  assert.equal(matchShortcut({ altKey: true }), null)
})

test('matchShortcut: 模拟 KeyboardEvent 对象字段（Alt+N → new-session，Ctrl+N → null）', () => {
  // 模拟 KeyboardEvent 形状（key + altKey/ctrlKey/metaKey/shiftKey），node 无 DOM 全局类
  const altN = { key: 'n', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }
  assert.equal(matchShortcut(altN), 'new-session')

  const ctrlN = { key: 'n', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }
  assert.equal(matchShortcut(ctrlN), null)
})
