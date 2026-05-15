// 批 4 UX 相关回归测试:草稿 reducer + 任务状态 → ChatTaskPanel 期望使用的字段
import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_STATUS, TASK_STATUS_LABEL } from '../src/store/taskStatus.js'

// 因为 AppContext.jsx 是 React 组件文件,这里手抄 reducer 的 SET_SESSION_DRAFT 行为做契约测试。
// 真正的 reducer 与本测试都从同一个枚举/规则出发(空文本删 key、有文本写 key、缺 sessionId 不动)。
function applySessionDraft(state, payload) {
  const { sessionId, text } = payload || {}
  if (!sessionId) return state
  const drafts = { ...(state.sessionDrafts || {}) }
  const t = text ?? ''
  if (t) drafts[sessionId] = t
  else delete drafts[sessionId]
  return { ...state, sessionDrafts: drafts }
}

test('SET_SESSION_DRAFT: 写入非空文本', () => {
  const next = applySessionDraft({ sessionDrafts: {} }, { sessionId: 's1', text: '写一篇周报' })
  assert.deepEqual(next.sessionDrafts, { s1: '写一篇周报' })
})

test('SET_SESSION_DRAFT: 空文本/null 删除 key', () => {
  const base = { sessionDrafts: { s1: 'x', s2: 'y' } }
  assert.deepEqual(applySessionDraft(base, { sessionId: 's1', text: '' }).sessionDrafts, { s2: 'y' })
  assert.deepEqual(applySessionDraft(base, { sessionId: 's1', text: null }).sessionDrafts, { s2: 'y' })
})

test('SET_SESSION_DRAFT: 缺 sessionId 直接返回原 state', () => {
  const base = { sessionDrafts: { s1: 'x' } }
  assert.equal(applySessionDraft(base, {}), base)
  assert.equal(applySessionDraft(base, { text: 'xx' }), base)
  assert.equal(applySessionDraft(base, null), base)
})

test('SET_SESSION_DRAFT: 不会污染上一轮 sessionDrafts 引用', () => {
  const base = { sessionDrafts: { s1: 'x' } }
  const next = applySessionDraft(base, { sessionId: 's2', text: 'y' })
  assert.notEqual(next.sessionDrafts, base.sessionDrafts)
  assert.deepEqual(base.sessionDrafts, { s1: 'x' }) // base 没被改
})

// ChatTaskPanel 渲染时用 TASK_STATUS_LABEL 给非 RUNNING 状态显示中文 — 5 个状态都得有
test('TASK_STATUS_LABEL 覆盖 5 个状态', () => {
  for (const s of Object.values(TASK_STATUS)) {
    assert.ok(TASK_STATUS_LABEL[s], `缺少 label: ${s}`)
    assert.equal(typeof TASK_STATUS_LABEL[s], 'string')
  }
})

test('TASK_STATUS_LABEL 是 frozen,UI 直接读不会被偷改', () => {
  assert.ok(Object.isFrozen(TASK_STATUS_LABEL))
})
