import assert from 'node:assert/strict'

import { runToolsLoop, SERVER_TOOL_SPECS } from '../../server/services/jobTools.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const EVAL_USER_ID = 'offline-task-verification-repair-user'

function spec(name) {
  const found = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(found, `offline eval fixture is missing server tool: ${name}`)
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

function runScenario(options = {}) {
  return runToolsLoop({
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'offline-task-verification-repair-approved',
    }),
    enableToolHooks: false,
    toolRetryBaseDelayMs: 0,
    ...options,
    job: {
      origin: 'chat',
      ...options.job,
      userId: EVAL_USER_ID,
    },
  })
}

function task(id, category, title, run) {
  return defineOfflineEvalCase({ id, category, title, run })
}

const TASKS = [
  task(
    'REPAIR-01',
    'repair-convergence',
    'a failed post-mutation test blocks an early answer and converges only after repair and revalidation',
    async () => {
      let modelCalls = 0
      let checkCalls = 0
      const executions = []
      const result = await runScenario({
        job: {
          id: 'offline-repair-convergence',
          prompt: 'Fix src/result.js and make the tests pass.',
        },
        step: { id: 'offline-repair-convergence-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'Fix src/result.js and make the tests pass.' }],
        intentMode: 'execute',
        maxIters: 10,
        toolSpecs: [spec('write_file'), spec('edit_file'), spec('run_project_check')],
        runModel: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            return toolCall('repair-write', 'write_file', {
              path: 'src/result.js',
              content: 'export const result = 1\n',
            })
          }
          if (modelCalls === 2) {
            return toolCall('repair-test-fail', 'run_project_check', { check: 'test' })
          }
          if (modelCalls === 3) return { content: 'Done.', toolCalls: [] }
          if (modelCalls === 4) {
            return toolCall('repair-edit', 'edit_file', {
              path: 'src/result.js',
              old_string: 'result = 1',
              new_string: 'result = 2',
            })
          }
          if (modelCalls === 5) {
            return toolCall('repair-test-pass', 'run_project_check', { check: 'test' })
          }
          return { content: 'The implementation was corrected and the tests pass.', toolCalls: [] }
        },
        executeTool: async ({ name, args }) => {
          executions.push({ name, args: structuredClone(args) })
          if (name === 'write_file' || name === 'edit_file') {
            return { ok: true, path: 'src/result.js' }
          }
          checkCalls += 1
          return checkCalls === 1
            ? { ok: false, check: 'test', exitCode: 1, stderr: 'expected 2, received 1' }
            : { ok: true, check: 'test', exitCode: 0, stdout: '1 test passed' }
        },
      })

      assert.equal(modelCalls, 6)
      assert.equal(checkCalls, 2)
      assert.deepEqual(executions.map(({ name }) => name), [
        'write_file',
        'run_project_check',
        'edit_file',
        'run_project_check',
      ])
      assert.equal(result.incomplete, undefined)
      assert.equal(result.text, 'The implementation was corrected and the tests pass.')
    },
  ),
  task(
    'REPAIR-02',
    'retry-boundary',
    'changing harmless verification parameters cannot evade the three-failure task limit',
    async () => {
      const commands = [
        'npm test -- --runInBand',
        'npm test -- --watch=false',
        'npm test -- src/result.test.js',
      ]
      let modelCalls = 0
      let checkCalls = 0
      let editCalls = 0
      let checkpoint = null
      const result = await runScenario({
        job: {
          id: 'offline-repair-exhaustion',
          prompt: 'Fix src/result.js and make the tests pass.',
        },
        step: { id: 'offline-repair-exhaustion-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'Fix src/result.js and make the tests pass.' }],
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
            return toolCall('boundary-write', 'write_file', {
              path: 'src/result.js',
              content: 'export const result = 1\n',
            })
          }
          if (modelCalls === 3 || modelCalls === 5) {
            const previous = modelCalls === 3 ? '1' : '2'
            const next = modelCalls === 3 ? '2' : '3'
            return toolCall(`boundary-edit-${modelCalls}`, 'edit_file', {
              path: 'src/result.js',
              old_string: `result = ${previous}`,
              new_string: `result = ${next}`,
            })
          }
          return toolCall(`boundary-check-${modelCalls}`, 'bash_exec', {
            command: commands[checkCalls],
            cwd: '.',
          })
        },
        executeTool: async ({ name, args }) => {
          if (name === 'write_file') return { ok: true, path: 'src/result.js' }
          if (name === 'edit_file') {
            editCalls += 1
            return { ok: true, path: 'src/result.js', replacedCount: 1 }
          }
          assert.equal(args.command, commands[checkCalls])
          checkCalls += 1
          return { ok: false, exitCode: 1, stderr: 'expected 2, received 1' }
        },
      })

      assert.equal(modelCalls, 6)
      assert.equal(editCalls, 2)
      assert.equal(checkCalls, 3)
      assert.equal(result.incomplete, true)
      assert.equal(result.reason, 'task_verification_repair_exhausted')
      assert.equal(checkpoint?.completionGuards?.taskVerificationRepair?.consecutiveFailures, 3)
      assert.deepEqual(
        checkpoint?.completionGuards?.taskVerificationRepair?.pending?.map(({ failures }) => failures),
        [1, 1, 1],
      )
    },
  ),
  task(
    'REPAIR-03',
    'checkpoint-recovery',
    'a recovered checkpoint preserves repair debt without replaying completed verification tools',
    async () => {
      const job = {
        id: 'offline-repair-checkpoint',
        prompt: 'Fix src/result.js and make the tests pass.',
      }
      const step = { id: 'offline-repair-checkpoint-step', kind: 'chat' }
      const toolSpecs = [spec('write_file'), spec('edit_file'), spec('run_project_check')]
      let resumeState = null
      let firstModelCalls = 0
      let firstCheckCalls = 0

      await runScenario({
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
            && state.toolCalls?.length === 0
            && state.completionGuards?.taskVerificationRepair?.consecutiveFailures === 1) {
            resumeState = structuredClone(state)
          }
          return true
        },
        runModel: async () => {
          firstModelCalls += 1
          if (firstModelCalls === 1) {
            return toolCall('checkpoint-write', 'write_file', {
              path: 'src/result.js',
              content: 'export const result = 1\n',
            })
          }
          if (firstModelCalls === 2 || firstModelCalls === 4) {
            return toolCall(`checkpoint-check-${firstModelCalls}`, 'run_project_check', { check: 'test' })
          }
          if (firstModelCalls === 3) {
            return toolCall('checkpoint-edit', 'edit_file', {
              path: 'src/result.js',
              old_string: 'result = 1',
              new_string: 'result = 2',
            })
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
            : { ok: true, check: 'test', exitCode: 0 }
        },
      })

      assert.ok(resumeState)
      assert.equal(firstCheckCalls, 2)

      let secondModelCalls = 0
      let secondCheckCalls = 0
      let secondEditCalls = 0
      const result = await runScenario({
        job,
        step,
        messages: [],
        loadCheckpoint: async () => ({ state: structuredClone(resumeState) }),
        intentMode: 'execute',
        maxIters: 10,
        toolSpecs,
        runModel: async () => {
          secondModelCalls += 1
          if (secondModelCalls === 1 || secondModelCalls === 3) {
            const previous = secondModelCalls === 1 ? '1' : '2'
            const next = secondModelCalls === 1 ? '2' : '3'
            return toolCall(`resumed-edit-${secondModelCalls}`, 'edit_file', {
              path: 'src/result.js',
              old_string: `result = ${previous}`,
              new_string: `result = ${next}`,
            })
          }
          return toolCall(`resumed-check-${secondModelCalls}`, 'run_project_check', { check: 'test' })
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
      assert.equal(result.incomplete, true)
      assert.equal(result.reason, 'task_verification_repair_exhausted')
    },
  ),
]

assert.equal(TASKS.length, 3)

export default defineOfflineEvalSuite({
  id: 'task-verification-repair',
  title: 'Post-mutation verification feedback and bounded repair',
  version: 1,
  cases: TASKS,
})
