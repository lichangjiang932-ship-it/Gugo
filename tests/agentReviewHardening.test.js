import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'
import { closeDb, createUser } from '../server/db.js'
import { readFileTool } from '../server/adapters/fsFileTools.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { TurnEngine } from '../server/services/TurnEngine.js'
import { createTestTurnEnginePersistence } from './helpers/turnEnginePersistence.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import { getDynamicTool, registerDynamicTool } from '../server/services/toolRegistry.js'
import { isMutationExecutionCall } from '../server/services/loop/heuristics/mutationClassification.js'
import { isProductiveExecutionOutcome } from '../server/services/loop/heuristics/executionRecovery.js'
import { clearVerifiedMutationTargets } from '../server/services/loop/heuristics/mutationVerification.js'
import { isSuccessfulPdfLayoutVerification } from '../server/services/loop/heuristics/capabilityChecks.js'
import { PDF_LAYOUT_VERIFICATION_OK } from '../server/services/loop/heuristics/constants.js'

test.after(() => closeDb())
let sequence = 0

function fixture(t) {
  const userId = `agent-review-hardening-${++sequence}`
  createUser({ id: userId, email: `${userId}@example.invalid` })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-hardening-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { userId, directory }
}

function request(server, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function localServer(t, overrides = {}) {
  const env = { ...process.env, AUTH_MODE: 'local', NODE_ENV: 'production', ...overrides }
  const server = createAppServer({ getEnv: () => env })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return server
}

test('desktop local bootstrap rejects a rebinding Host before issuing an identity', async (t) => {
  const server = await localServer(t)
  const host = `attacker.example:${server.address().port}`
  const denied = await request(server, 'POST', '/api/auth/bootstrap', {
    Host: host, Origin: `http://${host}`, 'Content-Type': 'text/plain',
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'LOCAL_REQUEST_HOST_DENIED')
  const normal = await request(server, 'POST', '/api/auth/bootstrap')
  assert.equal(normal.status, 200)
  assert.equal(normal.body.authenticated, true)
})

test('desktop bootstrap rejects foreign and opaque origins but permits the loopback renderer', async (t) => {
  const server = await localServer(t)
  for (const origin of ['https://attacker.example', 'null']) {
    const denied = await request(server, 'POST', '/api/auth/bootstrap', { Origin: origin })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'LOCAL_REQUEST_ORIGIN_DENIED')
  }
  const normal = await request(server, 'POST', '/api/auth/bootstrap', {
    Origin: `http://localhost:${server.address().port}`,
  })
  assert.equal(normal.status, 200)
  assert.equal(normal.body.authenticated, true)
})

test('explicit multi-user hosts retain authenticated deployment semantics', async (t) => {
  const server = await localServer(t, { AUTH_MODE: 'multi_user' })
  const response = await request(server, 'POST', '/api/auth/bootstrap', {
    Host: 'app.example', Origin: 'https://app.example',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.mode, 'multi_user')
  assert.equal(response.body.authenticated, false)
})

test('memory and experience follow-ups retain the chosen local model and owner', async (t) => {
  const { userId } = fixture(t)
  const selectedEnv = {
    MODEL_PROVIDERS: 'selected-local',
    MODEL_NAME: 'selected-model',
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
  }
  let memory
  let experience
  const requests = []
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    env: { MODEL_NAME: 'different-local-default', MODEL_BASE_URL: 'http://127.0.0.1:18888/v1' },
    toolSpecs: [],
    preparePromptContext: async () => ({ messages: [], skillIds: [], memoryIds: [] }),
    resolveModelBinding: () => ({
      modelName: 'selected-model', providerId: 'selected-local', configRevision: 1, env: selectedEnv,
    }),
    runLoop: async () => ({ text: 'The local task completed.', artifactIds: [], iterations: 0 }),
    dispatchHooks: async () => ({ allow: true }),
    scheduleMemoryExtraction: (options) => { memory = options },
    scheduleExperienceAbstraction: (options) => { experience = options },
    runMemoryModel: async (request) => { requests.push(request); return '{"memories":[]}' },
  })
  t.after(() => engine.shutdown())
  const scope = { userId, sessionId: `${userId}-session`, turnId: `${userId}-turn` }
  await engine.startTurn({ ...scope, content: 'This desktop project uses SQLite for local storage.' })
  await engine.waitForTurn(scope)
  assert.equal((await engine.getTurn(scope)).status, 'completed')
  for (const options of [memory, experience]) {
    await options.callModel({ messages: [{ role: 'user', content: 'Extract durable local facts.' }] })
  }
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.modelName, 'selected-model')
    assert.equal(request.modelProviderId, 'selected-local')
    assert.equal(request.env.MODEL_BASE_URL, selectedEnv.MODEL_BASE_URL)
    assert.equal(request.userId, null)
    assert.equal(request.usageOwnerId, userId)
    assert.equal(request.signal.aborted, false)
  }
  await engine.shutdown()
  await assert.rejects(async () => memory.callModel({ messages: [] }), { name: 'AbortError' })
  assert.equal(requests.length, 2)
})

test('read-only and write MCP tools with the same name retain their user-scoped classification', async (t) => {
  const first = fixture(t)
  const second = fixture(t)
  const name = 'mcp__review__lookup'
  const spec = { type: 'function', function: {
    name, description: 'Scoped fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  } }
  const read = registerDynamicTool({
    name, userId: first.userId, origin: 'mcp', spec,
    metadata: { category: 'read', isReadOnly: true },
  })
  const write = registerDynamicTool({
    name, userId: second.userId, origin: 'mcp', spec,
    metadata: { category: 'external', isReadOnly: false },
  })
  t.after(() => { read(); write() })
  const call = { name, args: {} }
  assert.equal(isMutationExecutionCall(call, null, { userId: first.userId }), false)
  assert.equal(isProductiveExecutionOutcome(call, { ok: true }, null, { userId: first.userId }), false)
  assert.equal(isMutationExecutionCall(call, null, { userId: second.userId }), true)
  assert.equal(isProductiveExecutionOutcome(call, { ok: true }, null, { userId: second.userId }), true)
  assert.equal(getDynamicTool(name, { userId: first.userId }).metadata.isReadOnly, true)
})

test('Git diff verifies only the file in its actual project, including an absolute pending target', (t) => {
  const { directory } = fixture(t)
  const project = path.join(directory, 'project-a')
  const other = path.join(directory, 'project-b')
  const first = path.join(project, 'src/a.js')
  const second = path.join(other, 'src/a.js')
  const pending = new Set([first, second])
  const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-false\n+true\n'
  const cleared = clearVerifiedMutationTargets(pending,
    { name: 'git_diff', args: { cwd: project } },
    { ok: true, executionCwd: project, repositoryRoot: project, diff },
    { projectDirectory: project })
  assert.equal(cleared, true)
  assert.deepEqual([...pending], [second])
})

test('a real partial read does not verify the unread part of a changed file', async (t) => {
  const { userId, directory } = fixture(t)
  const target = path.join(directory, 'a.js')
  fs.writeFileSync(target, '// heading\nexport const enabled = false;\n')
  grantLocalPath({ userId, rootPath: directory, accessMode: 'read_only' })
  const call = { name: 'read_file', args: { path: target, offset: 0, limit: 1 } }
  const partial = await readFileTool({ ...call.args, userId })
  assert.equal(partial.content, '// heading')
  const pending = new Set([target])
  assert.equal(clearVerifiedMutationTargets(pending, call, partial), false)
  assert.equal(pending.size, 1)
  const fullCall = { name: 'read_file', args: { path: target } }
  const full = await readFileTool({ ...fullCall.args, userId })
  assert.equal(clearVerifiedMutationTargets(pending, fullCall, full), true)
  assert.equal(pending.size, 0)
})

test('truncation and positive offsets never clear whole-file verification', (t) => {
  fixture(t)
  for (const result of [
    { ok: true, path: 'a.js', content: 'a', truncated: true },
    { ok: true, path: 'a.js', content: 'last line', offset: 1, returnedLines: 1, totalLines: 2 },
  ]) {
    const pending = new Set(['a.js'])
    assert.equal(clearVerifiedMutationTargets(pending,
      { name: 'read_file', args: { path: 'a.js' } }, result), false)
    assert.equal(pending.size, 1)
  }
})

test('a model-authored PDF validation script cannot establish host layout verification by printing a marker', () => {
  const call = { name: 'bash_exec', args: { command: 'python verify_pdf_layout.py' } }
  assert.equal(isSuccessfulPdfLayoutVerification(call, {
    ok: true, exitCode: 0, stdout: `${PDF_LAYOUT_VERIFICATION_OK}\n`, stderr: '',
  }), false)
  assert.equal(isSuccessfulPdfLayoutVerification(call, {
    ok: true, exitCode: 0, stdout: `${PDF_LAYOUT_VERIFICATION_OK}\n`,
    pdfLayoutVerification: { verified: true, verifier: 'gugo_pdf_layout', version: 1 },
  }), false)
})

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

for (const complete of [false, true]) {
  test(`two-file task completion requires both requested mutations (complete=${complete})`, async (t) => {
    const { userId, directory } = fixture(t)
    fs.mkdirSync(path.join(directory, 'src'))
    for (const name of ['a.js', 'b.js']) {
      fs.writeFileSync(path.join(directory, 'src', name), 'export const enabled = false;\n')
    }
    const prompt = 'Update both src/a.js and src/b.js so each exports enabled = true, and verify each change.'
    let modelCalls = 0
    const result = await runToolLoop({
      job: { id: `${userId}-job`, userId, origin: 'chat', prompt, locale: 'en' },
      step: { id: `${userId}-step`, kind: 'chat' },
      messages: [{ role: 'user', content: prompt }],
      toolSpecs: SERVER_TOOL_SPECS.filter((spec) => ['write_file', 'read_file'].includes(spec.function.name)),
      intentMode: 'execute', maxIters: 8, enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: `${userId}-approved` }),
      runModel: async () => {
        modelCalls += 1
        const targets = complete ? ['a.js', 'b.js'] : ['a.js']
        if (modelCalls === 1) return { content: '', toolCalls: targets.map((name) => call(
          `${userId}-write-${name}`, 'write_file', { path: `src/${name}`, content: 'export const enabled = true;\n' },
        )) }
        if (modelCalls === 2) return { content: '', toolCalls: targets.map((name) => call(
          `${userId}-read-${name}`, 'read_file', { path: `src/${name}` },
        )) }
        return { content: 'Both files have been updated and verified.', toolCalls: [] }
      },
      executeTool: async ({ name, args }) => {
        const target = path.join(directory, args.path)
        if (name === 'write_file') {
          fs.writeFileSync(target, args.content)
          return { ok: true, path: args.path, changed: true }
        }
        return { ok: true, path: args.path, content: fs.readFileSync(target, 'utf8'), truncated: false }
      },
    })
    if (complete) {
      assert.equal(result.incomplete, undefined)
      assert.equal(result.text, 'Both files have been updated and verified.')
    } else {
      assert.equal(result.incomplete, true)
      assert.equal(fs.readFileSync(path.join(directory, 'src/b.js'), 'utf8'), 'export const enabled = false;\n')
    }
  })
}
