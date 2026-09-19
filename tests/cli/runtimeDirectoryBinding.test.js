import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CLI_PATH, NETWORK_GUARD, MODEL_NAME, isolatedEnvironment, seedProvider, modelReply } from './helpers/artifactCompletionHarness.js'

const moduleUrl = (file) => new URL(`../../${file}`, import.meta.url).href

function fixture(t, port = 1) {
  const root = mkdtempSync(path.join(tmpdir(), 'gugo-shared-runtime-'))
  const paths = Object.fromEntries(['runtime', 'workspace', 'launcher', 'data', 'artifacts', 'tokenHome', 'temp', 'output']
    .map((key) => [key, path.join(root, key)]))
  paths.config = paths.data
  paths.database = path.join(paths.data, 'app.db')
  for (const key of ['runtime', 'workspace', 'launcher', 'data', 'artifacts', 'tokenHome', 'temp', 'output']) mkdirSync(paths[key])
  mkdirSync(path.join(paths.runtime, '.gugo'))
  writeFileSync(path.join(paths.runtime, '.gugo', 'runtime.json'), JSON.stringify({ env: {
    APP_DATA_DIR: '../data', APP_DB_PATH: '../data/app.db', ARTIFACT_DIR: '../artifacts',
    GUGO_RUNTIME_CWD: paths.launcher,
  } }))
  writeFileSync(path.join(paths.data, 'runtime.json'), JSON.stringify({ env: {} }))
  writeFileSync(path.join(paths.launcher, '.env'), 'APP_DATA_DIR=wrong-launcher-data\nMODEL_BASE_URL=https://must-not-contact.invalid\n')
  writeFileSync(path.join(paths.workspace, 'AGENTS.md'), 'TASK_WORKSPACE_INSTRUCTIONS_MARKER: reply to the user normally.\n')
  writeFileSync(path.join(paths.runtime, 'AGENTS.md'), 'RUNTIME_ROOT_MUST_NOT_BE_TASK_INSTRUCTIONS\n')
  const seedEnv = isolatedEnvironment(paths, port)
  const env = { ...seedEnv }
  for (const key of ['APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH', 'ARTIFACT_DIR']) delete env[key]
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return { root, paths, env, seedEnv }
}

function seedSettings(f) {
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(moduleUrl('server/adapters/authAccount.js'))})
    const { closeDb, createUser } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    const { createGoalPlan } = await import(${JSON.stringify(moduleUrl('server/services/goalPlanService.js'))})
    const { createAgent } = await import(${JSON.stringify(moduleUrl('server/services/agentStore.js'))})
    const { installSkill } = await import(${JSON.stringify(moduleUrl('server/services/skillStore.js'))})
    const { upsertMemory } = await import(${JSON.stringify(moduleUrl('server/services/memoryStore.js'))})
    const { setApprovalMode } = await import(${JSON.stringify(moduleUrl('server/services/approvalSettingsStore.js'))})
    try {
      const { user } = bootstrapAuth({ env: process.env })
      const plan = createGoalPlan({ userId: user.id, objective: 'saved web goal', steps: [{ title: 'inspect' }] })
      createAgent({ userId: user.id, name: 'Shared local agent', identityMd: 'CLI_SHARED_AGENT_MARKER', isDefault: true })
      installSkill({ userId: user.id, id: 'shared_fixture', name: 'Shared fixture', description: 'shared configuration fixture',
        version: '1.0.0', icon: '', files: { 'prompts/system.md': 'CLI_SHARED_SKILL_MARKER' } })
      upsertMemory({ userId: user.id, type: 'project', title: 'Shared CLI config memory', body: 'CLI_SHARED_MEMORY_MARKER', pinned: true })
      createUser({ id: 'other-owner', email: 'other-owner@example.invalid' })
      upsertMemory({ userId: 'other-owner', type: 'project', title: 'Shared CLI config memory', body: 'OTHER_OWNER_MEMORY_MUST_NOT_LEAK', pinned: true })
      setApprovalMode({ userId: user.id, mode: 'plan' })
      process.stdout.write(JSON.stringify({ userId: user.id, planId: plan.id }))
    } finally { closeDb() }
  `
  const result = spawnSync(process.execPath, ['--import', NETWORK_GUARD, '--input-type=module', '--eval', script], {
    cwd: f.paths.runtime, env: f.seedEnv, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout)
}

function runCli(f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, CLI_PATH, ...args], {
      cwd: f.paths.launcher, env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`isolated CLI did not exit: ${stderr}`)) }, 45_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.end()
  })
}

test('goal commands bind the selected installation owner while explicit input files remain relative to the invocation directory', async (t) => {
  const f = fixture(t)
  const seeded = seedSettings(f)
  const listed = await runCli(f, ['--runtime-dir', f.paths.runtime, 'goal', 'list'])
  assert.equal(listed.status, 0, listed.stdout + listed.stderr)
  assert.equal(JSON.parse(listed.stdout).plans[0].id, seeded.planId)
  writeFileSync(path.join(f.paths.launcher, 'steps.json'), JSON.stringify([{ title: 'from invocation directory' }]))
  const created = await runCli(f, ['--runtime-dir', f.paths.runtime, 'goal', 'create', 'shared new goal', '--steps-file', 'steps.json'])
  assert.equal(created.status, 0, created.stdout + created.stderr)
  assert.equal(JSON.parse(created.stdout).steps[0].title, 'from invocation directory')
  assert.equal(existsSync(path.join(f.paths.launcher, 'server-data')), false)
  assert.equal(existsSync(path.join(f.paths.launcher, 'wrong-launcher-data')), false)
})

test('real CLI TurnEngine consumes the shared owner Provider, agent, skill, memory and plan policy from another cwd', async (t) => {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(raw))
      modelReply(res, { content: 'SHARED_RUNTIME_COMPLETE' })
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const f = fixture(t, server.address().port)
  const providerId = seedProvider(f.seedEnv, f.paths, server.address().port)
  seedSettings(f)
  const result = await runCli(f, ['--runtime-dir', f.paths.runtime, 'run',
    '/shared_fixture Shared CLI config memory: reply with a short greeting.', '--cwd', f.paths.workspace])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const events = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
  const started = events.find((event) => event.type === 'turn.started')
  assert.equal(started?.payload.modelProviderId, providerId)
  assert.equal(started?.payload.modelName, MODEL_NAME)
  assert.equal(started?.payload.approvalMode, 'plan')
  assert.equal(events.find((event) => event.type === 'turn.completed')?.payload.text, 'SHARED_RUNTIME_COMPLETE')
  const prompt = JSON.stringify(requests[0]?.messages)
  for (const marker of ['CLI_SHARED_AGENT_MARKER', 'CLI_SHARED_SKILL_MARKER', 'CLI_SHARED_MEMORY_MARKER', 'TASK_WORKSPACE_INSTRUCTIONS_MARKER']) {
    assert.ok(prompt.includes(marker), `shared prompt context missing ${marker}`)
  }
  assert.doesNotMatch(prompt, /OTHER_OWNER_MEMORY_MUST_NOT_LEAK|RUNTIME_ROOT_MUST_NOT_BE_TASK_INSTRUCTIONS/u)
  assert.equal(existsSync(path.join(f.paths.launcher, 'server-data')), false)
  assert.equal(existsSync(path.join(f.paths.workspace, 'server-data')), false)
})
