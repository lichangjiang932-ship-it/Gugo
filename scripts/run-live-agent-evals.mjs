#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_TASKS = 100
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_WORKSPACE_ENTRIES = 100_000
const MODES = new Set(['normal', 'acceptEdits', 'plan', 'bypass'])

function inputError(message) {
  return Object.assign(new Error(message), { code: 'LIVE_EVAL_INPUT_INVALID' })
}

function parseArgs(argv) {
  const result = { dataset: '', output: '', keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index])
    if (value === '--keep') { result.keep = true; continue }
    if (!['--dataset', '--output'].includes(value)) throw inputError(`Unknown option: ${value}`)
    const next = String(argv[++index] || '').trim()
    if (!next) throw inputError(`${value} requires a path`)
    result[value.slice(2)] = next
  }
  if (!result.dataset) throw inputError('--dataset is required')
  return result
}

function boundedText(value) {
  const text = String(value || '')
  return text.length <= MAX_CAPTURE_BYTES ? text : `${text.slice(0, MAX_CAPTURE_BYTES)}\n[output truncated]`
}

function normalizeVerifier(value, taskId, datasetDirectory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError(`${taskId}: every verifier must be an object`)
  }
  const scriptValue = typeof value.script === 'string' ? value.script.trim() : ''
  const script = scriptValue ? path.resolve(datasetDirectory, scriptValue) : ''
  const command = script ? process.execPath : String(value.command || '').trim()
  const declaredArgs = Array.isArray(value.args) ? value.args.map((item) => String(item)) : []
  const args = script ? [script, ...declaredArgs] : declaredArgs
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : ''
  const normalizedCwd = cwd ? path.normalize(cwd) : ''
  const escapesWorkspace = normalizedCwd === '..' || normalizedCwd.startsWith(`..${path.sep}`)
  if (!command || args.length > 128 || path.isAbsolute(cwd) || escapesWorkspace
    || (script && !isInside(datasetDirectory, script))) {
    throw inputError(`${taskId}: invalid verifier command, script, or cwd`)
  }
  return { command, args, cwd: normalizedCwd, ...(script ? { script } : {}) }
}

function normalizeTask(value, datasetDirectory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('Every task must be an object')
  const id = String(value.id || '').trim()
  const prompt = String(value.prompt || '').trim()
  const source = path.resolve(datasetDirectory, String(value.workspace || '').trim())
  const mode = String(value.mode || 'bypass').trim()
  const timeoutMs = Number(value.timeoutMs || 20 * 60 * 1000)
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(id)) throw inputError(`Invalid task id: ${id || '<empty>'}`)
  if (!prompt || prompt.length > 200_000) throw inputError(`${id}: prompt is missing or too large`)
  if (!String(value.workspace || '').trim()) throw inputError(`${id}: workspace is required`)
  if (!MODES.has(mode)) throw inputError(`${id}: unsupported mode ${mode}`)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 6 * 60 * 60 * 1000) {
    throw inputError(`${id}: timeoutMs must be between 1000 and 21600000`)
  }
  return {
    id, prompt, source, mode, timeoutMs,
    verifiers: (Array.isArray(value.verify) ? value.verify : [])
      .map((item) => normalizeVerifier(item, id, datasetDirectory)),
  }
}

export async function loadLiveEvalDataset(datasetPath) {
  const resolved = path.resolve(datasetPath)
  const parsed = JSON.parse(await fs.readFile(resolved, 'utf8'))
  const values = Array.isArray(parsed) ? parsed : parsed?.tasks
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_TASKS) {
    throw inputError(`Dataset must contain 1-${MAX_TASKS} tasks`)
  }
  const tasks = values.map((value) => normalizeTask(value, path.dirname(resolved)))
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw inputError('Task ids must be unique')
  for (const task of tasks) {
    const stat = await fs.stat(task.source).catch(() => null)
    if (!stat?.isDirectory()) throw inputError(`${task.id}: workspace is not a directory`)
    for (const verifier of task.verifiers) {
      if (!verifier.script) continue
      const scriptStat = await fs.lstat(verifier.script).catch(() => null)
      if (!scriptStat?.isFile() || scriptStat.isSymbolicLink()) {
        throw inputError(`${task.id}: verifier script must be a regular non-symlink file`)
      }
    }
  }
  return { path: resolved, tasks }
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))
}

async function assertWorkspaceCopySafe(root) {
  const pending = [root]
  let visited = 0
  while (pending.length) {
    const current = pending.pop()
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_WORKSPACE_ENTRIES) throw inputError('Workspace fixture is too large')
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw inputError(`Workspace fixture contains a symbolic link: ${target}`)
      if (entry.isDirectory()) pending.push(target)
    }
  }
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const append = (current, chunk) => boundedText(current + String(chunk))
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: error.message })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, error: null })
    })
  })
}

function jsonlEvents(stdout) {
  const events = []
  for (const line of String(stdout || '').split(/\r?\n/u).slice(0, 100_000)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event)
    } catch { /* diagnostics stay in the captured output */ }
  }
  return events
}

function terminalEvent(events) {
  let terminal = null
  for (const event of events) {
    if (/^turn\.(?:completed|failed|cancelled|paused|blocked|interrupted)$/u.test(String(event?.type || ''))) terminal = event
  }
  return terminal
}

function evaluationMetrics(events, terminal, verifications) {
  const started = events.find((event) => event?.type === 'turn.started')?.payload || {}
  const toolEvents = events.filter((event) => event?.type === 'tool.call')
  const toolNames = [...new Set(toolEvents.map((event) => String(event?.payload?.name || '').trim()).filter(Boolean))].sort()
  const verifierFailed = verifications.some((verification) => verification.passed !== true)
  return {
    modelName: started.modelName || started.model || null,
    modelProviderId: started.modelProviderId || null,
    approvalMode: started.approvalMode || null,
    modelRequests: events.filter((event) => event?.type === 'model.phase' && event?.payload?.phase === 'completed').length,
    modelFailures: events.filter((event) => event?.type === 'model.phase' && event?.payload?.phase === 'failed').length,
    modelFailovers: events.filter((event) => event?.type === 'model.failover').length,
    toolCalls: toolEvents.length,
    toolNames,
    approvalRequests: events.filter((event) => event?.type === 'approval.required').length,
    turnAttempts: events.filter((event) => event?.type === 'turn.attempt').length,
    usage: terminal?.payload?.turnModelUsage || terminal?.payload?.usage || null,
    falseCompletion: terminal?.type === 'turn.completed' && verifierFailed,
  }
}

export async function runLiveEvaluation({
  datasetPath,
  outputPath = '',
  keep = false,
  env = process.env,
  cliPath = fileURLToPath(new URL('../bin/yma-cli.js', import.meta.url)),
  processCommand = process.execPath,
} = {}) {
  if (String(env.GUGO_LIVE_EVAL || '') !== '1') {
    throw Object.assign(new Error('Set GUGO_LIVE_EVAL=1 to authorize real model evaluation.'), { code: 'LIVE_EVAL_NOT_AUTHORIZED' })
  }
  const dataset = await loadLiveEvalDataset(datasetPath)
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-live-eval-'))
  const cli = path.resolve(cliPath)
  const results = []
  try {
    for (const task of dataset.tasks) {
      const workspace = path.join(runRoot, task.id, 'workspace')
      const dataRoot = path.join(runRoot, task.id, 'data')
      await fs.mkdir(path.dirname(workspace), { recursive: true })
      await assertWorkspaceCopySafe(task.source)
      await fs.cp(task.source, workspace, { recursive: true, force: false, errorOnExist: true })
      await fs.mkdir(dataRoot, { recursive: true })
      const startedAt = Date.now()
      const execution = await runProcess(processCommand, [
        cli, 'run', '--cwd', workspace, '--mode', task.mode,
        '--timeout', String(task.timeoutMs), '--output', 'jsonl', '--', task.prompt,
      ], {
        cwd: workspace,
        timeoutMs: task.timeoutMs + 10_000,
        env: { ...env, APP_DATA_DIR: dataRoot, GUGO_LOAD_DOTENV: '0' },
      })
      const events = jsonlEvents(execution.stdout)
      const terminal = terminalEvent(events)
      const verifications = []
      if (execution.code === 0 && terminal?.type === 'turn.completed') {
        for (const verifier of task.verifiers) {
          const cwd = verifier.cwd ? path.resolve(workspace, verifier.cwd) : workspace
          if (!isInside(workspace, cwd)) throw inputError(`${task.id}: verifier cwd escapes the copied workspace`)
          const outcome = await runProcess(verifier.command, verifier.args, { cwd, env, timeoutMs: task.timeoutMs })
          verifications.push({ ...verifier, ...outcome, passed: outcome.code === 0 && !outcome.timedOut })
          if (!verifications.at(-1).passed) break
        }
      }
      const passed = execution.code === 0 && terminal?.type === 'turn.completed'
        && verifications.length === task.verifiers.length && verifications.every((item) => item.passed)
      results.push({
        id: task.id, passed, durationMs: Date.now() - startedAt,
        terminalType: terminal?.type || null,
        execution: { code: execution.code, signal: execution.signal, timedOut: execution.timedOut,
          stdout: execution.stdout, stderr: execution.stderr, error: execution.error },
        metrics: evaluationMetrics(events, terminal, verifications),
        verifications,
        ...(keep ? { workspace } : {}),
      })
    }
    const report = {
      version: 1,
      dataset: dataset.path,
      generatedAt: new Date().toISOString(),
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      failed: results.filter((item) => !item.passed).length,
      metrics: {
        modelRequests: results.reduce((sum, item) => sum + item.metrics.modelRequests, 0),
        toolCalls: results.reduce((sum, item) => sum + item.metrics.toolCalls, 0),
        approvalRequests: results.reduce((sum, item) => sum + item.metrics.approvalRequests, 0),
        falseCompletions: results.filter((item) => item.metrics.falseCompletion).length,
      },
      results,
    }
    if (outputPath) await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    if (!keep) await fs.rm(runRoot, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = await runLiveEvaluation({
    datasetPath: args.dataset,
    outputPath: args.output,
    keep: args.keep,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.failed > 0) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[live-eval] ${error.code || 'ERROR'}: ${error.message}\n`)
    process.exitCode = 1
  })
}
