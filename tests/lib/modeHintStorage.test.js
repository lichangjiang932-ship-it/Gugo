// T11: modeHintStorage 纯函数测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readDismissed,
  writeDismissed,
  MODE_HINT_KEYS,
} from '../../src/lib/modeHintStorage.js'

function makeMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
    _dump() {
      return Object.fromEntries(store)
    },
  }
}

test('readDismissed 未设置时返回 false (plan + code)', () => {
  const storage = makeMockStorage()
  assert.equal(readDismissed('plan', storage), false)
  assert.equal(readDismissed('code', storage), false)
})

test('writeDismissed(true) 后 readDismissed 返回 true', () => {
  const storage = makeMockStorage()
  assert.equal(writeDismissed('plan', storage), true)
  assert.equal(readDismissed('plan', storage), true)
  assert.equal(readDismissed('code', storage), false, '不同 mode 独立')
})

test('writeDismissed code 后只影响 code key', () => {
  const storage = makeMockStorage()
  writeDismissed('code', storage)
  assert.equal(readDismissed('code', storage), true)
  assert.equal(readDismissed('plan', storage), false)
  assert.equal(storage.getItem(MODE_HINT_KEYS.code), '1')
  assert.equal(storage.getItem(MODE_HINT_KEYS.plan), null)
})

test('writeDismissed(false) 可清掉 flag', () => {
  const storage = makeMockStorage()
  writeDismissed('plan', storage, true)
  assert.equal(readDismissed('plan', storage), true)
  writeDismissed('plan', storage, false)
  assert.equal(readDismissed('plan', storage), false)
})

test('未知 mode → read 返回 false，write 返回 false 且不写', () => {
  const storage = makeMockStorage()
  assert.equal(readDismissed('chat', storage), false)
  assert.equal(writeDismissed('chat', storage), false)
  assert.deepEqual(storage._dump(), {})
})

test('storage 为 null → 不抛错，read=false write=false', () => {
  assert.equal(readDismissed('plan', null), false)
  assert.equal(writeDismissed('plan', null), false)
})

test('storage 接口抛错 → 静默吞掉返回 false', () => {
  const broken = {
    getItem() { throw new Error('boom') },
    setItem() { throw new Error('boom') },
    removeItem() { throw new Error('boom') },
  }
  assert.equal(readDismissed('plan', broken), false)
  assert.equal(writeDismissed('plan', broken), false)
})

test('兼容 "true" 字符串写入（旧值）', () => {
  const storage = makeMockStorage({ plan_mode_hint_dismissed: 'true' })
  assert.equal(readDismissed('plan', storage), true)
})

test('MODE_HINT_KEYS 暴露给消费方', () => {
  assert.equal(MODE_HINT_KEYS.plan, 'plan_mode_hint_dismissed')
  assert.equal(MODE_HINT_KEYS.code, 'code_mode_hint_dismissed')
})
