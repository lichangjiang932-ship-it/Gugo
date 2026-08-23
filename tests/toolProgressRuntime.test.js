import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')
const { revalidateToolPermission } = await import('../server/services/approvalGate.js')

const SIDE_EFFECT_TEST_OWNER = `tool-progress-owner-${process.pid}`
const approveTool = async ({ userId, origin, toolName, args }) => {
  const gate = revalidateToolPermission({ userId, origin, toolName, args, allowAsk: true })
  assert.equal(gate.proceed, true, gate.reason)
  return { ...gate, approvalId: `tool-progress-test-${toolName}` }
}
const INTERNAL_APPROVAL_PRINCIPAL = trustedInternalLoopPrincipal()

function spec(name) {
  return SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
}

const FS_SHELL_ENV_KEYS = [
  'WORKSPACE_ROOT',
  'WORKSPACE_FS_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
  'WORKSPACE_SHARED_TRUSTED',
]

async function withFsShellWorkspace(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-recovery-runtime-'))
  const saved = Object.fromEntries(FS_SHELL_ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
  try {
    return await run(workspace)
  } finally {
    for (const key of FS_SHELL_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

test('tool loop reports executor-derived progress and real file changes', async () => {
  const progress = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'progress-job', userId: null, origin: 'chat', prompt: 'update src/a.js and verify it' },
    step: { id: 'progress-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'update src/a.js and verify it' }],
    toolSpecs: [spec('write_file'), spec('read_file')],
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{
          id: 'write-progress', type: 'function',
          function: { name: 'write_file', arguments: '{"path":"src/a.js","content":"new"}' },
        }] }
      }
      if (modelCalls === 2) {
        return { content: '', toolCalls: [{
          id: 'read-progress', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/a.js"}' },
        }] }
      }
      return { content: 'updated and verified', toolCalls: [] }
    },
    executeTool: async ({ name }) => name === 'write_file'
      ? { ok: true, path: 'src/a.js', changes: [{ path: 'src/a.js', additions: 2, deletions: 1 }] }
      : { ok: true, path: 'src/a.js', content: 'new' },
    onProgress: async (value) => progress.push(value),
  })

  assert.equal(result.text, 'updated and verified')
  assert.ok(progress.some((value) => (
    value.completed === 0 && value.total === 1 && value.phase === 'tools_scheduled'
  )))
  assert.ok(progress.some((value) => (
    value.completed === 1
    && value.filesChanged === 1
    && value.additions === 2
    && value.deletions === 1
  )))
  assert.deepEqual(progress.at(-1), {
    completed: 2,
    total: 2,
    iteration: 2,
    filesChanged: 1,
    additions: 2,
    deletions: 1,
    phase: 'batch_completed',
  })
})

test('bash expected-output evidence drives progress and the exact verification target', async () => {
  const progress = []
  const requests = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'shell-output-progress-job',
      userId: null,
      origin: 'chat',
      prompt: 'Generate the report with a command and verify the actual output.',
    },
    step: { id: 'shell-output-progress-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Generate the report with a command and verify the actual output.' }],
    toolSpecs: [spec('bash_exec'), spec('read_file')],
    maxIters: 8,
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{
          id: 'generate-report',
          type: 'function',
          function: {
            name: 'bash_exec',
            arguments: JSON.stringify({
              command: 'node generate-report.js',
              expected_outputs: ['requested/report.pdf'],
            }),
          },
        }] }
      }
      if (modelCalls === 2) {
        return { content: '', toolCalls: [{
          id: 'read-requested-path',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"requested/report.pdf"}' },
        }] }
      }
      if (modelCalls === 3) return { content: 'Report complete.', toolCalls: [] }
      if (modelCalls === 4) {
        return { content: '', toolCalls: [{
          id: 'read-actual-path',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"actual/report.pdf"}' },
        }] }
      }
      return { content: 'Report generated and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => name === 'bash_exec'
      ? {
          ok: true,
          exitCode: 0,
          changedPaths: ['actual/report.pdf'],
          verifiedOutputs: [{ path: 'actual/report.pdf', status: 'created' }],
          unverifiedOutputs: [],
        }
      : { ok: true, path: args.path, content: 'report' },
    onProgress: async (value) => progress.push(value),
  })

  const guardedRequest = requests[3]
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.match(guardedRequest, /Pending changed targets: actual\/report\.pdf/)
  assert.doesNotMatch(guardedRequest, /requested\/report\.pdf/)
  assert.equal(progress.at(-1).filesChanged, 1)
  assert.equal(result.text, 'Report generated and verified.')
})

test('bash progress resolves an inferred relative output against cwd exactly once', async () => {
  const progress = []
  await withFsShellWorkspace(async (workspace) => {
    fs.mkdirSync(path.join(workspace, 'nested'))
    let modelCalls = 0
    const result = await runToolsLoop({
      job: {
        id: 'shell-relative-progress-job',
        userId: SIDE_EFFECT_TEST_OWNER,
        sessionId: `shell-relative-progress-session-${process.pid}`,
        origin: 'chat',
        prompt: 'Create nested/relative-progress.txt with a command and verify it.',
      },
      step: { id: 'shell-relative-progress-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'Create nested/relative-progress.txt with a command and verify it.' }],
      intentMode: 'execute',
      toolSpecs: [spec('bash_exec'), spec('read_file')],
      maxIters: 5,
      enableToolHooks: false,
      requestToolApproval: approveTool,
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return { content: '', toolCalls: [{
            id: 'write-relative-progress',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                cwd: 'nested',
                command: 'echo relative-progress>relative-progress.txt',
              }),
            },
          }] }
        }
        if (modelCalls === 2) {
          return { content: '', toolCalls: [{
            id: 'read-relative-progress',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'nested/relative-progress.txt' }),
            },
          }] }
        }
        return { content: 'Relative output created and verified.', toolCalls: [] }
      },
      onProgress: async (value) => progress.push(value),
    })

    assert.equal(result.text, 'Relative output created and verified.')
    assert.equal(result.incomplete, undefined)
    assert.match(fs.readFileSync(path.join(workspace, 'nested', 'relative-progress.txt'), 'utf8'), /relative-progress/)
  })

  assert.ok(progress.some((value) => value.filesChanged === 1 && value.phase === 'tool_completed'))
  assert.equal(progress.at(-1).filesChanged, 1)
})

test('inline Python writes contribute executor-verified file progress', async () => {
  const progress = []
  await withFsShellWorkspace(async (workspace) => {
    fs.mkdirSync(path.join(workspace, 'python-output'))
    let modelCalls = 0
    const result = await runToolsLoop({
      job: {
        id: 'inline-python-progress-job',
        userId: SIDE_EFFECT_TEST_OWNER,
        sessionId: `inline-python-progress-session-${process.pid}`,
        origin: 'chat',
        prompt: 'Create python-output/inline-progress.txt with Python and verify it.',
      },
      step: { id: 'inline-python-progress-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'Create python-output/inline-progress.txt with Python and verify it.' }],
      intentMode: 'execute',
      toolSpecs: [spec('bash_exec'), spec('read_file')],
      maxIters: 5,
      enableToolHooks: false,
      requestToolApproval: approveTool,
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return { content: '', toolCalls: [{
            id: 'write-inline-python-progress',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                cwd: 'python-output',
                command: `python -c "from pathlib import Path; Path('inline-progress.txt').write_text('python-progress', encoding='utf-8')"`,
              }),
            },
          }] }
        }
        if (modelCalls === 2) {
          return { content: '', toolCalls: [{
            id: 'read-inline-python-progress',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'python-output/inline-progress.txt' }),
            },
          }] }
        }
        return { content: 'Inline Python output created and verified.', toolCalls: [] }
      },
      onProgress: async (value) => progress.push(value),
    })

    assert.equal(result.text, 'Inline Python output created and verified.')
    assert.equal(result.incomplete, undefined)
    assert.equal(
      fs.readFileSync(path.join(workspace, 'python-output', 'inline-progress.txt'), 'utf8'),
      'python-progress',
    )
  })

  assert.ok(progress.some((value) => value.filesChanged === 1 && value.phase === 'tool_completed'))
  assert.equal(progress.at(-1).filesChanged, 1)
})

test('failed expected outputs do not create progress or mutation evidence', async () => {
  const progress = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'shell-unchanged-output-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create unchanged.txt with a command.',
    },
    step: { id: 'shell-unchanged-output-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create unchanged.txt with a command.' }],
    toolSpecs: [spec('bash_exec')],
    maxIters: 1,
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    runModel: async ({ toolChoice }) => {
      modelCalls += 1
      return toolChoice === 'none'
        ? { content: 'The output did not change.', toolCalls: [] }
        : { content: '', toolCalls: [{
            id: 'unchanged-output',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'node no-op.js',
                expected_outputs: ['unchanged.txt'],
              }),
            },
          }] }
    },
    executeTool: async () => ({
      ok: false,
      code: 'EXPECTED_OUTPUT_VERIFICATION_FAILED',
      verificationFailed: true,
      changedPaths: [],
      verifiedOutputs: [],
      unverifiedOutputs: [{ path: 'unchanged.txt', status: 'unchanged' }],
      error: 'expected output was unchanged',
    }),
    onProgress: async (value) => progress.push(value),
  })

  assert.equal(modelCalls, 2)
  assert.equal(progress.at(-1).filesChanged, 0)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
})

test('completed progress is not counted twice after checkpoint resume', async () => {
  let checkpoint = null
  let executions = 0
  await assert.rejects(() => runToolsLoop({
    job: { id: 'progress-resume-job', userId: null, origin: 'chat', prompt: 'update resume.txt and verify it' },
    step: { id: 'progress-resume-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'update resume.txt and verify it' }],
    toolSpecs: [spec('write_file'), spec('read_file')],
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
    runModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'durable-write', type: 'function',
        function: { name: 'write_file', arguments: '{"path":"resume.txt","content":"new"}' },
      }],
    }),
    executeTool: async () => {
      executions += 1
      return { ok: true, path: 'resume.txt', changes: [{ path: 'resume.txt', additions: 1, deletions: 1 }] }
    },
    onToolCompleted: async () => { throw new Error('event sink interrupted after durable outcome') },
  }), /event sink interrupted/)
  assert.equal(executions, 1)
  assert.equal(checkpoint.progress.additions, 1)

  let resumedModelCalls = 0
  const resumed = await runToolsLoop({
    job: { id: 'progress-resume-job', userId: null, origin: 'chat', prompt: 'update resume.txt and verify it' },
    step: { id: 'progress-resume-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'update resume.txt and verify it' }],
    toolSpecs: [spec('write_file'), spec('read_file')],
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
    runModel: async () => {
      resumedModelCalls += 1
      return resumedModelCalls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'durable-read', type: 'function',
              function: { name: 'read_file', arguments: '{"path":"resume.txt"}' },
            }],
          }
        : { content: 'resumed and verified', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executions += 1
      assert.equal(name, 'read_file')
      return { ok: true, path: 'resume.txt', content: 'new' }
    },
  })

  assert.equal(resumed.text, 'resumed and verified')
  assert.equal(executions, 2)
  assert.equal(checkpoint.progress.additions, 1)
  assert.equal(checkpoint.progress.deletions, 1)
})

test('two real edit_file match failures inject their production fs_tool_failed recovery context', async () => {
  const requests = []
  const checkpoints = []
  let modelCalls = 0
  const result = await withFsShellWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, 'existing.txt'), 'current contents\n', 'utf8')
    return runToolsLoop({
      job: { id: 'reflection-job', userId: SIDE_EFFECT_TEST_OWNER, origin: 'job', prompt: 'inspect an editing failure pattern' },
      step: { id: 'reflection-step', kind: 'plan' },
      messages: [{ role: 'user', content: 'inspect an editing failure pattern' }],
      toolSpecs: [spec('edit_file')],
      executionGuardMode: 'read_only_exploration',
      enableToolHooks: false,
      requestToolApproval: approveTool,
      saveCheckpoint: async (state) => { checkpoints.push(structuredClone(state)); return true },
      runModel: async ({ messages }) => {
        requests.push(structuredClone(messages))
        modelCalls += 1
        if (modelCalls <= 2) {
          return {
            content: '',
            toolCalls: [{
              id: `failed-edit-${modelCalls}`,
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'existing.txt',
                  old_string: `missing-text-${modelCalls}`,
                  new_string: 'replacement',
                }),
              },
            }],
          }
        }
        return { content: 'reported a specific blocker', toolCalls: [] }
      },
    })
  })

  const editResults = requests[2]
    .filter((message) => message.role === 'tool' && message.name === 'edit_file')
    .map((message) => JSON.parse(message.content))
  assert.deepEqual(editResults.map((value) => value.code), ['fs_tool_failed', 'fs_tool_failed'])
  const recoveryText = requests[2]
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.match(recoveryText, /\[TOOL FAILURE RECOVERY REQUIRED\]/)
  assert.match(recoveryText, /fs_tool_failed/)
  assert.match(recoveryText, /materially different strategy/)
  assert.equal(result.text, 'reported a specific blocker')
  assert.equal(checkpoints.at(-1).failureRecovery.reflected, true)
  assert.equal(checkpoints.at(-1).failureRecovery.count, 2)
})

test('two real non-zero bash exits inject production tool_execution_failed recovery context', async () => {
  const requests = []
  const checkpoints = []
  let modelCalls = 0
  const result = await withFsShellWorkspace(() => runToolsLoop({
    job: { id: 'shell-reflection-job', userId: SIDE_EFFECT_TEST_OWNER, origin: 'job', prompt: 'diagnose a failing project command' },
    step: { id: 'shell-reflection-step', kind: 'plan' },
    messages: [{ role: 'user', content: 'diagnose a failing project command' }],
    toolSpecs: [spec('bash_exec')],
    executionGuardMode: 'read_only_exploration',
    enableToolHooks: false,
    requestToolApproval: approveTool,
    saveCheckpoint: async (state) => { checkpoints.push(structuredClone(state)); return true },
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      modelCalls += 1
      if (modelCalls <= 2) {
        const command = process.platform === 'win32'
          ? `echo deterministic-shell-failure-${modelCalls} 1>&2 & exit /b 7`
          : `printf deterministic-shell-failure-${modelCalls} >&2; exit 7`
        return {
          content: '',
          toolCalls: [{
            id: `failed-shell-${modelCalls}`,
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command }),
            },
          }],
        }
      }
      return { content: 'reported the concrete command blocker', toolCalls: [] }
    },
  }))

  const shellResults = requests[2]
    .filter((message) => message.role === 'tool' && message.name === 'bash_exec')
    .map((message) => JSON.parse(message.content))
  assert.deepEqual(shellResults.map((value) => value.code), ['tool_execution_failed', 'tool_execution_failed'])
  assert.deepEqual(shellResults.map((value) => value.exitCode), [7, 7])
  const recoveryText = requests[2]
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.match(recoveryText, /\[TOOL FAILURE RECOVERY REQUIRED\]/)
  assert.match(recoveryText, /bash_exec/)
  assert.match(recoveryText, /tool_execution_failed/)
  assert.match(recoveryText, /7/)
  assert.equal(result.text, 'reported the concrete command blocker')
  assert.equal(checkpoints.at(-1).failureRecovery.reflected, true)
  assert.equal(checkpoints.at(-1).failureRecovery.count, 2)
})

test('empty and unrelated diffs cannot clear a changed file verification target', async () => {
  const requests = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'diff-evidence-job', userId: null, origin: 'chat', prompt: 'update src/a.js and verify it' },
    step: { id: 'diff-evidence-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'update src/a.js and verify it' }],
    toolSpecs: [spec('write_file'), spec('git_diff')],
    maxIters: 8,
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{
          id: 'diff-write', type: 'function',
          function: { name: 'write_file', arguments: '{"path":"src/a.js","content":"new"}' },
        }] }
      }
      if (modelCalls === 2) {
        return { content: '', toolCalls: [{
          id: 'empty-diff', type: 'function',
          function: { name: 'git_diff', arguments: '{"path":"src/a.js"}' },
        }] }
      }
      if (modelCalls === 3) {
        return { content: '', toolCalls: [{
          id: 'unrelated-diff', type: 'function',
          function: { name: 'git_diff', arguments: '{"path":"src/b.js"}' },
        }] }
      }
      if (modelCalls === 4) return { content: 'premature completion', toolCalls: [] }
      if (modelCalls === 5) {
        return { content: '', toolCalls: [{
          id: 'matching-diff', type: 'function',
          function: { name: 'git_diff', arguments: '{"path":"src/a.js"}' },
        }] }
      }
      return { content: 'verified matching diff', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') return { ok: true, path: 'src/a.js' }
      if (args.path === 'src/a.js' && modelCalls === 2) {
        return { ok: true, path: 'src/a.js', diff: '', stat: '' }
      }
      const file = args.path
      return {
        ok: true,
        path: file,
        diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`,
      }
    },
  })

  const guardedRequest = requests[4]
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.match(guardedRequest, /Pending changed targets: src\/a\.js/)
  assert.equal(result.text, 'verified matching diff')
  assert.equal(modelCalls, 6)
})

test('a successful project check verifies known changed-file targets', async () => {
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'check-evidence-job', userId: null, origin: 'chat', prompt: 'update src/a.js and run the project test' },
    step: { id: 'check-evidence-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'update src/a.js and run the project test' }],
    toolSpecs: [spec('write_file'), spec('run_project_check')],
    enableToolHooks: false,
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{
          id: 'check-write', type: 'function',
          function: { name: 'write_file', arguments: '{"path":"src/a.js","content":"new"}' },
        }] }
      }
      if (modelCalls === 2) {
        return { content: '', toolCalls: [{
          id: 'project-check', type: 'function',
          function: { name: 'run_project_check', arguments: '{"check":"test"}' },
        }] }
      }
      return { content: 'updated and tests passed', toolCalls: [] }
    },
    executeTool: async ({ name }) => name === 'write_file'
      ? { ok: true, path: 'src/a.js' }
      : { ok: true, check: 'test', exitCode: 0 },
  })

  assert.equal(result.text, 'updated and tests passed')
  assert.equal(modelCalls, 3)
})
