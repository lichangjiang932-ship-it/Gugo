import assert from 'node:assert/strict'
import test from 'node:test'

const {
  runToolsLoop: runToolsLoopRuntime,
  SERVER_TOOL_SPECS,
} = await import('../server/services/jobTools.js')
const {
  buildTaskVerificationRepairPrompt,
  observeTaskVerificationRepair,
  restoreTaskVerificationRepair,
  serializeTaskVerificationRepair,
  taskVerificationRepairBlockerText,
  taskVerificationKinds,
} = await import('../server/services/loop/taskVerificationRepair.js')

const TEST_USER_ID = 'task-verification-repair-user'

function spec(name) {
  const found = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(found, `missing tool spec: ${name}`)
  return found
}

function toolCall(id, name, args) {
  return {
    content: '',
    toolCalls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function runToolsLoop(options = {}) {
  return runToolsLoopRuntime({
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'task-verification-repair-approved',
    }),
    enableToolHooks: false,
    ...options,
    job: {
      ...options.job,
      userId: options.job?.userId || TEST_USER_ID,
    },
  })
}

test('task verification repair state round-trips without trusting an unmodified test failure', () => {
  const state = restoreTaskVerificationRepair()
  const call = { name: 'run_project_check', args: { check: 'test' } }
  const result = { ok: false, check: 'test', exitCode: 1, stderr: 'expected 2, received 1' }

  const reportOnly = observeTaskVerificationRepair(state, call, result, {
    mutationObserved: false,
  })
  assert.equal(reportOnly.changed, false)
  assert.equal(state.pending.size, 0)

  const repair = observeTaskVerificationRepair(state, call, result, {
    mutationObserved: true,
  })
  assert.equal(repair.failed, true)
  assert.match(buildTaskVerificationRepairPrompt(state), /preceding tool-role result/)

  const restored = restoreTaskVerificationRepair(serializeTaskVerificationRepair(state))
  assert.deepEqual([...restored.pending.values()].map(({ kind }) => kind), ['test'])
  assert.equal([...restored.pending.values()][0].failures, 1)
  assert.equal(restored.consecutiveFailures, 1)
})

test('verification diagnostics redact credentials before checkpoint persistence and final display', () => {
  const state = restoreTaskVerificationRepair()
  const exposed = 'github_pat_this-secret-must-never-persist'
  observeTaskVerificationRepair(state, {
    name: 'run_project_check',
    args: { check: 'test' },
  }, {
    ok: false,
    check: 'test',
    exitCode: 1,
    stderr: `request failed with token=${exposed}`,
  }, { mutationObserved: true })

  const serialized = serializeTaskVerificationRepair(state)
  assert.doesNotMatch(JSON.stringify(serialized), new RegExp(exposed))
  assert.match(JSON.stringify(serialized), /\[REDACTED\]/)

  const restored = restoreTaskVerificationRepair({
    ...serialized,
    pending: serialized.pending.map((entry) => ({ ...entry, message: exposed })),
  })
  assert.doesNotMatch(JSON.stringify(serializeTaskVerificationRepair(restored)), new RegExp(exposed))
  assert.doesNotMatch(taskVerificationRepairBlockerText(restored), new RegExp(exposed))
})

test('verification debt uses a canonical check scope and ignores infrastructure failures', () => {
  const state = restoreTaskVerificationRepair()
  const failedCall = { name: 'bash_exec', args: { command: 'npm test', cwd: '.' } }
  observeTaskVerificationRepair(state, failedCall, {
    ok: false,
    exitCode: 1,
    stderr: 'one assertion failed',
  }, { mutationObserved: true })
  assert.equal(state.pending.size, 1)

  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'echo npm test', cwd: '.' },
  }, { ok: true, exitCode: 0 }, { mutationObserved: true })
  assert.equal(state.pending.size, 1, 'quoted command text cannot clear verification debt')

  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'npm test', cwd: 'packages/narrow' },
  }, { ok: true, exitCode: 0 }, { mutationObserved: true })
  assert.equal(state.pending.size, 1, 'a narrower cwd cannot clear root verification debt')

  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'npm test -- src/narrow.test.js', cwd: '.' },
  }, { ok: true, exitCode: 0 }, { mutationObserved: true })
  assert.equal(state.pending.size, 1, 'a narrower command cannot clear full-suite verification debt')

  observeTaskVerificationRepair(state, {
    name: 'run_project_check',
    args: { check: 'test', cwd: '.' },
  }, {
    ok: true,
    check: 'test',
    exitCode: 0,
    stdout: 'all tests passed',
  }, { mutationObserved: true })
  assert.equal(state.pending.size, 0, 'an equivalent full check can clear debt across executors')

  observeTaskVerificationRepair(state, {
    name: 'run_project_check',
    args: { check: 'lint' },
  }, {
    ok: false,
    exitCode: 1,
    timedOut: true,
    code: 'COMMAND_TIMEOUT',
  }, { mutationObserved: true })
  assert.equal(state.pending.size, 0, 'timeouts do not consume code-repair attempts')

  observeTaskVerificationRepair(state, {
    name: 'run_project_check',
    args: { check: 'build' },
  }, {
    ok: false,
    passed: false,
    exitCode: 1,
    systemFailure: true,
    stderr: 'the build runner crashed before producing a project verdict',
  }, { mutationObserved: true })
  assert.equal(state.pending.size, 0, 'system failures do not consume code-repair attempts')
  assert.equal(state.consecutiveFailures, 0)
  assert.deepEqual(
    taskVerificationKinds({ name: 'run_test', args: { command: 'npm run lint' } }),
    ['lint'],
  )
})

test('a failed post-mutation check must be repaired and rerun before completion', async () => {
  let modelCalls = 0
  let checkCalls = 0
  let editCalls = 0
  const modelInputs = []
  const executed = []

  const result = await runToolsLoop({
    job: {
      id: 'repair-then-pass-job',
      origin: 'chat',
      prompt: 'Fix src/result.js and run the project tests.',
    },
    step: { id: 'repair-then-pass-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Fix src/result.js and run the project tests.' }],
    intentMode: 'execute',
    maxIters: 10,
    toolSpecs: [
      spec('write_file'),
      spec('edit_file'),
      spec('read_file'),
      spec('git_diff'),
      spec('run_project_check'),
    ],
    runModel: async ({ messages }) => {
      modelCalls += 1
      modelInputs.push(structuredClone(messages))
      if (modelCalls === 1) {
        return toolCall('write-broken-result', 'write_file', {
          path: 'src/result.js',
          content: 'export const result = 1\n',
        })
      }
      if (modelCalls === 2) {
        return toolCall('run-failing-tests', 'run_project_check', { check: 'test' })
      }
      if (modelCalls === 3) {
        return toolCall('inspect-failing-source', 'read_file', { path: 'src/result.js' })
      }
      if (modelCalls === 4) return toolCall('inspect-failing-diff', 'git_diff', {})
      if (modelCalls === 5) return { content: 'The change is complete.', toolCalls: [] }
      if (modelCalls === 6) {
        return toolCall('repair-result', 'edit_file', {
          path: 'src/result.js',
          old_string: 'result = 1',
          new_string: 'result = 2',
        })
      }
      if (modelCalls === 7) {
        return toolCall('rerun-passing-tests', 'run_project_check', { check: 'test' })
      }
      return { content: 'The implementation was corrected and the tests pass.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args: structuredClone(args) })
      if (name === 'write_file') {
        return { ok: true, path: 'src/result.js' }
      }
      if (name === 'edit_file') {
        editCalls += 1
        return { ok: true, path: 'src/result.js', replacedCount: 1 }
      }
      if (name === 'read_file') return { ok: true, path: 'src/result.js', content: 'export const result = 1\n' }
      if (name === 'git_diff') return { ok: true, diff: '- result = 2\n+ result = 1' }
      checkCalls += 1
      return checkCalls === 1
        ? { ok: false, check: 'test', exitCode: 1, stderr: 'result.test.js: expected 2, received 1' }
        : { ok: true, check: 'test', exitCode: 0, stdout: '1 test passed' }
    },
  })

  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'The implementation was corrected and the tests pass.')
  assert.equal(checkCalls, 2)
  assert.equal(editCalls, 1)
  assert.equal(modelCalls, 8)
  assert.deepEqual(executed.map(({ name }) => name), [
    'write_file',
    'run_project_check',
    'read_file',
    'git_diff',
    'edit_file',
    'run_project_check',
  ])
  assert.deepEqual(executed.find(({ name }) => name === 'edit_file')?.args, {
    path: 'src/result.js',
    old_string: 'result = 1',
    new_string: 'result = 2',
    replace_all: false,
  })
  assert.ok(modelInputs.some((messages) => messages.some((message) => (
    message?.role === 'system'
      && String(message.content).includes('[TASK VERIFICATION REPAIR REQUIRED]')
  ))))
  assert.ok(modelInputs.some((messages) => messages.some((message) => (
    message?.role === 'tool'
      && String(message.content).includes('result.test.js: expected 2, received 1')
  ))))
})

test('three failed post-mutation checks with different parameters still stop with the concrete blocker', async () => {
  let modelCalls = 0
  let checkCalls = 0
  let editCalls = 0
  let checkpoint = null
  const failedCommands = [
    'npm test -- --runInBand',
    'npm test -- --watch=false',
    'npm test -- src/result.test.js',
  ]

  const result = await runToolsLoop({
    job: {
      id: 'repair-exhausted-job',
      origin: 'chat',
      prompt: 'Fix src/result.js and make the lint check pass.',
    },
    step: { id: 'repair-exhausted-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Fix src/result.js and make the lint check pass.' }],
    intentMode: 'execute',
    maxIters: 10,
    toolSpecs: [spec('write_file'), spec('edit_file'), spec('bash_exec')],
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return toolCall('write-lint-target', 'write_file', {
          path: 'src/result.js',
          content: 'export const result = 1\n',
        })
      }
      if (modelCalls === 3) {
        return toolCall('first-lint-repair', 'edit_file', {
          path: 'src/result.js',
          old_string: 'result = 1',
          new_string: 'result = 2',
        })
      }
      if (modelCalls === 5) {
        return toolCall('second-lint-repair', 'edit_file', {
          path: 'src/result.js',
          old_string: 'result = 2',
          new_string: 'result = 3',
        })
      }
      return toolCall(`test-failure-${modelCalls}`, 'bash_exec', {
        command: failedCommands[checkCalls],
        cwd: '.',
      })
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') return { ok: true, path: 'src/result.js' }
      if (name === 'edit_file') {
        editCalls += 1
        return { ok: true, path: 'src/result.js', replacedCount: 1 }
      }
      assert.equal(args.command, failedCommands[checkCalls])
      checkCalls += 1
      return {
        ok: false,
        exitCode: 1,
        stderr: 'src/result.test.js: expected 2, received 1',
      }
    },
  })

  assert.equal(modelCalls, 6)
  assert.equal(editCalls, 2)
  assert.equal(checkCalls, 3)
  assert.equal(result.incomplete, true)
  assert.equal(
    result.reason,
    'task_verification_repair_exhausted',
    JSON.stringify(result),
  )
  assert.match(result.text, /src\/result\.test\.js: expected 2, received 1/)
  assert.equal(checkpoint?.completionGuards?.taskVerificationRepair?.consecutiveFailures, 3)
  assert.equal(checkpoint?.completionGuards?.taskVerificationRepair?.pending?.length, 3)
  assert.deepEqual(
    checkpoint?.completionGuards?.taskVerificationRepair?.pending?.map(({ failures }) => failures),
    [1, 1, 1],
  )
})

test('parallel failing checks consume one repair round and still allow a model correction', async () => {
  let modelCalls = 0
  let checkCalls = 0
  let editCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'parallel-repair-round-job',
      origin: 'chat',
      prompt: 'Fix src/result.js, then run test, lint, and build.',
    },
    step: { id: 'parallel-repair-round-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Fix src/result.js, then run test, lint, and build.' }],
    intentMode: 'execute',
    maxIters: 8,
    toolSpecs: [spec('write_file'), spec('edit_file'), spec('run_project_check')],
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return toolCall('parallel-write', 'write_file', {
          path: 'src/result.js',
          content: 'export const result = 1\n',
        })
      }
      if (modelCalls === 3) {
        return toolCall('parallel-repair', 'edit_file', {
          path: 'src/result.js',
          old_string: 'result = 1',
          new_string: 'result = 2',
        })
      }
      if (modelCalls === 2 || modelCalls === 4) {
        return {
          content: '',
          toolCalls: ['test', 'lint', 'build'].map((check) => ({
            id: `${check}-${modelCalls}`,
            type: 'function',
            function: {
              name: 'run_project_check',
              arguments: JSON.stringify({ check }),
            },
          })),
        }
      }
      return { content: 'The implementation was corrected and all project checks pass.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file') return { ok: true, path: 'src/result.js' }
      if (name === 'edit_file') {
        editCalls += 1
        return { ok: true, path: 'src/result.js', replacedCount: 1 }
      }
      checkCalls += 1
      const check = ['test', 'lint', 'build'][(checkCalls - 1) % 3]
      return checkCalls <= 3
        ? { ok: false, check, exitCode: 1, stderr: `${check} failed before repair` }
        : { ok: true, check, exitCode: 0, stdout: `${check} passed after repair` }
    },
  })

  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'The implementation was corrected and all project checks pass.')
  assert.equal(modelCalls, 5)
  assert.equal(editCalls, 1)
  assert.equal(checkCalls, 6)
  assert.equal(checkpoint?.completionGuards?.taskVerificationRepair?.consecutiveFailures, 0)
  assert.equal(checkpoint?.completionGuards?.taskVerificationRepair?.pending?.length, 0)
})

test('verification repair attempts survive checkpoint recovery without replaying completed tools', async () => {
  const job = {
    id: 'repair-checkpoint-job',
    origin: 'chat',
    prompt: 'Fix src/result.js and make the tests pass.',
  }
  const step = { id: 'repair-checkpoint-step', kind: 'chat' }
  const toolSpecs = [spec('write_file'), spec('edit_file'), spec('run_project_check')]
  let resumeState = null
  let firstModelCalls = 0
  let firstCheckCalls = 0

  const firstResult = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: job.prompt }],
    intentMode: 'execute',
    maxIters: 10,
    toolSpecs,
    saveCheckpoint: async (state) => {
      if (!resumeState
        && !state.final
        && !state.modelInvocation
        && Array.isArray(state.toolCalls)
        && state.toolCalls.length === 0
        && state.completionGuards?.taskVerificationRepair?.consecutiveFailures === 1
        && state.completionGuards?.taskVerificationRepair?.pending?.[0]?.failures === 1) {
        resumeState = structuredClone(state)
      }
      return { state }
    },
    runModel: async () => {
      firstModelCalls += 1
      if (firstModelCalls === 1) {
        return toolCall('checkpoint-write', 'write_file', {
          path: 'src/result.js',
          content: 'export const result = 1\n',
        })
      }
      if (firstModelCalls === 2) {
        return toolCall('checkpoint-failing-test', 'run_project_check', { check: 'test' })
      }
      if (firstModelCalls === 3) {
        return toolCall('checkpoint-repair', 'edit_file', {
          path: 'src/result.js',
          old_string: 'result = 1',
          new_string: 'result = 2',
        })
      }
      if (firstModelCalls === 4) {
        return toolCall('checkpoint-passing-test', 'run_project_check', { check: 'test' })
      }
      return { content: 'The repaired project passes its tests.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file' || name === 'edit_file') {
        return { ok: true, path: 'src/result.js' }
      }
      firstCheckCalls += 1
      return firstCheckCalls === 1
        ? { ok: false, check: 'test', exitCode: 1, stderr: 'expected 2, received 1' }
        : { ok: true, check: 'test', exitCode: 0, stdout: '1 test passed' }
    },
  })

  assert.equal(firstResult.incomplete, undefined)
  assert.equal(firstCheckCalls, 2)
  assert.ok(resumeState, 'the post-failure checkpoint must be persisted before another model request')

  let secondModelCalls = 0
  let secondCheckCalls = 0
  let secondEditCalls = 0
  let restoredCheckpoint = null
  const secondResult = await runToolsLoop({
    job,
    step,
    messages: [],
    loadCheckpoint: async () => ({ state: structuredClone(resumeState) }),
    saveCheckpoint: async (state) => {
      restoredCheckpoint = structuredClone(state)
      return { state }
    },
    intentMode: 'execute',
    maxIters: 10,
    toolSpecs,
    runModel: async () => {
      secondModelCalls += 1
      if (secondModelCalls === 1 || secondModelCalls === 3) {
        return toolCall(`resumed-repair-${secondModelCalls}`, 'edit_file', {
          path: 'src/result.js',
          old_string: secondModelCalls === 1 ? 'result = 1' : 'result = 2',
          new_string: secondModelCalls === 1 ? 'result = 2' : 'result = 3',
        })
      }
      return toolCall(`resumed-failure-${secondModelCalls}`, 'run_project_check', { check: 'test' })
    },
    executeTool: async ({ name }) => {
      if (name === 'edit_file') {
        secondEditCalls += 1
        return { ok: true, path: 'src/result.js', replacedCount: 1 }
      }
      assert.equal(name, 'run_project_check', 'completed pre-checkpoint tools must not replay')
      secondCheckCalls += 1
      return { ok: false, check: 'test', exitCode: 1, stderr: 'expected 2, received 1' }
    },
  })

  assert.equal(secondModelCalls, 4)
  assert.equal(secondEditCalls, 2)
  assert.equal(secondCheckCalls, 2)
  assert.equal(secondResult.incomplete, true)
  assert.equal(secondResult.reason, 'task_verification_repair_exhausted')
  assert.equal(
    restoredCheckpoint?.completionGuards?.taskVerificationRepair?.consecutiveFailures,
    3,
  )
  assert.equal(
    restoredCheckpoint?.completionGuards?.taskVerificationRepair?.pending?.[0]?.failures,
    3,
  )
})

test('a report-only failing test does not authorize an automatic code repair', async () => {
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'report-only-test-job',
      origin: 'chat',
      prompt: 'Run the tests and report the result without changing files.',
    },
    step: { id: 'report-only-test-step', kind: 'verify' },
    messages: [{ role: 'user', content: 'Run the tests and report the result without changing files.' }],
    intentMode: 'execute',
    maxIters: 4,
    toolSpecs: [spec('run_test')],
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) return toolCall('report-failing-test', 'run_test', { framework: 'auto' })
      return { content: 'The test run failed with one assertion error.', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: false,
      passed: false,
      exitCode: 1,
      framework: 'node',
      stderr: '1 assertion failed',
    }),
  })

  assert.ok(modelCalls >= 2)
  assert.equal(
    checkpoint?.completionGuards?.taskVerificationRepair?.pending?.length || 0,
    0,
  )
  assert.doesNotMatch(result.text, /correction attempts|Task verification did not pass/)
})
