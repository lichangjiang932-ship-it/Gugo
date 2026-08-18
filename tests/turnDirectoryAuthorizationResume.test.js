import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-directory-resume-'))
const authorizedDir = path.join(tempDir, 'authorized-output')
const sourcePdf = path.join(tempDir, 'answer-sheet.pdf')
fs.writeFileSync(sourcePdf, '%PDF-1.4\n', 'utf8')
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { handleTurnEventRequest } = await import('../server/routes/turnEventRoutes.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const {
  applyDirectoryAuthorizationToolsConfig,
  applyServerToolsConfig,
  restoreDirectoryAuthorizationToolSpecs,
} = await import('../server/services/turnToolSpecs.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const { resumeServerTurnRequest } = await import('../src/lib/turnClient/turnRequests.js')
const { normalizeServerSessionSnapshot } = await import('../src/lib/turnClient/sessionSnapshot.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const userId = 'turn-directory-resume-user'
const sessionId = 'turn-directory-resume-session'
const turnId = 'turn-directory-resume-turn'

createUser({ id: userId, email: 'turn-directory-resume@example.com' })
upsertSession({ id: sessionId, userId, title: 'Directory authorization resume' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function events() {
  return listTurnEvents({ requestedUser: userId, userId, sessionId, turnId, limit: 2000 })
}

function toolNames(specs) {
  return specs.map((spec) => spec?.function?.name).filter(Boolean).sort()
}

test('read-only directory authorization restores only read tools', () => {
  const restored = restoreDirectoryAuthorizationToolSpecs([], {
    type: 'directory_authorization',
    approved: true,
    path: authorizedDir,
    access_mode: 'read_only',
  }, SERVER_TOOL_SPECS)

  assert.deepEqual(toolNames(restored), ['list_directory', 'read_file'])
  assert.equal(toolNames(restored).includes('write_file'), false)
  assert.equal(toolNames(restored).includes('bash_exec'), false)
})

test('read-write directory authorization restores schemas without overriding disabled execution switches', () => {
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: authorizedDir,
    access_mode: 'read_write',
  }
  const expected = [
    'apply_patch', 'bash_exec', 'edit_file', 'list_directory',
    'patch_file', 'read_file', 'run_command', 'write_file',
  ]
  const restored = restoreDirectoryAuthorizationToolSpecs([], resolution, SERVER_TOOL_SPECS)
  assert.deepEqual(toolNames(restored), expected)

  const configured = applyDirectoryAuthorizationToolsConfig({
    enabled: [],
    disabled: expected,
  }, resolution)
  assert.deepEqual(configured.enabled, [])
  assert.deepEqual(configured.disabled, expected)
})

test('non-directory resolution cannot restore local execution tools', () => {
  const existing = SERVER_TOOL_SPECS.filter((spec) => spec?.function?.name === 'web_search')
  const restored = restoreDirectoryAuthorizationToolSpecs(existing, {
    type: 'clarification_response',
    response: 'continue',
    paused_sequence: 7,
  }, SERVER_TOOL_SPECS)

  assert.deepEqual(toolNames(restored), toolNames(existing))
  for (const localTool of ['list_directory', 'read_file', 'write_file', 'bash_exec']) {
    assert.equal(toolNames(restored).includes(localTool), false, localTool)
  }
})

test('directory authorization restores code tools missing from the pre-authorization base specs', async () => {
  setApprovalMode({ userId, mode: 'bypass' })
  let modelCalls = 0
  const executed = []
  const observedToolNames = []
  let resolutionMarker = ''

  const engine = new TurnEngine({
    scheduleMemoryExtraction: () => {},
    readApprovalMode: () => 'off',
    toolSpecs: SERVER_TOOL_SPECS.filter((spec) => (
      !['bash_exec', 'write_file', 'edit_file'].includes(spec?.function?.name)
    )),
    resolveToolSpecs: async ({ baseSpecs, toolsConfig }) => applyServerToolsConfig(
      baseSpecs.filter((spec) => (
        [
          'request_directory',
          'bash_exec',
          'run_project_check',
          'write_file',
          'edit_file',
          'read_file',
          'list_directory',
        ].includes(spec?.function?.name)
      )),
      toolsConfig,
    ),
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const toolNames = tools.map((spec) => spec.function.name).sort()
      observedToolNames.push(toolNames)
      if (modelCalls === 1) {
        for (const disabled of ['bash_exec', 'write_file', 'edit_file']) {
          assert.equal(toolNames.includes(disabled), false, disabled)
        }
        for (const readable of ['read_file', 'list_directory']) {
          assert.equal(toolNames.includes(readable), true, readable)
        }
        return {
          content: '',
          toolCalls: [toolCall('request-directory', 'request_directory', {
            purpose: 'Generate a verified preview by running local code.',
            access_mode: 'read_write',
            suggested_path: authorizedDir,
          })],
        }
      }

      if (modelCalls === 2) {
        for (const restored of ['bash_exec', 'write_file', 'edit_file', 'read_file', 'list_directory']) {
          assert.equal(toolNames.includes(restored), true, restored)
        }
        const markers = messages.filter((message) => (
          message?.role === 'system'
          && String(message.content || '').includes('[TURN_RESOLUTION:')
        ))
        assert.equal(markers.length, 1, 'the persisted authorization must be injected exactly once')
        resolutionMarker = String(markers[0].content)
        assert.match(resolutionMarker, /already persisted and verified/)
        assert.match(resolutionMarker, /read_write/)
        assert.equal(resolutionMarker.includes(JSON.stringify(authorizedDir)), true)

        return {
          content: '目录授权请求已发出……我在等待你的选择。',
          toolCalls: [],
        }
      }

      const lastToolMessage = messages.findLast((message) => message.role === 'tool')
      if (modelCalls === 3) {
        assert.ok(messages.findLast((message) => (
          message?.role === 'system'
          && String(message.content || '').includes('[VERIFIED DIRECTORY RESUME REQUIRED]')
        )))
        return {
          content: '',
          toolCalls: [toolCall('execute-code', 'bash_exec', {
            command: 'node -e "process.stdout.write(\'code-ok\')"',
            cwd: authorizedDir,
          })],
        }
      }

      if (modelCalls === 4) {
        assert.match(String(lastToolMessage?.content || ''), /code-ok/)
        return {
          content: '',
          toolCalls: [toolCall('verify-code', 'run_project_check', {
            check: 'test',
            cwd: authorizedDir,
          })],
        }
      }

      assert.match(String(lastToolMessage?.content || ''), /checks-passed/)
      return { content: '代码已执行并验证完成。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      if (name === 'request_directory') {
        return {
          ok: true,
          paused: true,
          clarification: {
            question: 'Please choose and authorize a directory so this task can continue.',
            blocker_kind: 'permission',
            request_type: 'directory',
            access_mode: args.access_mode,
            suggested_path: args.suggested_path,
            purpose: args.purpose,
          },
        }
      }
      if (name === 'bash_exec') {
        assert.equal(args.cwd, authorizedDir)
        return { ok: true, exitCode: 0, stdout: 'code-ok', stderr: '' }
      }
      if (name === 'run_project_check') {
        assert.deepEqual(args, { check: 'test', cwd: authorizedDir })
        return { ok: true, check: 'test', exitCode: 0, stdout: 'checks-passed', stderr: '' }
      }
      throw new Error(`unexpected tool: ${name}`)
    },
  })

  const sourceGrant = grantLocalPath({
    userId,
    rootPath: sourcePdf,
    accessMode: 'read_only',
  })
  assert.equal(sourceGrant.resourceType, 'file')

  await engine.startTurn({
    userId,
    sessionId,
    turnId,
    content: `读取 ${sourcePdf}，再在授权目录中运行代码并验证输出。`,
    intentMode: 'execute',
  })
  await engine.waitForTurn({ userId, sessionId, turnId })

  const pausedEvents = events()
  const paused = pausedEvents.at(-1)
  assert.equal(paused.type, 'turn.paused')
  assert.equal(paused.payload.clarification.request_type, 'directory')
  assert.equal(paused.payload.clarification.access_mode, 'read_write')
  assert.equal(paused.payload.clarification.suggested_path, authorizedDir)
  assert.equal(pausedEvents.some((event) => event.type === 'turn.completed'), false)
  assert.equal(engine.getTurn({ userId, sessionId, turnId }).status, 'paused')

  const persistedPausedMessage = listMessages({ userId, sessionId, limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  const hydratedSnapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [persistedPausedMessage],
  })
  const hydratedPausedSequence = hydratedSnapshot.messages[0].meta.serverLastSequence
  assert.equal(hydratedPausedSequence, paused.sequence)

  fs.mkdirSync(authorizedDir, { recursive: true })
  const grant = grantLocalPath({ userId, rootPath: authorizedDir, accessMode: 'read_write' })
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: grant.path,
    access_mode: 'read_write',
    paused_sequence: hydratedPausedSequence,
    purpose: 'Generate a verified preview by running local code.',
  }

  const resumed = await engine.resumeTurn({ userId, sessionId, turnId, resolution })
  assert.equal(resumed.turnId, turnId)
  await engine.waitForTurn({ userId, sessionId, turnId })

  const finalEvents = events()
  const resumeEvent = finalEvents.find((event) => event.type === 'turn.resumed')
  assert.ok(resumeEvent)
  assert.equal(resumeEvent.turnId, turnId)
  assert.deepEqual(resumeEvent.payload.resolution, {
    ...resolution,
    resource_type: 'directory',
  })
  assert.equal(resumeEvent.payload.pausedSequence, paused.sequence)
  assert.equal(
    finalEvents.at(-1).type,
    'turn.completed',
    `unexpected terminal event: ${JSON.stringify(finalEvents.at(-1))}`,
  )
  assert.equal(finalEvents.at(-1).payload.text, '代码已执行并验证完成。')
  assert.deepEqual(executed.map(({ name }) => name), ['request_directory', 'bash_exec', 'run_project_check'])
  assert.equal(modelCalls, 5)
  assert.equal(observedToolNames.length, 5)
  assert.match(resolutionMarker, new RegExp(`\\[TURN_RESOLUTION:${paused.sequence}\\]`))

  const canonicalUserMessages = listMessages({ userId, sessionId, limit: 100 })
    .filter((message) => message.id === `${turnId}:user`)
  assert.equal(canonicalUserMessages.length, 1, 'resume must not create a second user turn')
  assert.equal(
    canonicalUserMessages[0].content,
    `读取 ${sourcePdf}，再在授权目录中运行代码并验证输出。`,
  )
})

test('client and HTTP route preserve the directory resolution on same-turn resume', async () => {
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: authorizedDir,
    access_mode: 'read_write',
    paused_sequence: 7,
    purpose: 'Continue code execution.',
  }
  let clientRequest = null
  const clientTurn = await resumeServerTurnRequest({
    sessionId: 'client-session',
    turnId: 'client-turn',
    resolution,
    fetchImpl: async (url, options) => {
      clientRequest = { url, options }
      return new Response(JSON.stringify({
        turn: { sessionId: 'client-session', turnId: 'client-turn', status: 'running' },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.equal(clientTurn.turnId, 'client-turn')
  assert.equal(clientRequest.url, '/api/turns/client-turn/resume')
  assert.deepEqual(JSON.parse(clientRequest.options.body), {
    sessionId: 'client-session',
    resolution,
  })

  const authSession = issueTestSession({ email: 'turn-directory-route@example.com' })
  let routeRequest = null
  const routeServer = createServer((req, res) => {
    void handleTurnEventRequest(req, res, {
      async resumeTurn(input) {
        routeRequest = input
        return { sessionId: input.sessionId, turnId: input.turnId, status: 'running' }
      },
    }, { env: { AUTH_MODE: 'multi_user' } })
  })
  await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve))
  try {
    const routeOrigin = `http://127.0.0.1:${routeServer.address().port}`
    const response = await fetch(`${routeOrigin}/api/turns/route-turn/resume`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'route-session', resolution }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual((await response.json()).turn, {
      sessionId: 'route-session',
      turnId: 'route-turn',
      status: 'running',
    })
  } finally {
    await new Promise((resolve) => routeServer.close(resolve))
  }

  assert.equal(routeRequest.userId, authSession.userId)
  assert.equal(routeRequest.sessionId, 'route-session')
  assert.equal(routeRequest.turnId, 'route-turn')
  assert.equal(routeRequest.authMode, 'multi_user')
  assert.deepEqual(routeRequest.resolution, resolution)
})
