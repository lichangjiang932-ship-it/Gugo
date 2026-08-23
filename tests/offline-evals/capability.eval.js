import assert from 'node:assert/strict'
import { runToolsLoop, SERVER_TOOL_SPECS } from '../../server/services/jobTools.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const MIN_TASKS = 10
const MAX_TASKS = 20
const EVAL_USER_ID = 'offline-capability-eval-user'
function serverTool(name) {
  const spec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(spec, `offline eval fixture is missing server tool: ${name}`)
  return spec
}

const READ_FILE = serverTool('read_file')
const RUN_COMMAND = serverTool('run_command')

const ECHO_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'echo_tool',
    description: 'Return the supplied text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
})

function toolCall(id, name, args, { rawArguments = false } = {}) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: rawArguments ? String(args) : JSON.stringify(args),
    },
  }
}

function modelResponse(content, toolCalls = [], extra = {}) {
  return { content, toolCalls, ...extra }
}

function toolResults(messages) {
  return messages
    .filter((message) => message?.role === 'tool')
    .map((message) => {
      try {
        return JSON.parse(message.content)
      } catch {
        return { ok: false, code: 'unparseable_tool_result' }
      }
    })
}

function lastToolResult(messages) {
  return toolResults(messages).at(-1)
}

function traceEntry(request, modelCall) {
  const results = toolResults(request.messages || [])
  return {
    modelCall,
    toolChoice: request.toolChoice || null,
    visibleTools: (request.tools || []).map((item) => item?.function?.name).filter(Boolean),
    toolResultCodes: results.map((result) => result.code || (result.ok === true ? 'ok' : 'error')),
  }
}

async function runScenario({
  id,
  prompt,
  model,
  toolSpecs = [],
  executeTool = async () => ({ ok: true }),
  requestToolApproval = async ({ args }) => ({
    proceed: true,
    args,
    approvalId: `${id}-approved`,
  }),
  saveCheckpoint,
  job = {},
  step = {},
  messages,
  ...options
}) {
  const trace = []
  const executions = []
  const approvals = []
  const completed = []
  const checkpoints = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: `offline-eval-${id}`,
      userId: EVAL_USER_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
      ...job,
    },
    step: { id: `offline-eval-${id}-step`, kind: 'chat', ...step },
    messages: messages || [{ role: 'user', content: prompt }],
    toolSpecs,
    maxIters: 6,
    enableToolHooks: false,
    toolRetryBaseDelayMs: 0,
    ...options,
    requestToolApproval: async (request) => {
      approvals.push({ name: request.toolName, args: structuredClone(request.args) })
      return requestToolApproval(request)
    },
    saveCheckpoint: async (state, meta) => {
      checkpoints.push({ state: structuredClone(state), meta: structuredClone(meta) })
      if (typeof saveCheckpoint === 'function') return saveCheckpoint(state, meta)
      return true
    },
    runModel: async (request) => {
      modelCalls += 1
      trace.push(traceEntry(request, modelCalls))
      return model({ request, modelCall: modelCalls, trace })
    },
    executeTool: async (request) => {
      executions.push({ name: request.name, args: structuredClone(request.args) })
      return executeTool(request, executions.length)
    },
    onToolCompleted: async (outcome) => {
      completed.push({
        name: outcome.call.name,
        result: structuredClone(outcome.result),
      })
    },
  })

  return { result, modelCalls, executions, approvals, completed, checkpoints, trace }
}

function task(id, category, title, run) {
  return defineOfflineEvalCase({
    id,
    category,
    title,
    run: async (ctx) => {
      const previousFetch = globalThis.fetch
      const networkAttempts = []
      globalThis.fetch = async (input) => {
        networkAttempts.push(String(input))
        const error = new Error(`Offline capability eval blocked a network request: ${String(input)}`)
        error.code = 'OFFLINE_EVAL_NETWORK_FORBIDDEN'
        throw error
      }
      ctx.defer(() => {
        globalThis.fetch = previousFetch
      })

      try {
        await run(ctx)
        assert.equal(
          networkAttempts.length,
          0,
          `[${id}] offline eval attempted network access`,
        )
      } catch (error) {
        const details = {
          taskId: id,
          category,
          networkAttempts,
        }
        throw new Error(
          `[${id}] ${title} failed\n${JSON.stringify(details, null, 2)}\n${error?.message || error}`,
          { cause: error },
        )
      }
    },
  })
}

const TASKS = Object.freeze([
  task('CAP-01', 'core', '无工具问题直接形成非空回答', async () => {
    const state = await runScenario({
      id: 'CAP-01',
      prompt: '用一句话说明 Gugo 是什么。',
      model: async ({ modelCall }) => {
        assert.equal(modelCall, 1, 'direct answer should require one model call')
        return modelResponse('Gugo 是本地优先的 AI Agent 运行时。')
      },
    })
    assert.equal(state.result.text, 'Gugo 是本地优先的 AI Agent 运行时。')
    assert.equal(state.result.incomplete, undefined)
  }),

  task('CAP-02', 'tools', '读取工具结果后再综合回答', async () => {
    const state = await runScenario({
      id: 'CAP-02',
      prompt: '读取 README.md 并报告标题。',
      toolSpecs: [READ_FILE],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('cap-02-read', 'read_file', { path: 'README.md' })])
        }
        assert.equal(lastToolResult(request.messages)?.content, '# Gugo')
        return modelResponse('README 标题是 Gugo。')
      },
      executeTool: async ({ name, args }) => ({
        ok: true,
        path: args.path,
        content: name === 'read_file' ? '# Gugo' : '',
      }),
    })
    assert.equal(state.result.text, 'README 标题是 Gugo。')
    assert.equal(state.executions.length, 1)
    assert.equal(state.executions[0].name, 'read_file')
    assert.equal(state.executions[0].args.path, 'README.md')
    assert.equal(state.modelCalls, 2)
  }),

  task('CAP-03', 'tools', '同批多工具结果保持配对并汇总', async () => {
    const state = await runScenario({
      id: 'CAP-03',
      prompt: '分别回显 alpha 和 beta，再汇总。',
      toolSpecs: [ECHO_TOOL],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [
            toolCall('cap-03-alpha', 'echo_tool', { text: 'alpha' }),
            toolCall('cap-03-beta', 'echo_tool', { text: 'beta' }),
          ])
        }
        assert.deepEqual(toolResults(request.messages).slice(-2).map((result) => result.echoed), [
          'alpha',
          'beta',
        ])
        return modelResponse('alpha + beta')
      },
      executeTool: async ({ args }) => ({ ok: true, echoed: args.text }),
    })
    assert.equal(state.result.text, 'alpha + beta')
    assert.deepEqual(state.executions.map((entry) => entry.args.text), ['alpha', 'beta'])
  }),

  task('SAFE-01', 'validation', '缺失必填参数时拒绝执行并允许修正', async () => {
    const state = await runScenario({
      id: 'SAFE-01',
      prompt: '回显 corrected。',
      toolSpecs: [ECHO_TOOL],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-01-invalid', 'echo_tool', {})])
        }
        if (modelCall === 2) {
          const invalid = lastToolResult(request.messages)
          assert.equal(invalid.ok, false)
          assert.match(`${invalid.code} ${invalid.error}`, /invalid|required|text/i)
          return modelResponse('', [toolCall('safe-01-valid', 'echo_tool', { text: 'corrected' })])
        }
        assert.equal(lastToolResult(request.messages)?.echoed, 'corrected')
        return modelResponse('参数修正成功。')
      },
      executeTool: async ({ args }) => ({ ok: true, echoed: args.text }),
    })
    assert.deepEqual(state.executions, [{ name: 'echo_tool', args: { text: 'corrected' } }])
    assert.equal(state.result.text, '参数修正成功。')
  }),

  task('SAFE-02', 'validation', '多余参数被拒绝且修正前不得执行', async () => {
    const state = await runScenario({
      id: 'SAFE-02',
      prompt: '只回显 safe，不接受多余参数。',
      toolSpecs: [ECHO_TOOL],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-02-extra', 'echo_tool', {
            text: 'safe',
            extra: 'forbidden',
          })])
        }
        if (modelCall === 2) {
          const denied = lastToolResult(request.messages)
          assert.equal(denied.ok, false)
          assert.match(`${denied.code} ${denied.error}`, /invalid|additional|extra|多余/i)
          return modelResponse('', [toolCall('safe-02-corrected', 'echo_tool', { text: 'safe' })])
        }
        assert.equal(lastToolResult(request.messages)?.echoed, 'safe')
        return modelResponse('多余参数已移除。')
      },
      executeTool: async ({ args }) => ({ ok: true, echoed: args.text }),
    })
    assert.deepEqual(state.executions, [{ name: 'echo_tool', args: { text: 'safe' } }])
    assert.equal(state.result.text, '多余参数已移除。')
  }),

  task('SAFE-03', 'approval', '用户拒绝后不得执行副作用', async () => {
    const state = await runScenario({
      id: 'SAFE-03',
      prompt: '尝试执行命令，但尊重审批结果。',
      toolSpecs: [RUN_COMMAND],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-03-command', 'run_command', { command: 'echo blocked' })])
        }
        const denied = lastToolResult(request.messages)
        assert.equal(denied.ok, false)
        assert.equal(denied.deniedByUser, true)
        return modelResponse('命令被用户拒绝，未执行。')
      },
      requestToolApproval: async () => ({
        proceed: false,
        reason: 'offline eval denial',
        deniedByUser: true,
      }),
    })
    assert.equal(state.approvals.length, 1)
    assert.equal(state.executions.length, 0)
    assert.equal(state.result.text, '命令被用户拒绝，未执行。')
  }),

  task('SAFE-04', 'approval', '审批改写参数后只执行改写值', async () => {
    const state = await runScenario({
      id: 'SAFE-04',
      prompt: '回显审批后的文本。',
      toolSpecs: [ECHO_TOOL],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-04-echo', 'echo_tool', { text: 'before' })])
        }
        assert.equal(lastToolResult(request.messages)?.echoed, 'after')
        return modelResponse('只执行了审批后的参数。')
      },
      requestToolApproval: async () => ({
        proceed: true,
        args: { text: 'after' },
        edited: true,
        approvalId: 'safe-04-edited',
      }),
      executeTool: async ({ args }) => ({ ok: true, echoed: args.text }),
    })
    assert.deepEqual(state.executions, [{ name: 'echo_tool', args: { text: 'after' } }])
    assert.equal(state.result.text, '只执行了审批后的参数。')
  }),

  task('SAFE-05', 'identity', '缺失用户身份时在审批回调前 fail closed', async () => {
    const state = await runScenario({
      id: 'SAFE-05',
      prompt: '在无所属用户时尝试回显。',
      job: { userId: null },
      toolSpecs: [ECHO_TOOL],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-05-ownerless', 'echo_tool', { text: 'blocked' })])
        }
        const denied = lastToolResult(request.messages)
        assert.equal(denied.ok, false)
        assert.match(denied.error || '', /所属用户/)
        return modelResponse('无用户身份，工具未执行。')
      },
    })
    assert.equal(state.approvals.length, 0)
    assert.equal(state.executions.length, 0)
    assert.equal(state.result.text, '无用户身份，工具未执行。')
  }),

  task('SAFE-06', 'policy', '当前只读约束阻止写入调用', async () => {
    const prompt = '只读检查 audit.txt，不要修改或写回任何文件。'
    const state = await runScenario({
      id: 'SAFE-06',
      prompt,
      toolSpecs: [READ_FILE],
      approvalMode: 'bypass',
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-06-write', 'write_file', {
            path: 'audit.txt',
            content: 'forbidden',
          })])
        }
        assert.equal(lastToolResult(request.messages)?.code, 'explicit_read_only_constraint')
        return modelResponse('只读检查完成，没有修改文件。')
      },
    })
    assert.equal(state.executions.length, 0)
    assert.equal(state.result.text, '只读检查完成，没有修改文件。')
  }),

  task('SAFE-07', 'policy', '配置禁用的工具保持可见但不可执行', async () => {
    const state = await runScenario({
      id: 'SAFE-07',
      prompt: '检查已禁用命令工具的执行边界。',
      toolSpecs: [RUN_COMMAND],
      toolsConfig: { disabled: ['run_command'] },
      model: async ({ request, modelCall }) => {
        assert.ok(request.tools.some((item) => item?.function?.name === 'run_command'))
        if (modelCall === 1) {
          return modelResponse('', [toolCall('safe-07-disabled', 'run_command', {
            command: 'echo forbidden',
          })])
        }
        assert.equal(lastToolResult(request.messages)?.code, 'tool_disabled_by_config')
        return modelResponse('工具可见，但配置禁止执行。')
      },
    })
    assert.equal(state.executions.length, 0)
    assert.equal(state.completed[0]?.result?.code, 'tool_disabled_by_config')
    assert.equal(state.result.incomplete, true)
    assert.match(state.result.text, /尚未完成|执行证据/)
  }),

  task('REL-01', 'checkpoint', 'checkpoint 失败时副作用不得开始', async () => {
    let executions = 0
    const checkpointCause = new Error('offline checkpoint unavailable')
    await assert.rejects(
      runScenario({
        id: 'REL-01',
        prompt: '回显前先持久化执行边界。',
        toolSpecs: [ECHO_TOOL],
        model: async () => modelResponse('', [
          toolCall('rel-01-echo', 'echo_tool', { text: 'must-not-run' }),
        ]),
        saveCheckpoint: async (_state, meta) => {
          if (meta?.boundary === 'tool-execution') throw checkpointCause
          return true
        },
        executeTool: async () => {
          executions += 1
          return { ok: true }
        },
      }),
      (error) => {
        assert.equal(error?.code, 'CHECKPOINT_FLUSH_FAILED')
        assert.equal(error?.retryable, true)
        assert.equal(error?.cause, checkpointCause)
        return true
      },
    )
    assert.equal(executions, 0)
  }),

  task('REL-02', 'retry', '瞬时只读失败可重试并最终收敛', async () => {
    let attempts = 0
    const state = await runScenario({
      id: 'REL-02',
      prompt: '读取 busy.txt，并在瞬时失败后继续。',
      toolSpecs: [READ_FILE],
      toolRetryMaxAttempts: 2,
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('rel-02-read', 'read_file', { path: 'busy.txt' })])
        }
        assert.equal(lastToolResult(request.messages)?.attempts, 2)
        return modelResponse('瞬时失败后读取成功。')
      },
      executeTool: async ({ args }) => {
        attempts += 1
        return attempts === 1
          ? { ok: false, code: 'FS_BUSY', error: 'temporarily busy', status: 503, retryable: true }
          : { ok: true, path: args.path, content: 'ready' }
      },
    })
    assert.equal(attempts, 2)
    assert.equal(state.completed[0]?.result?.attempts, 2)
    assert.equal(state.result.text, '瞬时失败后读取成功。')
  }),

  task('REL-03', 'stream-integrity', '截断的工具参数永不执行并要求重生成', async () => {
    const state = await runScenario({
      id: 'REL-03',
      prompt: '读取 README.md 并报告标题。',
      toolSpecs: [READ_FILE],
      model: async ({ request, modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [
            toolCall('rel-03-partial', 'read_file', '{"path":"READ', { rawArguments: true }),
          ], { finishReason: 'length' })
        }
        if (modelCall === 2) {
          assert.equal(lastToolResult(request.messages)?.code, 'tool_call_truncated')
          return modelResponse('', [
            toolCall('rel-03-complete', 'read_file', { path: 'README.md' }),
          ])
        }
        return modelResponse('重生成后读取成功。')
      },
      executeTool: async ({ args }) => ({ ok: true, path: args.path, content: '# Gugo' }),
    })
    assert.equal(state.executions.length, 1)
    assert.equal(state.executions[0].name, 'read_file')
    assert.equal(state.executions[0].args.path, 'README.md')
    assert.equal(state.result.text, '重生成后读取成功。')
  }),

  task('REL-04', 'recovery', '已有工具成果后模型故障返回安全部分结果', async () => {
    const secret = 'LOCAL_SECRET_MUST_NOT_LEAK'
    const state = await runScenario({
      id: 'REL-04',
      prompt: '读取 private.txt 后总结。',
      toolSpecs: [READ_FILE],
      model: async ({ modelCall }) => {
        if (modelCall === 1) {
          return modelResponse('', [toolCall('rel-04-read', 'read_file', { path: 'private.txt' })])
        }
        const error = new Error('offline evaluator injected model failure')
        error.status = 400
        throw error
      },
      executeTool: async ({ args }) => ({ ok: true, path: args.path, content: secret }),
    })
    assert.equal(state.result.interrupted, true)
    assert.match(state.result.text, /read_file/)
    assert.match(state.result.text, /private\.txt/)
    assert.doesNotMatch(state.result.text, new RegExp(secret))
  }),

  task('REL-05', 'completion', '空终答在轮数上限时必须生成可见收尾', async () => {
    const state = await runScenario({
      id: 'REL-05',
      prompt: '给出最终结果。',
      maxIters: 1,
      model: async ({ request }) => (
        request.toolChoice === 'none'
          ? modelResponse('达到边界后已给出明确收尾。')
          : modelResponse('')
      ),
    })
    assert.equal(state.modelCalls, 2)
    assert.equal(state.result.text, '达到边界后已给出明确收尾。')
    assert.ok(state.checkpoints.at(-1)?.state?.final?.text)
  }),
])

assert.ok(TASKS.length >= MIN_TASKS, `expected at least ${MIN_TASKS} tasks`)
assert.ok(TASKS.length <= MAX_TASKS, `expected no more than ${MAX_TASKS} tasks`)
assert.equal(new Set(TASKS.map((item) => item.id)).size, TASKS.length, 'task ids must be unique')
assert.deepEqual(
  [...new Set(TASKS.map((item) => item.category))].sort(),
  ['approval', 'checkpoint', 'completion', 'core', 'identity', 'policy', 'recovery', 'retry', 'stream-integrity', 'tools', 'validation'],
)

export default defineOfflineEvalSuite({
  id: 'capability',
  title: 'Agent capability and safety contract',
  version: 1,
  cases: TASKS,
})
