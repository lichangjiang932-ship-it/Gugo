import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-tools-tests', String(process.pid))

const { SERVER_TOOL_SPECS, runToolsLoop } = await import('../server/jobTools.js')
const { createDefaultExecuteStep, JobRuntime } = await import('../server/jobRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession().userId

test('SERVER_TOOL_SPECS exposes create_pptx / create_docx / create_xlsx', () => {
  const names = SERVER_TOOL_SPECS.map((spec) => spec.function.name)
  for (const required of ['create_pptx', 'create_docx', 'create_xlsx']) {
    assert.ok(names.includes(required), `${required} missing from SERVER_TOOL_SPECS`)
  }
  for (const spec of SERVER_TOOL_SPECS) {
    assert.equal(spec.type, 'function')
    assert.ok(spec.function.parameters, `${spec.function.name} missing parameters`)
  }
})

test('runToolsLoop calls create_docx once, persists artifact, returns final text', async () => {
  let modelInvocations = 0
  const runModel = async () => {
    modelInvocations += 1
    if (modelInvocations === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'create_docx',
            arguments: JSON.stringify({
              title: '会议纪要',
              paragraphs: [{ heading: 1, text: '今天我们讨论了' }],
            }),
          },
        }],
      }
    }
    return { content: '已生成会议纪要文档。', toolCalls: [] }
  }

  // 用注入的 executeTool 避开 jobStore FK 约束(测试 job 没入库)
  const calls = []
  const fakeExecute = async ({ name, args }) => {
    calls.push({ name, args })
    return { ok: true, artifactId: `art-fake-${calls.length}`, filename: 'result.docx', url: '/api/artifacts/result.docx' }
  }

  const job = { id: 'job-tools-1', userId: TEST_USER, title: '会议纪要' }
  const step = { id: 'step-1', kind: 'execute' }
  const result = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: '把这次会议整理成 Word 文档' }],
    runModel,
    executeTool: fakeExecute,
  })

  assert.equal(modelInvocations, 2, 'should iterate exactly twice (tool call + final reply)')
  assert.equal(result.text, '已生成会议纪要文档。')
  assert.equal(result.artifactIds.length, 1)
  assert.equal(result.artifactIds[0], 'art-fake-1')
  assert.equal(calls[0].name, 'create_docx')
  assert.equal(calls[0].args.title, '会议纪要')
})

test('runToolsLoop stops at maxIters when model keeps calling tools', async () => {
  let calls = 0
  const runModel = async () => {
    calls += 1
    return {
      content: '',
      toolCalls: [{
        id: `call-${calls}`,
        type: 'function',
        function: { name: 'create_docx', arguments: JSON.stringify({ title: `T${calls}`, paragraphs: [{ text: 'x' }] }) },
      }],
    }
  }
  let execCount = 0
  const fakeExecute = async () => {
    execCount += 1
    return { ok: true, artifactId: `art-${execCount}` }
  }

  const job = { id: 'job-tools-2', userId: TEST_USER, title: 'runaway' }
  const step = { id: 'step-2', kind: 'execute' }
  const result = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: 'loop' }],
    runModel,
    executeTool: fakeExecute,
    maxIters: 3,
  })

  assert.equal(calls, 3, 'should cap at maxIters')
  assert.equal(result.artifactIds.length, 3)
})

test('runToolsLoop handles malformed tool args without throwing', async () => {
  let calls = 0
  const runModel = async () => {
    calls += 1
    if (calls === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'create_pptx', arguments: '{not json' } }],
      }
    }
    return { content: 'done', toolCalls: [] }
  }
  const job = { id: 'job-tools-3', userId: TEST_USER, title: 'bad args' }
  const step = { id: 'step-3', kind: 'execute' }
  // create_pptx with empty slides should still succeed (artifactGen handles it)
  const result = await runToolsLoop({
    job, step,
    messages: [{ role: 'user', content: 'pptx' }],
    runModel,
  })
  assert.equal(result.text, 'done')
})

test('jobRuntime end-to-end: model calling create_pptx persists artifact under job.userId', async () => {
  let executeCalls = 0
  const runtime = new JobRuntime({
    executeStep: createDefaultExecuteStep({
      runModelWithTools: async ({ messages }) => {
        executeCalls += 1
        // 只在 execute step 第一次调用时返回 tool_call,之后立刻收尾
        const userMsg = messages.find((m) => m.role === 'user')?.content || ''
        if (userMsg.includes('PPT') && executeCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'c1', type: 'function',
              function: {
                name: 'create_pptx',
                arguments: JSON.stringify({
                  title: '季度汇报',
                  slides: [{ title: 'Q3 概览', bullets: ['增长 12%', 'NPS +8'] }],
                }),
              },
            }],
          }
        }
        return { content: '已生成 PPT。', toolCalls: [] }
      },
    }),
  })

  const job = await runtime.createJob('做一份 PPT 汇报', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.status, 'completed')
  // execute step + finalize step 各 1 个 artifact(execute 的 pptx + finalize 的 docx 汇总)
  assert.ok(loaded.artifacts.length >= 1, 'should produce at least one artifact')
  const pptx = loaded.artifacts.find((a) => a.filename?.endsWith('.pptx'))
  assert.ok(pptx, 'should have pptx artifact')
  assert.equal(pptx.userId, TEST_USER, 'artifact should be owned by job.userId')
})
