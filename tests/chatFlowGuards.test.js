import test from 'node:test'
import assert from 'node:assert/strict'

import {
  artifactTypeForSkill,
  buildAssistantToolCallsMessage,
  buildChatFailureMessage,
  clipChatToolContent,
  createChatToolLoopGuard,
  filterToolNamesForSkill,
  isStreamingSafeToolCall,
  normalizeChatToolCalls,
  shouldForceChatTextWrapUp,
  shouldStopAfterArtifactTool,
  validateChatToolCallAllowed,
} from '../src/lib/chatFlowGuards.js'

test('stream overlap is limited to side-effect-free tool calls', () => {
  assert.equal(isStreamingSafeToolCall({ name: 'read_file', arguments: '{"path":"a"}' }), true)
  assert.equal(isStreamingSafeToolCall({ name: 'fetch_url', arguments: '{"method":"GET"}' }), true)
  assert.equal(isStreamingSafeToolCall({ name: 'fetch_url', arguments: '{"method":"POST"}' }), false)
  assert.equal(isStreamingSafeToolCall({ name: 'write_file', arguments: '{}' }), false)
  assert.equal(isStreamingSafeToolCall({ name: 'mcp_unknown', arguments: '{}' }), false)
})

test('/htmlppt keeps model on single-file HTML path instead of file-generation tools', () => {
  const enabled = ['web_search', 'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'manage_todos']
  assert.deepEqual(
    filterToolNamesForSkill(enabled, 'htmlppt'),
    ['web_search', 'manage_todos'],
  )
})

test('通用和代码任务看不到文件产物工具,不会把修 bug 误做成 PPT', () => {
  const enabled = ['read_file', 'write_file', 'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app']
  assert.deepEqual(filterToolNamesForSkill(enabled), ['read_file', 'write_file'])
  assert.deepEqual(filterToolNamesForSkill(enabled, 'code'), ['read_file', 'write_file'])
})

test('文件技能只解锁自己对应的产物工具', () => {
  const enabled = ['create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'read_file']
  assert.deepEqual(filterToolNamesForSkill(enabled, 'ppt'), ['create_pptx', 'read_file'])
  assert.deepEqual(filterToolNamesForSkill(enabled, 'doc'), ['create_docx', 'read_file'])
  assert.deepEqual(filterToolNamesForSkill(enabled, 'excel'), ['create_xlsx', 'read_file'])
})

test('ppt skill keeps only its matching generation tool', () => {
  const enabled = ['create_pptx', 'create_docx', 'create_xlsx', 'manage_todos']
  assert.deepEqual(filterToolNamesForSkill(enabled, 'ppt'), ['create_pptx', 'manage_todos'])
})

test('chat rejects hallucinated file tools that were not declared this turn', () => {
  const allowed = new Set(['read_file', 'web_search'])
  assert.equal(validateChatToolCallAllowed({ name: 'read_file' }, allowed).ok, true)
  const rejected = validateChatToolCallAllowed({ name: 'create_pptx' }, allowed)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'undeclared_tool_call')
})

test('assistant tool-call context uses null content for OpenAI-compatible providers', () => {
  const msg = buildAssistantToolCallsMessage([
    { id: 'call_1', name: 'create_pptx', arguments: '{"title":"Deck"}' },
  ])

  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content, null)
  assert.deepEqual(msg.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'create_pptx', arguments: '{"title":"Deck"}' },
    },
  ])
})

test('聊天工具调用会修复缺失/重复 id 并兼容 wire 形状', () => {
  let seq = 0
  const calls = normalizeChatToolCalls([
    { id: 'same', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { id: 'same', name: 'read_file', arguments: { path: 'b' } },
    { name: 'read_file', arguments: '{}' },
  ], { idFactory: () => `generated-${++seq}` })
  assert.deepEqual(calls.map((call) => call.id), ['same', 'generated-1', 'generated-2'])
  assert.deepEqual(JSON.parse(calls[1].arguments), { path: 'b' })
})

test('聊天工具循环会熔断重复调用和连续失败', () => {
  const guard = createChatToolLoopGuard({ maxRepeatedCalls: 2, maxConsecutiveErrors: 2 })
  const call = { name: 'read_file', arguments: '{"path":"a"}' }
  assert.equal(guard.before(call).ok, true)
  assert.equal(guard.before(call).ok, true)
  assert.match(guard.before(call).reason, /重复 3 次/)

  const errors = createChatToolLoopGuard({ maxConsecutiveErrors: 2 })
  assert.equal(errors.after({ ok: false }).ok, true)
  assert.match(errors.after({ ok: false }).reason, /连续失败 2 次/)
})

test('聊天工具长结果截断后保持合法 JSON', () => {
  const clipped = clipChatToolContent(JSON.stringify({ content: 'x'.repeat(10_000) }), 800)
  const parsed = JSON.parse(clipped)
  assert.equal(parsed._truncated, true)
  assert.equal(clipped.length <= 800, true)
})

test('用户明确要产物时也不能跳过最终文字说明', () => {
  const requested = { artifactWasRequested: true }
  assert.equal(shouldStopAfterArtifactTool({ type: 'pptx', title: 'Deck', source: '# Deck' }, requested), false)
  assert.equal(shouldStopAfterArtifactTool({ type: 'html', title: 'Deck', source: '<html></html>' }, requested), false)
  assert.equal(shouldStopAfterArtifactTool(null, requested), false)
})

test('工具执行后没有正文时必须触发禁用工具的文字收尾', () => {
  assert.equal(shouldForceChatTextWrapUp({ completedToolCalls: 2, sawTextThisRound: false }), true)
  assert.equal(shouldForceChatTextWrapUp({ completedToolCalls: 2, sawTextThisRound: true }), false)
  assert.equal(shouldForceChatTextWrapUp({ completedToolCalls: 0, sawTextThisRound: false }), false)
})

test('★ 回归:用户没要产物时,产物只是中间物,不能拿它结束循环', () => {
  // 以前只要产出 artifact 就 break —— 于是模型在「帮我改代码」这种任务里
  // 顺手生成一个 Excel,循环立刻中断,它再没机会说改了什么。
  // 用户看到的就是一堆工具调用 + 一个没人要的文件,零解释。
  for (const artifact of [
    { type: 'xlsx', title: '问题', source: 'a,b' },
    { type: 'pptx', title: 'Deck', source: '# Deck' },
    { type: 'html', title: 'Page', source: '<html></html>' },
  ]) {
    assert.equal(
      shouldStopAfterArtifactTool(artifact),
      false,
      `${artifact.type}: 没人要的产物不该终结对话`,
    )
    assert.equal(shouldStopAfterArtifactTool(artifact, { artifactWasRequested: false }), false)
  }
})

test('残缺的 artifact 任何情况下都不结束循环', () => {
  for (const bad of [null, undefined, {}, { type: 'pptx' }, { source: 'x' }]) {
    assert.equal(shouldStopAfterArtifactTool(bad, { artifactWasRequested: true }), false)
  }
})

test('chat failure copy does not blame env config for generic invalid request', () => {
  const text = buildChatFailureMessage('请求参数无效：请检查消息内容、工具调用上下文或当前模型的 OpenAI 兼容性。')
  assert.match(text, /模型调用失败/)
  assert.doesNotMatch(text, /MODEL_BASE_URL/)
  assert.doesNotMatch(text, /MODEL_API_KEY/)
})

test('chat failure copy keeps admin env hint for real configuration failures', () => {
  const text = buildChatFailureMessage('后端模型未配置：缺少 MODEL_BASE_URL。请管理员检查 .env。')
  assert.match(text, /MODEL_BASE_URL/)
  assert.match(text, /请联系管理员/)
})

test('artifact type mapping keeps htmlppt as html', () => {
  assert.equal(artifactTypeForSkill('htmlppt'), 'html')
  assert.equal(artifactTypeForSkill('ppt'), 'pptx')
})

/**
 * 真实事故:dev server 漏注册 /api/tools/code/,grep_code 连着 404 六次。
 * 模型每次都换一个 path 重试 —— 而熔断器是按「工具名+参数」计数的,
 * 参数每次都不同,所以从头到尾没响过,模型就一直在原地撞墙,
 * 把轮数和预算全烧在了必然失败的调用上。
 */
test('★ 工具因 404 不可用时,按工具名熔断 —— 换参数也不给再试', () => {
  const guard = createChatToolLoopGuard()
  const dead = { ok: false, content: JSON.stringify({ error: 'HTTP 404', retryable: false }) }

  // 模型每次换个 path 重试,参数都不一样
  for (const p of ['D:/a', 'D:/b', 'D:/c']) {
    const call = { name: 'grep_code', arguments: JSON.stringify({ path: p }) }
    guard.before(call)
    guard.after(dead, call)
  }

  const next = guard.before({ name: 'grep_code', arguments: JSON.stringify({ path: 'D:/d' }) })
  assert.equal(next.ok, false, '同一个工具已确认不可用,不该再放行')
  assert.match(next.reason, /不可用/)
  assert.match(next.reason, /改用其他工具/)
})

test('熔断只针对失败的那个工具,不误伤其他工具', () => {
  const guard = createChatToolLoopGuard()
  const dead = { ok: false, content: JSON.stringify({ error: 'HTTP 404', retryable: false }) }
  for (const p of ['a', 'b', 'c']) {
    const call = { name: 'grep_code', arguments: JSON.stringify({ path: p }) }
    guard.before(call)
    guard.after(dead, call)
  }
  // read_file 是好的,必须照常放行
  assert.equal(guard.before({ name: 'read_file', arguments: '{"path":"x"}' }).ok, true)
})

test('普通失败(不是 404/不可重试)不触发工具级熔断', () => {
  const guard = createChatToolLoopGuard()
  const softFail = { ok: false, content: JSON.stringify({ error: '文件为空' }) }
  for (const p of ['a', 'b', 'c']) {
    const call = { name: 'read_file', arguments: JSON.stringify({ path: p }) }
    guard.before(call)
    guard.after(softFail, call)
  }
  assert.equal(guard.before({ name: 'read_file', arguments: '{"path":"d"}' }).ok, true)
})
