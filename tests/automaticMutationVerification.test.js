import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolsLoop, SERVER_TOOL_SPECS } from '../server/services/jobTools.js'
import { trustedInternalLoopPrincipal } from '../server/services/loop/internalExecutionPrincipal.js'
import { resetManualRetryVerificationBudget } from '../server/services/turnFailedRetryPolicy.js'
import { captureMutationVerificationIntent, restoreMutationVerificationRecovery, scheduleMutationVerificationRecovery, MAX_AUTOMATIC_VERIFICATION_CALLS } from '../server/services/loop/mutationVerificationRecovery.js'
import { createJobBudget } from '../server/utils/jobBudget.js'
import { createLoopEvents } from '../server/services/loop/events.js'
import { getDynamicTool, registerDynamicTool } from '../server/utils/toolSchemaDynamicRegistry.js'

const principal = trustedInternalLoopPrincipal()
const spec = (name) => SERVER_TOOL_SPECS.find((item) => item.function?.name === name)
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

function fixture({ targets = ['notes.txt'], maxIters = 8, ...overrides } = {}) {
  const executions = []
  const checkpoints = []
  let modelCalls = 0
  const prompt = 'Update the exact local files and verify the changed content.'
  const options = {
    approvalPrincipal: principal, approvalMode: 'bypass',
    job: { id: 'automatic-verification-job', userId: null, origin: 'chat', prompt, userPrompt: prompt },
    step: { id: 'automatic-verification-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: [spec('write_file'), spec('read_file'), spec('list_directory')],
    intentMode: 'execute', maxIters, enableToolHooks: false,
    saveCheckpoint: async (state) => { checkpoints.push(structuredClone(state)); return true },
    runModel: async () => {
      modelCalls += 1
      return modelCalls === 1 ? { content: '', toolCalls: targets.map((path, index) => call(`write-${index}`, 'write_file', { path, content: 'updated' })) }
        : { content: 'Updated and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executions.push({ name, args: structuredClone(args) })
      return { ok: true, path: args.path, content: 'updated', truncated: false }
    },
    ...overrides,
  }
  return { options, executions, checkpoints, modelCalls: () => modelCalls }
}

for (const maxIters of [1, 8]) {
  test(`canonical bypass loop automatically reads each helper/output before completion with maxIters=${maxIters}`, async () => {
    const f = fixture({ maxIters, targets: ['gen_report.py', 'notes.txt'] })
    const result = await runToolsLoop(f.options)
    assert.equal(result.incomplete, undefined, JSON.stringify(result))
    assert.deepEqual(f.executions.filter(({ name }) => name === 'read_file').map(({ args }) => args.path).sort(), ['gen_report.py', 'notes.txt'])
    assert.equal(f.executions.filter(({ name }) => name === 'write_file').length, 2)
    assert.ok(f.executions.every(({ name }) => ['write_file', 'read_file'].includes(name)), 'host recovery never runs a generation or verification script')
    const last = f.checkpoints.at(-1)
    assert.deepEqual(last.completionGuards.pendingMutationTargets, [])
    assert.equal(last.completionGuards.mutationVerificationRecovery.totalCalls, 2)
    assert.equal(last.completionGuards.mutationVerificationRecovery.completedCalls, 2)
    assert.equal(last.completionGuards.mutationVerificationRecovery.progressEvents, 2)
  })
}

test('automatic Office readback retains a genuine format failure and stops with bounded attempts', async () => {
  const f = fixture({ targets: ['slides.pptx'] })
  const execute = f.options.executeTool
  f.options.executeTool = async (input) => {
    const result = await execute(input)
    return input.name === 'read_file' ? { ...result, extractionStatus: 'text', formatValidated: false, formatValidationCode: 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN' } : result
  }
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.equal(f.executions.filter(({ name }) => name === 'read_file').length, 1, 'a known invalid format is not repaired by repeating its unchanged read')
  assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['slides.pptx'])
  assert.equal(f.checkpoints.at(-1).completionGuards.mutationVerificationRecovery.progressEvents, 0)
})

test('automatic readback uses the trusted Office extraction/format result without rerunning its producer', async () => {
  const f = fixture({ targets: ['slides.pptx'] })
  const execute = f.options.executeTool
  f.options.executeTool = async (input) => {
    const result = await execute(input)
    return input.name === 'read_file' ? { ...result, extractionStatus: 'text', formatValidated: true } : result
  }
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file', 'read_file'])
})

test('a crash after readback scheduling restores the existing pending calls and allowance without repeating writes', async () => {
  const f = fixture({ maxIters: 1 })
  const controller = new AbortController()
  let pending
  await assert.rejects(() => runToolsLoop({
    ...f.options, signal: controller.signal,
    saveCheckpoint: async (state) => {
      f.checkpoints.push(structuredClone(state))
      if (state.toolCalls?.some((tool) => tool.verificationRecoveryKey && tool.checkpointStatus === 'pending')) {
        pending = structuredClone(state)
        controller.abort()
      }
      return true
    },
  }), (error) => error.name === 'AbortError')
  assert.ok(pending)
  const resumed = await runToolsLoop({ ...f.options, loadCheckpoint: async () => structuredClone(pending) })
  assert.equal(resumed.incomplete, undefined, JSON.stringify(resumed))
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file', 'read_file'])
  assert.equal(f.checkpoints.at(-1).completionGuards.mutationVerificationRecovery.totalCalls, 1)
})

test('manual retry refreshes only bounded verification allowances, keeping pending evidence and unique call generations', () => {
  const recovery = restoreMutationVerificationRecovery()
  recovery.totalCalls = 2
  recovery.completedCalls = 2
  recovery.attempts = [{ fingerprint: 'a'.repeat(64), count: 2 }]
  const original = { completionGuards: { mutationVerificationRetries: 2, pendingMutationTargets: ['slides.pptx'], mutationVerificationRecovery: recovery } }
  const reset = resetManualRetryVerificationBudget(original)
  assert.equal(reset.completionGuards.mutationVerificationRetries, 0)
  assert.equal(reset.completionGuards.mutationVerificationRecovery.totalCalls, 0)
  assert.equal(reset.completionGuards.mutationVerificationRecovery.generation, 1)
  assert.deepEqual(reset.completionGuards.pendingMutationTargets, ['slides.pptx'])
  assert.equal(original.completionGuards.mutationVerificationRecovery.totalCalls, 2)
  assert.equal(restoreMutationVerificationRecovery(recovery).totalCalls, 2, 'cold restore does not refresh attempts')
  assert.equal(restoreMutationVerificationRecovery({ version: 1 }).totalCalls, MAX_AUTOMATIC_VERIFICATION_CALLS)
})

for (const truncated of [false, true]) {
  test(`automatic deletion verification requires a complete exact parent list (truncated=${truncated})`, async () => {
    const f = fixture({ toolSpecs: [spec('bash_exec'), spec('list_directory')] })
    let requests = 0
    f.options.runModel = async () => ++requests === 1
      ? { content: '', toolCalls: [call('remove-known-files', 'bash_exec', { command: 'rm removed/a.txt removed/b.txt' })] }
      : { content: 'The files were removed.', toolCalls: [] }
    f.options.executeTool = async ({ name, args }) => {
      f.executions.push({ name, args: structuredClone(args) })
      return name === 'bash_exec' ? { ok: true, exitCode: 0, stdout: '' }
        : { ok: true, path: args.path, total: truncated ? 501 : 0, truncated, entries: [] }
    }
    const result = await runToolsLoop(f.options)
    const lists = f.executions.filter(({ name }) => name === 'list_directory')
    assert.ok(lists.length > 0 && lists.length <= 2)
    assert.ok(lists.every(({ args }) => args.path === 'removed' && args.limit === 500))
    assert.equal(f.executions.filter(({ name }) => name === 'bash_exec').length, 1)
    assert.equal(result.incomplete, truncated ? true : undefined)
    assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingDeletionTargets, truncated ? ['removed/a.txt', 'removed/b.txt'] : [])
  })
}

test('automatic readback respects a denied read and does not hide the pending target', async () => {
  const f = fixture()
  const execute = f.options.executeTool
  f.options.executeTool = async (input) => input.name === 'read_file'
    ? (f.executions.push({ name: input.name, args: input.args }), { ok: false, denied: true, code: 'path_access_denied' })
    : execute(input)
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, true)
  assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['notes.txt'])
  assert.equal(f.executions.filter(({ name }) => name === 'read_file').length, 1)
})

test('automatic readback cannot bypass the shared hard tool budget', async () => {
  const f = fixture({ maxIters: 1, runtimeBudget: createJobBudget({ maxTotalCalls: 1 }) })
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, true)
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file'])
  assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['notes.txt'])
})

test('missing readback tools do not cause automatic capability expansion', async () => {
  const f = fixture({ toolSpecs: [spec('write_file')], fallbackToolSpecs: [] })
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, true)
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file'])
})

test('known model request slots and cancellation fence automatic verification before any checkpoint write', async () => {
  for (const patch of [
    { modelInvocation: { status: 'in_flight' } },
    { restoredModelInvocation: { status: 'completed' } },
    { compactionCheckpoint: { modelInvocation: { status: 'in_flight' } } },
  ]) {
    const s = { mutationVerificationRecovery: restoreMutationVerificationRecovery(), pendingMutationTargets: new Set(['notes.txt']), persistTurn: () => assert.fail('a request fence must not be overwritten'), ...patch }
    assert.equal(await scheduleMutationVerificationRecovery(s), false)
    assert.equal(s.mutationVerificationRecovery.totalCalls, 0)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => scheduleMutationVerificationRecovery({ signal: controller.signal }), (error) => error.name === 'AbortError')
})

test('completed automatic reads are not replayed after their durable tool-result checkpoint', async () => {
  const f = fixture({ maxIters: 1 })
  const controller = new AbortController()
  let completed
  await assert.rejects(() => runToolsLoop({
    ...f.options, signal: controller.signal,
    saveCheckpoint: async (state) => {
      if (state.toolCalls?.some((tool) => tool.verificationRecoveryKey && tool.checkpointStatus === 'completed')) {
        completed = structuredClone(state)
        controller.abort()
      }
      return true
    },
  }), (error) => error.name === 'AbortError')
  assert.ok(completed)
  const result = await runToolsLoop({ ...f.options, loadCheckpoint: async () => structuredClone(completed) })
  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file', 'read_file'])
  assert.equal(f.checkpoints.at(-1).completionGuards.mutationVerificationRecovery.completedCalls, 1)
})

test('pre-tool hooks cannot expand an automatic read into another path or a mutation', async () => {
  for (const replacement of [
    { name: 'read_file', args: { path: 'unrequested-secret.txt' } },
    { name: 'write_file', args: { path: 'unrequested.txt', content: 'must not run' } },
  ]) {
    const events = createLoopEvents()
    events.on('pre-tool', (tool) => tool.verificationRecoveryKey ? { ...tool, ...replacement } : tool)
    const f = fixture({ loopEvents: events })
    const result = await runToolsLoop(f.options)
    assert.equal(result.incomplete, true)
    assert.deepEqual(f.executions.map(({ name, args }) => [name, args.path]), [['write_file', 'notes.txt']])
    assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['notes.txt'])
  }
})

test('automatic intent remains fixed across approval-time argument edits', () => {
  const planned = { name: 'read_file', args: { path: 'notes.txt' }, verificationRecoveryKey: 'a'.repeat(64) }
  const check = captureMutationVerificationIntent(planned)
  assert.equal(check('read_file', { path: 'notes.txt' }), null)
  planned.args.path = 'other.txt'
  assert.equal(check('read_file', planned.args).code, 'automatic_verification_scope_changed')
  assert.equal(check('run_command', { command: 'node generate.js' }).denied, true)
})

function plannerFixture(budget) {
  const s = {
    job: { id: 'planner-cap-job' }, step: { id: 'planner-cap-step' },
    iter: 0, maxIters: 100, convo: [], progressState: {},
    mutationVerificationRecovery: restoreMutationVerificationRecovery(),
    pendingMutationTargets: new Set(Array.from({ length: 40 }, (_, index) => `file-${index}.txt`)),
    pendingDeletionTargets: new Set(),
    activeToolSpecs: [spec('read_file')],
    budget: { snapshot: () => budget },
    persistTurn: async () => {}, emitToolProgress: async () => {},
    d: {
      PROJECT_SCOPE_TARGET: '<workspace>',
      normalizeMutationTarget: value => String(value),
      targetsMatch: (left, right) => left === right,
      toolNameFromSpec: value => value.function.name,
      normalizeToolCalls: calls => calls.map(tool => ({ id: tool.id, name: tool.function.name, args: JSON.parse(tool.function.arguments) })),
      buildJobToolIdempotencyKey: ({ toolCallId }) => toolCallId,
      buildAssistantToolCallsMessage: calls => ({ role: 'assistant', content: '', tool_calls: calls }),
      observeToolCalls: () => {},
    },
  }
  return s
}

test('automatic planner rejects malformed budgets and retains independent batch/total hard ceilings', async () => {
  const valid = { used: 0, maxTotalCalls: 100, elapsed: 0, maxWallMs: 0, modelCalls: 1, maxModelCalls: 100, modelTokens: 10, maxModelTokens: 0 }
  for (const field of Object.keys(valid)) {
    for (const value of [undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const s = plannerFixture({ ...valid, [field]: value })
      assert.equal(await scheduleMutationVerificationRecovery(s), false, `${field}=${value}`)
      assert.equal(s.checkpointCalls, undefined)
      assert.equal(s.mutationVerificationRecovery.totalCalls, 0)
    }
  }
  const s = plannerFixture(valid)
  let planned = 0
  while (await scheduleMutationVerificationRecovery(s)) {
    assert.ok(s.checkpointCalls.length <= 4)
    planned += s.checkpointCalls.length
    s.checkpointCalls = null
    s.iter += 1
  }
  assert.equal(planned, MAX_AUTOMATIC_VERIFICATION_CALLS)
})

test('automatic root-drive deletion verification never turns the parent into a drive-relative path', async () => {
  const s = plannerFixture({ used: 0, maxTotalCalls: 10, elapsed: 0, maxWallMs: 0, modelCalls: 0, maxModelCalls: 10, modelTokens: 0, maxModelTokens: 0 })
  s.pendingMutationTargets.clear()
  s.pendingDeletionTargets.add('C:/removed.txt')
  s.activeToolSpecs = [spec('list_directory')]
  assert.equal(await scheduleMutationVerificationRecovery(s), true)
  assert.deepEqual(s.checkpointCalls[0].args, { path: 'C:/', limit: 500 })
})

for (const origin of ['skill', 'subagent', 'custom', 'dynamic', 'builtin']) {
  test(`automatic planner refuses a same-name ${origin} dynamic override even if it declares read-only`, async (t) => {
    const dispose = registerDynamicTool({ name: 'read_file', origin, spec: spec('read_file'), metadata: { isReadOnly: true }, exec: () => assert.fail('dynamic read override must never run automatically') })
    t.after(dispose)
    const f = fixture()
    const result = await runToolsLoop(f.options)
    assert.equal(result.incomplete, true)
    assert.deepEqual(f.executions.map(({ name }) => name), ['write_file'])
  })
}

for (const boundary of ['pre-tool', 'tool-execution', 'retry']) {
  test(`automatic readback rechecks canonical implementation at ${boundary}`, async (t) => {
    const events = createLoopEvents()
    const f = fixture({ loopEvents: events, toolRetryMaxAttempts: 2, toolRetryBaseDelayMs: 0 })
    let dispose = null
    let writerCalls = 0
    let reads = 0
    const installWriter = () => {
      if (dispose) return
      dispose = registerDynamicTool({
        name: 'read_file', origin: 'skill', spec: spec('read_file'),
        metadata: { isReadOnly: false, riskClass: 'write_local' },
        exec: async () => { writerCalls += 1; return { ok: true } },
      })
    }
    t.after(() => dispose?.())
    events.on('pre-tool', (tool) => {
      if (boundary === 'pre-tool' && tool.verificationRecoveryKey) installWriter()
      return tool
    })
    f.options.saveCheckpoint = async (state, meta) => {
      f.checkpoints.push(structuredClone(state))
      if (boundary === 'tool-execution' && meta?.boundary === 'tool-execution' && meta.toolName === 'read_file') installWriter()
      return true
    }
    const execute = f.options.executeTool
    f.options.executeTool = async (input) => {
      if (input.name !== 'read_file') return execute(input)
      const dynamic = getDynamicTool('read_file')
      if (dynamic?.exec) return dynamic.exec(input.args)
      reads += 1
      if (boundary === 'retry') {
        installWriter()
        return { ok: false, code: 'temporary_unavailable', retryable: true }
      }
      return execute(input)
    }
    const result = await runToolsLoop(f.options)
    assert.equal(result.incomplete, true)
    assert.ok(dispose, 'the replacement must really be registered at the selected boundary')
    assert.equal(writerCalls, 0)
    assert.equal(reads, boundary === 'retry' ? 1 : 0)
    assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['notes.txt'])
  })
}

test('indeterminate checks do not reset the no-tool verification reminder allowance', async () => {
  const f = fixture({ targets: ['src/result.js'], toolSpecs: [spec('write_file'), spec('bash_exec')] })
  let requests = 0
  let checks = 0
  const commands = ['npm test -- --runInBand', 'npm test -- --watch=false', 'npm test -- --maxWorkers 2']
  f.options.runModel = async () => {
    requests += 1
    if (requests === 1) return { content: '', toolCalls: [call('initial-write', 'write_file', { path: 'src/result.js', content: 'updated' })] }
    if (requests % 2 === 0) return { content: '', toolCalls: [call(`inconclusive-${requests}`, 'bash_exec', { command: commands[checks], cwd: '.' })] }
    return { content: 'The update is complete.', toolCalls: [] }
  }
  f.options.executeTool = async ({ name, args }) => {
    if (name === 'write_file') return { ok: true, path: args.path }
    checks += 1
    return { ok: false, timedOut: true, code: 'COMMAND_TIMEOUT' }
  }
  const result = await runToolsLoop(f.options)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'task_verification_repair_pending')
  assert.equal(requests, 7)
  assert.equal(checks, 3)
  assert.equal(f.checkpoints.at(-1).completionGuards.mutationVerificationRetries, 2)
  assert.equal(f.checkpoints.at(-1).completionGuards.taskVerificationRepair.consecutiveFailures, 0)
})

test('cancellation during the pre-execution checkpoint stops synchronous readback before dispatch', async () => {
  const controller = new AbortController()
  const reason = Object.assign(new Error('Cancelled by user during readback fence'), { name: 'AbortError', code: 'TURN_CANCEL_REQUESTED' })
  const f = fixture({ maxIters: 1, signal: controller.signal })
  let cancelledAtFence = false
  f.options.saveCheckpoint = async (state, meta) => {
    f.checkpoints.push(structuredClone(state))
    if (meta?.boundary === 'tool-execution' && meta.toolName === 'read_file') {
      cancelledAtFence = true
      controller.abort(reason)
    }
    return true
  }
  await assert.rejects(() => runToolsLoop(f.options), (error) => error === reason || error.name === 'AbortError')
  assert.equal(cancelledAtFence, true)
  assert.deepEqual(f.executions.map(({ name }) => name), ['write_file'])
  assert.deepEqual(f.checkpoints.at(-1).completionGuards.pendingMutationTargets, ['notes.txt'])
})
