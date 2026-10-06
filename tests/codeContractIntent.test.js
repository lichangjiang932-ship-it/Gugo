import assert from 'node:assert/strict'
import test from 'node:test'
import { hasMutationExecutionIntent, shouldRequireExecution } from '../server/utils/executionIntent.js'
import { isExplicitReadOnlyRequest, selectChatToolSpecs } from '../server/services/chatToolSelection.js'
import { runToolLoop } from '../server/services/loop/index.js'

const prompt = 'Harden src/config.js against prototype-pollution keys while preserving ordinary own configuration values. Do not change the exported function name. Run the provided project checks.'
const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })
const specs = ['read_file', 'write_file', 'edit_file', 'apply_patch', 'run_project_check', 'search_tools'].map(tool)

test('code-interface preservation is not a whole-turn read-only request when separate implementation is requested', () => {
  for (const text of [prompt,
    'Fix src/config.js. Do not change the exported function name.',
    'Repair src/report.js while preserving its inputs. Do not change the public API.',
    '修改 src/config.js，修复合并逻辑；不要修改导出函数名。',
  ]) {
    assert.equal(hasMutationExecutionIntent(text), true, text)
    assert.equal(shouldRequireExecution({ text }), true, text)
    assert.equal(isExplicitReadOnlyRequest(text), false, text)
    const names = selectChatToolSpecs({ userPrompt: text, specs }).map((item) => item.function.name)
    for (const name of ['read_file', 'edit_file', 'run_project_check']) assert.ok(names.includes(name), `${name}: ${text}`)
  }
})

test('a preservation clause cannot remove a separate global or unrecognized read-only constraint', () => {
  for (const text of [
    `${prompt} Do not modify any files.`,
    `${prompt} Keep the entire project read-only.`,
    'Fix src/config.js. Do not change the exported function name or any files.',
    'Fix src/config.js. Do not change the exported function name. Do not edit src/config.js.',
    'Do not change the exported function name.',
    'Explain how to fix src/config.js. Do not change the exported function name.',
  ]) {
    assert.equal(isExplicitReadOnlyRequest(text), true, text)
    assert.equal(selectChatToolSpecs({ userPrompt: text, specs }).some((item) => item.function.name === 'write_file'), false, text)
  }
})

test('maintenance topics, negations and quoted examples are not affirmative implementation orders', () => {
  for (const text of [
    'How do I harden src/config.js?', 'Explain how to repair src/report.js.',
    'Do not harden src/config.js.', 'Never repair src/report.js.',
    'The docs say "Harden src/config.js".', 'Harden public API documentation?',
  ]) {
    assert.equal(shouldRequireExecution({ text }), false, text)
    assert.equal(hasMutationExecutionIntent(text), false, text)
  }
  assert.equal(shouldRequireExecution({ text: prompt, intentMode: 'answer' }), false)
  const disabled = specs.filter((item) => item.function.name !== 'write_file')
  assert.equal(selectChatToolSpecs({ userPrompt: prompt, specs: disabled }).some((item) => item.function.name === 'write_file'), false)
})

test('the real loop reaches normal approval for scoped code work and still cannot execute a refused edit', async () => {
  let approvals = 0
  let executions = 0
  let modelCalls = 0
  const completed = []
  const result = await runToolLoop({ job: { id: 'code-contract', userId: 'contract-user', origin: 'chat', prompt },
    step: { id: 'contract-step', kind: 'chat' }, messages: [{ role: 'user', content: prompt }],
    toolSpecs: specs, maxIters: 2, approvalMode: 'normal', enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      return { content: '', toolCalls: [{ id: 'contract-edit', type: 'function', function: { name: 'write_file',
        arguments: JSON.stringify({ path: 'src/config.js', content: 'export function mergeConfig() {}' }) } }] }
    },
    requestToolApproval: async () => { approvals += 1; return { proceed: false, deniedByUser: true } },
    executeTool: async () => { executions += 1; return { ok: true } },
    onToolCompleted: (outcome) => completed.push(outcome),
  })
  assert.equal(approvals, 1, 'a scoped contract should reach, not bypass or replace, the approval gate')
  assert.equal(executions, 0)
  assert.equal(modelCalls, 1)
  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'approval_denied')
  assert.equal(completed[0].result.deniedByUser, true)
})
