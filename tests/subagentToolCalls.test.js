import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 回归:子代理工具循环读错了 tool call 的字段名。
 *
 * 上游返回的是 OpenAI wire 形状 { id, type, function: { name, arguments: "<json>" } },
 * 而循环里直接读 tc.name / tc.arguments —— 两个都是 undefined。后果:
 *   1. 每次工具调用都以 undefined 派发 → 全部返回 unknown subagent tool: undefined
 *      (连 request_clarification 这种纯内存工具也失败)
 *   2. 回填给上游的 assistant 消息变成 function:{} → 下一轮上游 400
 *      → 异常冒到 runSubagent → 整个 "Agent · explore" 标记 failed
 *
 * jobTools.runToolsLoop 一直是对的,只有这条路径漏了归一化。
 */

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-subcalls-'))

const { getDb } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { SUBAGENT_TYPES, _testing } = await import('../server/services/subagentRuntime.js')

const USER = 'subcall-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(USER, 'subcalls@example.com', now, now)

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'subcall-proj-'))
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}')
fs.writeFileSync(path.join(project, 'main.py'), 'import os\ndef main():\n    pass\n')
grantLocalPath({ userId: USER, rootPath: project, accessMode: 'read_only' })

/** 上游真实返回的形状 —— 名字和参数都在 function 里,arguments 是 JSON 字符串 */
function wireCall(name, args) {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

/** 跑一轮循环,把每次工具结果和回填的 assistant 消息都记下来 */
async function runLoop(script) {
  let step = 0
  const toolResults = []
  const echoes = []
  const callModel = async ({ messages }) => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls)
    if (lastAssistant) {
      for (const tc of lastAssistant.tool_calls) echoes.push(tc)
    }
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    while (toolResults.length < toolMsgs.length) {
      toolResults.push(JSON.parse(toolMsgs[toolResults.length].content))
    }
    return script[step++] || { content: '完成', toolCalls: [] }
  }
  const text = await _testing.subagentToolsLoop({
    messages: [
      { role: 'system', content: SUBAGENT_TYPES.explore.system },
      { role: 'user', content: `阅读 ${project}` },
    ],
    tools: SUBAGENT_TYPES.explore.tools,
    userId: USER,
    callModel,
  })
  return { text, toolResults, echoes }
}

test('★ 回归:wire 形状的 tool call 能正确派发,不再是 unknown tool: undefined', async () => {
  const { toolResults } = await runLoop([
    wireCall('read_file', { path: path.join(project, 'package.json') }),
  ])
  assert.equal(toolResults.length, 1)
  assert.notEqual(toolResults[0].ok, false, `read_file 应成功,实际: ${toolResults[0].error}`)
})

test('★ 回归:回填给上游的 assistant 消息必须带 name 和字符串 arguments', async () => {
  const { echoes } = await runLoop([
    wireCall('read_file', { path: path.join(project, 'package.json') }),
  ])
  assert.ok(echoes.length > 0, '应有回填的 assistant tool_calls')
  for (const tc of echoes) {
    // function:{} 会让下一轮上游直接 400,进而让整个 run 失败
    assert.ok(tc.function?.name, 'tool_call.function.name 不能为空')
    assert.equal(typeof tc.function?.arguments, 'string')
    assert.notEqual(tc.function.arguments, 'undefined', 'arguments 不能是字符串 "undefined"')
    assert.doesNotThrow(() => JSON.parse(tc.function.arguments), 'arguments 必须是合法 JSON')
  }
})

test('探索类子代理能用 list_directory(以前工具集里根本没有)', async () => {
  const names = SUBAGENT_TYPES.explore.tools.map((t) => t.function.name)
  assert.ok(names.includes('list_directory'), '探索一个陌生项目必须能先列目录')

  const { toolResults } = await runLoop([wireCall('list_directory', { path: project })])
  assert.notEqual(toolResults[0].ok, false, `list_directory 应成功,实际: ${toolResults[0].error}`)
})

test('grep_code 在已授权目录里可用', async () => {
  const { toolResults } = await runLoop([wireCall('grep_code', { pattern: 'import', path: project })])
  assert.notEqual(toolResults[0].ok, false, `grep_code 应成功,实际: ${toolResults[0].error}`)
})

test('request_clarification 是纯内存工具,任何情况下都不该失败', async () => {
  const { text } = await runLoop([wireCall('request_clarification', { question: '要看哪部分?' })])
  assert.match(text, /需要澄清/, '应把澄清问题作为最终输出返回')
})

test('参数已是对象(非字符串)时也能处理', async () => {
  const { toolResults } = await runLoop([{
    content: '',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: path.join(project, 'package.json') } }],
  }])
  assert.notEqual(toolResults[0].ok, false, '兼容非 wire 形状,不能只认一种')
})

test('上游中途失败时降级为部分结果,而不是整个 run 失败', async () => {
  let step = 0
  const callModel = async () => {
    step += 1
    if (step === 1) return wireCall('read_file', { path: path.join(project, 'package.json') })
    throw Object.assign(new Error('upstream 500'), { status: 500 })
  }
  const text = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'x' }],
    tools: SUBAGENT_TYPES.explore.tools,
    userId: USER,
    callModel,
  })
  // 已经查到的东西必须留下来,不能整个丢掉
  assert.match(text, /探索中断/)
  assert.match(text, /已经查到的信息/)
})
