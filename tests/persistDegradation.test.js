import test from 'node:test'
import assert from 'node:assert/strict'
import { persistWithDegradation } from '../src/store/persistDegradation.js'

// 模拟一个有上限的 localStorage:超过 cap 字符就抛 QuotaExceededError
function makeCappedStorage(cap) {
  const store = new Map()
  return {
    store,
    setItem(key, value) {
      // 用"新值替换旧值后总长度"判断,贴近真实浏览器行为
      let total = 0
      for (const [k, v] of store.entries()) {
        if (k !== key) total += k.length + v.length
      }
      total += key.length + value.length
      if (total > cap) {
        const err = new Error('QuotaExceededError: localStorage 已满')
        err.name = 'QuotaExceededError'
        err.code = 22
        throw err
      }
      store.set(key, value)
    },
  }
}

function makeBigSnapshot({ sessionCount, msgsPerSession, msgSize }) {
  const sessions = []
  for (let i = 0; i < sessionCount; i += 1) {
    const messages = []
    for (let j = 0; j < msgsPerSession; j += 1) {
      messages.push({
        id: `${i}-${j}`,
        role: j % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(msgSize),
      })
    }
    sessions.push({ id: `s${i}`, title: `会话 ${i}`, messages, updatedAt: Date.now() - i * 1000 })
  }
  return {
    user: { name: 'tester', email: 't@example.com' },
    isLoggedIn: true,
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    tasks: [],
    history: Array.from({ length: 50 }, (_, k) => ({ id: `h${k}`, name: `task ${k}`, detail: 'y'.repeat(200) })),
    permissions: [],
    theme: 'system',
    accentColor: '#E86A3C',
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    skillConfigs: {},
    toolsConfig: { web_search: false, fetch_url: false, run_js: false },
  }
}

test('persistWithDegradation: 容量充足时一次性 full 写入', () => {
  const storage = makeCappedStorage(1024 * 1024)
  const snapshot = makeBigSnapshot({ sessionCount: 2, msgsPerSession: 5, msgSize: 100 })
  const result = persistWithDegradation(snapshot, (k, v) => storage.setItem(k, v))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'full')
})

test('persistWithDegradation: 容量紧张时先截断每个会话到 50 条消息', () => {
  // 5 个会话各 200 条 200 字节消息 ≈ 200KB,但 cap 给到能装下 5x50 条的程度
  const snapshot = makeBigSnapshot({ sessionCount: 5, msgsPerSession: 200, msgSize: 200 })
  const truncatedLen = JSON.stringify({ ...snapshot, sessions: snapshot.sessions.map((s) => ({ ...s, messages: s.messages.slice(-50) })) }).length
  const fullLen = JSON.stringify(snapshot).length
  const cap = Math.floor((fullLen + truncatedLen) / 2)
  const storage = makeCappedStorage(cap)
  const result = persistWithDegradation(snapshot, (k, v) => storage.setItem(k, v))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'truncated-messages')
  const saved = JSON.parse([...storage.store.values()][0])
  for (const s of saved.sessions) {
    assert.ok(s.messages.length <= 50, `每个会话消息数应 <= 50,实际 ${s.messages.length}`)
  }
})

test('persistWithDegradation: 容量极紧时只保留最近 5 个会话', () => {
  // 20 个会话 50 条/200 字节 → 截断后仍超容量,需要再退到只留 5 个会话
  const snapshot = makeBigSnapshot({ sessionCount: 20, msgsPerSession: 60, msgSize: 200 })
  const recentFiveSessions = snapshot.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5)
    .map((s) => ({ ...s, messages: s.messages.slice(-50) }))
  const recentFiveLen = JSON.stringify({ ...snapshot, sessions: recentFiveSessions }).length
  const cap = recentFiveLen + 200 // 刚好够装 5 个会话,装不下 20 个截断后的
  const storage = makeCappedStorage(cap)
  const result = persistWithDegradation(snapshot, (k, v) => storage.setItem(k, v))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'recent-sessions-only')
  const saved = JSON.parse([...storage.store.values()][0])
  assert.equal(saved.sessions.length, 5)
})

test('persistWithDegradation: 极端情况兜底到 minimal,不抛异常', () => {
  // cap 极小,只能塞下设置类字段
  const storage = makeCappedStorage(800)
  const snapshot = makeBigSnapshot({ sessionCount: 10, msgsPerSession: 50, msgSize: 200 })
  const result = persistWithDegradation(snapshot, (k, v) => storage.setItem(k, v))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'minimal')
  const saved = JSON.parse([...storage.store.values()][0])
  assert.deepEqual(saved.sessions, [])
  assert.deepEqual(saved.history, [])
  assert.equal(saved.user.name, 'tester')
})

test('persistWithDegradation: 非 quota 异常直接返回 error,不进入降级', () => {
  const setItem = () => {
    const err = new Error('disk full or storage disabled')
    throw err
  }
  const result = persistWithDegradation({ sessions: [] }, setItem)
  assert.equal(result.ok, false)
  assert.equal(result.level, 'error')
})
