// T6: permissionsProbes 单测 —— 纯 Node，不依赖浏览器，全部用 mock global。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  probeLocalStorage,
  probeStorage,
  probeNotifications,
  probeMedia,
} from '../../src/lib/permissionsProbes.js'

// ── probeLocalStorage ──────────────────────────────────────────────────────

test('probeLocalStorage: 正常 storage → granted', () => {
  const store = new Map()
  const fakeLS = {
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
  const result = probeLocalStorage({ storage: fakeLS })
  assert.equal(result.state, 'granted')
  assert.equal(store.size, 0, 'probe 应该清理掉 __probe__ key')
})

test('probeLocalStorage: setItem 抛错 → denied', () => {
  const fakeLS = {
    setItem: () => { throw new Error('QuotaExceededError') },
    removeItem: () => {},
  }
  assert.equal(probeLocalStorage({ storage: fakeLS }).state, 'denied')
})

test('probeLocalStorage: 没有 storage → unsupported', () => {
  assert.equal(probeLocalStorage({ storage: null }).state, 'unsupported')
})

// ── probeStorage ───────────────────────────────────────────────────────────

test('probeStorage: usage < quota → granted + detail', async () => {
  const nav = {
    storage: {
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    },
  }
  const res = await probeStorage({ navigator: nav })
  assert.equal(res.state, 'granted')
  assert.equal(res.detail, '5.0MB / 100MB')
})

test('probeStorage: usage >= quota → denied', async () => {
  const nav = {
    storage: {
      estimate: async () => ({ usage: 100 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    },
  }
  const res = await probeStorage({ navigator: nav })
  assert.equal(res.state, 'denied')
})

test('probeStorage: navigator.storage 不存在 → unsupported', async () => {
  const res = await probeStorage({ navigator: {} })
  assert.equal(res.state, 'unsupported')
})

test('probeStorage: estimate 抛错 → unknown', async () => {
  const nav = {
    storage: { estimate: async () => { throw new Error('boom') } },
  }
  const res = await probeStorage({ navigator: nav })
  assert.equal(res.state, 'unknown')
})

// ── probeNotifications ─────────────────────────────────────────────────────

test('probeNotifications: permission granted → granted', () => {
  const win = { Notification: { permission: 'granted' } }
  assert.equal(probeNotifications({ win }).state, 'granted')
})

test('probeNotifications: permission denied → denied', () => {
  const win = { Notification: { permission: 'denied' } }
  assert.equal(probeNotifications({ win }).state, 'denied')
})

test('probeNotifications: permission default → prompt', () => {
  const win = { Notification: { permission: 'default' } }
  assert.equal(probeNotifications({ win }).state, 'prompt')
})

test('probeNotifications: 没有 Notification API → unsupported', () => {
  assert.equal(probeNotifications({ win: {} }).state, 'unsupported')
})

// ── probeMedia ─────────────────────────────────────────────────────────────

test('probeMedia: permissions API 返回 granted', async () => {
  const nav = {
    permissions: { query: async ({ name }) => ({ state: name === 'microphone' ? 'granted' : 'denied' }) },
  }
  assert.equal((await probeMedia('microphone', { navigator: nav })).state, 'granted')
  assert.equal((await probeMedia('camera', { navigator: nav })).state, 'denied')
})

test('probeMedia: permissions.query 抛错 + 有 mediaDevices → prompt', async () => {
  const nav = {
    permissions: { query: async () => { throw new TypeError('mic not supported') } },
    mediaDevices: { getUserMedia: async () => ({}) },
  }
  assert.equal((await probeMedia('microphone', { navigator: nav })).state, 'prompt')
})

test('probeMedia: 完全没有 API → unsupported', async () => {
  assert.equal((await probeMedia('microphone', { navigator: {} })).state, 'unsupported')
})

test('probeMedia: 无效 name → unknown', async () => {
  assert.equal((await probeMedia('weird', { navigator: {} })).state, 'unknown')
})

test('probeMedia: permissions.query 返回未知 state + 有 mediaDevices → prompt fallback', async () => {
  const nav = {
    permissions: { query: async () => ({ state: 'unknown-state' }) },
    mediaDevices: { getUserMedia: async () => ({}) },
  }
  assert.equal((await probeMedia('camera', { navigator: nav })).state, 'prompt')
})
