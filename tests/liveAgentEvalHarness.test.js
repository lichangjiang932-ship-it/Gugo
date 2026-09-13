import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  loadLiveEvalDataset,
  runLiveEvaluation,
} from '../scripts/run-live-agent-evals.mjs'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-live-eval-test-'))
  const workspace = path.join(root, 'fixture')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'original')
  const cli = path.join(root, 'fake-cli.mjs')
  await fs.writeFile(cli, `
import fs from 'node:fs'
const args = process.argv.slice(2)
const cwd = args[args.indexOf('--cwd') + 1]
fs.writeFileSync(new URL('result.txt', 'file:///' + cwd.replace(/\\\\/g, '/') + '/'), 'completed')
const emit = (type, payload) => process.stdout.write(JSON.stringify({ type, payload }) + '\\n')
emit('turn.started', { modelName: 'fixture-model', modelProviderId: 'fixture-provider', approvalMode: 'bypass' })
emit('model.phase', { phase: 'completed', usage: { promptTokens: 10, completionTokens: 5 } })
emit('tool.call', { toolCallId: 'fixture-call', name: 'write_file', args: { path: 'result.txt' } })
emit('tool.completed', { toolCallId: 'fixture-call', name: 'write_file', result: { ok: true } })
emit('turn.completed', { text: 'done', turnModelUsage: { promptTokens: 10, completionTokens: 5 } })
`)
  const verifier = path.join(root, 'verify.mjs')
  await fs.writeFile(verifier, `
import fs from 'node:fs'
process.exitCode = fs.readFileSync('result.txt', 'utf8') === 'completed' ? 0 : 1
`)
  const dataset = path.join(root, 'tasks.json')
  await fs.writeFile(dataset, JSON.stringify({ tasks: [{
    id: 'fixture-task',
    prompt: 'Create result.txt.',
    workspace: './fixture',
    mode: 'bypass',
    timeoutMs: 10_000,
    verify: [{ command: process.execPath, args: [verifier] }],
  }] }))
  return { root, workspace, dataset, cli, verifier }
}

test('live evals require an explicit opt-in before any task starts', async () => {
  await assert.rejects(runLiveEvaluation({ datasetPath: 'missing.json', env: {} }), {
    code: 'LIVE_EVAL_NOT_AUTHORIZED',
  })
})

test('live eval dataset validation rejects duplicate ids and escaping verifier directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-live-eval-invalid-'))
  try {
    const dataset = path.join(root, 'tasks.json')
    await fs.writeFile(dataset, JSON.stringify({ tasks: [
      { id: 'duplicate', prompt: 'one', workspace: '.' },
      { id: 'duplicate', prompt: 'two', workspace: '.' },
    ] }))
    await assert.rejects(loadLiveEvalDataset(dataset), { code: 'LIVE_EVAL_INPUT_INVALID' })
    await fs.writeFile(dataset, JSON.stringify({ tasks: [{
      id: 'escape', prompt: 'one', workspace: '.',
      verify: [{ command: process.execPath, cwd: '..' }],
    }] }))
    await assert.rejects(loadLiveEvalDataset(dataset), { code: 'LIVE_EVAL_INPUT_INVALID' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('live eval runs in an isolated workspace and requires deterministic verifier success', async () => {
  const value = await fixture()
  try {
    const report = await runLiveEvaluation({
      datasetPath: value.dataset,
      cliPath: value.cli,
      env: { ...process.env, GUGO_LIVE_EVAL: '1' },
    })
    assert.equal(report.total, 1)
    assert.equal(report.passed, 1)
    assert.equal(report.failed, 0)
    assert.equal(report.results[0].terminalType, 'turn.completed')
    assert.equal(report.results[0].verifications[0].passed, true)
    assert.deepEqual(report.metrics, {
      modelRequests: 1,
      toolCalls: 1,
      approvalRequests: 0,
      falseCompletions: 0,
    })
    assert.deepEqual(report.results[0].metrics, {
      modelName: 'fixture-model',
      modelProviderId: 'fixture-provider',
      approvalMode: 'bypass',
      modelRequests: 1,
      modelFailures: 0,
      modelFailovers: 0,
      toolCalls: 1,
      toolNames: ['write_file'],
      approvalRequests: 0,
      turnAttempts: 0,
      usage: { promptTokens: 10, completionTokens: 5 },
      falseCompletion: false,
    })
    await assert.rejects(fs.access(path.join(value.workspace, 'result.txt')))
  } finally {
    await fs.rm(value.root, { recursive: true, force: true })
  }
})

test('live eval records a false completion when the runtime completes but verification fails', async () => {
  const value = await fixture()
  try {
    await fs.writeFile(value.verifier, 'process.exitCode = 1\n')
    const report = await runLiveEvaluation({
      datasetPath: value.dataset,
      cliPath: value.cli,
      env: { ...process.env, GUGO_LIVE_EVAL: '1' },
    })
    assert.equal(report.passed, 0)
    assert.equal(report.failed, 1)
    assert.equal(report.metrics.falseCompletions, 1)
    assert.equal(report.results[0].terminalType, 'turn.completed')
    assert.equal(report.results[0].metrics.falseCompletion, true)
  } finally {
    await fs.rm(value.root, { recursive: true, force: true })
  }
})
