import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_APPROVAL_SETTINGS,
  fetchApprovalSettings,
  updateApprovalSettings,
} from '../src/lib/approvalClient.js'

/**
 * 回归:dev server 代理不到后端时,响应体不是 JSON,parse() 返回 null。
 * 以前这个 null 被直接塞进 React state,渲染时读 approvalSettings.mode 就崩:
 *   Cannot read properties of null (reading 'mode')  ← 整个聊天页白屏
 * 现在任何拿不到设置的情况都必须退回默认档位,而且必须是最严的 normal。
 */

const okNonJson = () => new Response('<!doctype html><html>vite 错误页</html>', {
  status: 200,
  headers: { 'Content-Type': 'text/html' },
})

test('响应体不是 JSON 时返回默认设置,而不是 null', async () => {
  const s = await fetchApprovalSettings({ fetchImpl: async () => okNonJson() })
  assert.ok(s, '绝不能返回 null —— 那会让整个聊天页崩掉')
  assert.equal(s.mode, 'normal')
  assert.deepEqual(s.rememberedTools, [])
})

test('响应体是 JSON null 时也退回默认', async () => {
  const s = await fetchApprovalSettings({
    fetchImpl: async () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(s.mode, 'normal')
})

test('字段缺失 / 类型不对时逐项兜底', async () => {
  const s = await fetchApprovalSettings({
    fetchImpl: async () => new Response(JSON.stringify({ mode: 123, rememberedTools: 'not-an-array' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  assert.equal(s.mode, 'normal', '非法 mode 必须退回 normal')
  assert.deepEqual(s.rememberedTools, [], '非数组必须退回空数组')
})

test('未知档位不被接受 —— 不能让服务端把权限放宽到无法识别的值', async () => {
  const s = await fetchApprovalSettings({
    fetchImpl: async () => new Response(JSON.stringify({ mode: 'god-mode' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  assert.equal(s.mode, 'normal')
})

test('合法设置原样返回', async () => {
  const s = await fetchApprovalSettings({
    fetchImpl: async () => new Response(JSON.stringify({ mode: 'acceptEdits', rememberedTools: ['bash_exec'] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  assert.equal(s.mode, 'acceptEdits')
  assert.deepEqual(s.rememberedTools, ['bash_exec'])
})

test('updateApprovalSettings 同样不会返回 null', async () => {
  const s = await updateApprovalSettings({ mode: 'plan' }, { fetchImpl: async () => okNonJson() })
  assert.ok(s)
  assert.equal(s.mode, 'normal')
})

test('HTTP 错误仍然抛出(由调用方 catch 后走默认档位)', async () => {
  await assert.rejects(
    () => fetchApprovalSettings({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: '未登录' } }), { status: 401 }),
    }),
    /未登录/,
  )
})

test('默认设置是最严档位,不能是 bypass', () => {
  assert.equal(DEFAULT_APPROVAL_SETTINGS.mode, 'normal')
})
