// 批 4 UX 相关回归测试:草稿 reducer + 任务状态 → ChatTaskPanel 期望使用的字段
import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_STATUS, TASK_STATUS_LABEL } from '../src/store/taskStatus.js'
import { reduceTaskSettingsState } from '../src/store/reducers/taskSettingsReducer.js'

function applySessionDraft(state, payload) {
  return reduceTaskSettingsState(state, { type: 'SET_SESSION_DRAFT', payload })
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

test('SET_SESSION_DRAFT: 附件草稿只保存已上传的最小引用', () => {
  const next = applySessionDraft({ sessionDrafts: {} }, {
    sessionId: 's1',
    text: '带附件的草稿',
    attachments: [
      {
        id: 'ready-file',
        name: '../report.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        uploadStatus: 'ready',
        downloadUrl: '/api/attachments/ready-file/content',
        dataUrl: 'data:application/pdf;base64,private-preview',
      },
      { id: 'uploading-file', name: 'pending.txt', uploadStatus: 'uploading' },
    ],
  })
  assert.equal(next.sessionDrafts.s1.text, '带附件的草稿')
  assert.deepEqual(next.sessionDrafts.s1.attachments.map((item) => item.id), ['ready-file'])
  assert.equal(next.sessionDrafts.s1.attachments[0].name, 'report.pdf')
  assert.doesNotMatch(JSON.stringify(next.sessionDrafts), /private-preview|uploading-file/)
})

test('SET_SESSION_DRAFT: 文本与附件可独立清空且最终删除空草稿', () => {
  const withAttachment = applySessionDraft({ sessionDrafts: {} }, {
    sessionId: 's1',
    text: 'draft',
    attachments: [{ id: 'ready', name: 'a.txt', uploadStatus: 'ready' }],
  })
  const textCleared = applySessionDraft(withAttachment, { sessionId: 's1', text: '' })
  assert.equal(textCleared.sessionDrafts.s1.text, '')
  assert.equal(textCleared.sessionDrafts.s1.attachments.length, 1)
  const cleared = applySessionDraft(textCleared, { sessionId: 's1', attachments: [] })
  assert.deepEqual(cleared.sessionDrafts, {})
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
