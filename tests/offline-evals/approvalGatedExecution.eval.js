import assert from 'node:assert/strict'

import { runToolsLoop, SERVER_TOOL_SPECS } from '../../server/services/jobTools.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const EVAL_USER_ID = 'offline-approval-gated-execution-user'

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
    'APPROVAL-01',
    'denied-mutation',
    'a denied write never executes and asks for user direction instead of a verification',
    async () => {
      let modelCalls = 0
      const executions = []
      const result = await runScenario({
        job: {
          id: 'offline-approval-denied-write',
          prompt: 'Write src/result.js.',
        },
        step: { id: 'offline-approval-denied-write-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'Write src/result.js.' }],
        intentMode: 'execute',
        maxIters: 10,
        toolSpecs: [spec('write_file'), spec('run_project_check')],
        requestToolApproval: async () => ({
          proceed: false,
          reason: 'The user declined this write.',
        }),
        runModel: async () => {
          modelCalls += 1
          return toolCall('denied-write', 'write_file', {
            path: 'src/result.js',
            content: 'export const result = 1\n',
          })
        },
        executeTool: async ({ name, args }) => {
          executions.push({ name, args: structuredClone(args) })
          return { ok: true }
        },
      })

      assert.deepEqual(executions, [], 'a denied tool call must not reach the executor')
      assert.equal(modelCalls, 1, 'a denial stops the turn and waits for the user')
      assert.equal(result.incomplete, true)
      assert.equal(result.reason, 'approval_denied')
      assert.deepEqual(
        result.missingRequirements,
        ['user_direction'],
        'a denial waits for the user, it does not demand a verification of nothing',
      )
    },
  ),
  task(
    'APPROVAL-02',
    'parameter-edited-approval',
    'an approval that edits the arguments executes exactly the approved arguments',
    async () => {
      let modelCalls = 0
      const executions = []
      const approvalArgs = []
      await runScenario({
        job: {
          id: 'offline-approval-edited-args',
          prompt: 'Write src/result.js.',
        },
        step: { id: 'offline-approval-edited-args-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'Write src/result.js.' }],
        intentMode: 'execute',
        maxIters: 10,
        toolSpecs: [spec('write_file')],
        requestToolApproval: async ({ toolName, args }) => {
          approvalArgs.push({ toolName, args: structuredClone(args) })
          return {
            proceed: true,
            approvalId: 'offline-approved-with-edits',
            edited: true,
            args: { ...args, content: 'export const result = 2\n' },
          }
        },
        runModel: async () => {
          modelCalls += 1
          return modelCalls === 1
            ? toolCall('edited-write', 'write_file', {
              path: 'src/result.js',
              content: 'export const result = 1\n',
            })
            : { content: 'Written.', toolCalls: [] }
        },
        executeTool: async ({ name, args }) => {
          executions.push({ name, args: structuredClone(args) })
          return { ok: true, path: args.path }
        },
      })

      assert.equal(approvalArgs.length, 1)
      assert.equal(approvalArgs[0].toolName, 'write_file')
      assert.equal(approvalArgs[0].args.content, 'export const result = 1\n')
      assert.equal(executions.length, 1)
      assert.equal(
        executions[0].args.content,
        'export const result = 2\n',
        'the executor must receive the approved arguments, not the requested ones',
      )
    },
  ),
  task(
    'APPROVAL-03',
    'denied-verification',
    'a denied verification never runs and the turn reports the completed write as unverified',
    async () => {
      let modelCalls = 0
      const executions = []
      const result = await runScenario({
        job: {
          id: 'offline-approval-denied-verification',
          prompt: 'Write src/result.js and run the tests.',
        },
        step: { id: 'offline-approval-denied-verification-step', kind: 'chat' },
        messages: [{ role: 'user', content: 'Write src/result.js and run the tests.' }],
        intentMode: 'execute',
        maxIters: 10,
        toolSpecs: [spec('write_file'), spec('run_project_check')],
        requestToolApproval: async ({ toolName }) => (toolName === 'run_project_check'
          ? { proceed: false, reason: 'The user declined to run the project check.' }
          : { proceed: true, approvalId: 'offline-approval-write-approved' }),
        runModel: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            return toolCall('verify-denied-write', 'write_file', {
              path: 'src/result.js',
              content: 'export const result = 1\n',
            })
          }
          if (modelCalls === 2) {
            return toolCall('verify-denied-check', 'run_project_check', { check: 'test' })
          }
          return { content: 'The file was written and the tests pass.', toolCalls: [] }
        },
        executeTool: async ({ name, args }) => {
          executions.push({ name, args: structuredClone(args) })
          if (name === 'write_file') return { ok: true, path: 'src/result.js' }
          return { ok: true, check: 'test', exitCode: 0, stdout: '1 test passed' }
        },
      })

      assert.deepEqual(
        executions.map(({ name }) => name),
        ['write_file'],
        'a denied verification must not execute',
      )
      assert.equal(result.incomplete, true)
      assert.equal(result.reason, 'approval_denied')
      assert.equal(modelCalls, 2)
      // The already-executed write is reported, so the user can see what stands.
      assert.match(result.text || '', /src\/result\.js/u)
      assert.doesNotMatch(result.text || '', /tests pass/u)
    },
  ),
]

assert.equal(TASKS.length, 3)

export default defineOfflineEvalSuite({
  id: 'approval-gated-execution',
  title: 'Approval decisions gate execution and post-mutation verification',
  version: 1,
  cases: TASKS,
})
