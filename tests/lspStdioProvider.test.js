import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  _testing,
  createLspStdioProvider,
} from '../server/adapters/lspStdioProvider.js'

const FAKE_LSP_SERVER = String.raw`
const fs = require('node:fs')
const path = require('node:path')

const logPath = process.env.FIXTURE_LOG
const mode = process.env.FIXTURE_MODE || 'normal'
let input = Buffer.alloc(0)
let initializeId = null
let sideEffectStep = 0

function log(event) {
  fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + '\n')
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(Buffer.concat([
    Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'),
    body,
  ]))
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function range(line, start, end) {
  return {
    start: { line, character: start },
    end: { line, character: end },
  }
}

function finishInitialize() {
  result(initializeId, { capabilities: {} })
  initializeId = null
}

function handleResponse(message) {
  log({ type: 'serverResponse', id: message.id, result: message.result, error: message.error })
  if (mode !== 'side-effects') return
  if (message.id === 'side-apply') {
    sideEffectStep = 1
    send({
      jsonrpc: '2.0',
      id: 'side-command',
      method: 'workspace/executeCommand',
      params: { command: 'fixture.mutate' },
    })
  } else if (message.id === 'side-command') {
    sideEffectStep = 2
    finishInitialize()
  }
}

function handle(message) {
  if (!message || typeof message !== 'object') return
  if (!message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
    handleResponse(message)
    return
  }

  const event = { type: 'clientMessage', method: message.method }
  if (message.method === 'textDocument/didOpen') {
    event.text = message.params && message.params.textDocument && message.params.textDocument.text
    event.textBytes = Buffer.byteLength(event.text || '', 'utf8')
    event.languageId = message.params && message.params.textDocument && message.params.textDocument.languageId
  }
  log(event)

  if (message.method === 'initialize') {
    initializeId = message.id
    if (mode === 'malformed') {
      process.stdout.write('Content-Length: 4\r\n\r\nnope')
      return
    }
    if (mode === 'oversize') {
      process.stdout.write('Content-Length: 1048577\r\n\r\n')
      return
    }
    if (mode === 'side-effects') {
      send({
        jsonrpc: '2.0',
        id: 'side-apply',
        method: 'workspace/applyEdit',
        params: { edit: { changes: {} } },
      })
      return
    }
    finishInitialize()
    return
  }

  if (message.method === 'textDocument/definition') {
    if (mode === 'hang') return
    result(message.id, {
      targetUri: 'file:///definition.ts',
      targetRange: range(8, 0, 20),
      targetSelectionRange: range(8, 6, 12),
    })
  } else if (message.method === 'textDocument/references') {
    result(message.id, [{ uri: 'file:///reference.ts', range: range(3, 1, 9) }])
  } else if (message.method === 'textDocument/implementation') {
    result(message.id, { uri: 'file:///implementation.ts', range: range(5, 2, 14) })
  } else if (message.method === 'textDocument/hover') {
    result(message.id, {
      contents: [
        { language: 'ts', value: 'const 名称: string' },
        '**Unicode hover ☃️**',
      ],
      range: range(0, 6, 8),
    })
  } else if (message.method === 'shutdown') {
    result(message.id, null)
  } else if (message.method === 'exit') {
    setTimeout(() => process.exit(sideEffectStep < 0 ? 1 : 0), 10)
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (input.length > 0) {
    const headerEnd = input.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = input.subarray(0, headerEnd).toString('ascii')
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
    if (!match) process.exit(91)
    const length = Number(match[1])
    const end = headerEnd + 4 + length
    if (input.length < end) return
    const body = input.subarray(headerEnd + 4, end)
    input = input.subarray(end)
    handle(JSON.parse(body.toString('utf8')))
  }
})

log({
  type: 'start',
  cwd: process.cwd(),
  mode,
  sensitiveHostEnvPresent: Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY'),
  fixtureEnvPresent: process.env.FIXTURE_VISIBLE === 'yes',
})
`

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function withTimeout(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function createFixture(t, source = 'const 名称 = "雪人☃️"\nconsole.log(名称)\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-lsp-provider-'))
  const workspace = path.join(root, 'workspace')
  const serverPath = path.join(root, 'fake-lsp.cjs')
  const sourcePath = path.join(workspace, 'unicode.ts')
  const logPath = path.join(root, 'fixture.jsonl')
  await fs.mkdir(workspace)
  await Promise.all([
    fs.writeFile(serverPath, FAKE_LSP_SERVER, 'utf8'),
    fs.writeFile(sourcePath, source, 'utf8'),
  ])
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, workspace, serverPath, sourcePath, logPath, source }
}

async function readEvents(logPath) {
  let text
  try {
    text = await fs.readFile(logPath, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
}

async function waitForEvent(logPath, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await readEvents(logPath)
    const match = events.find(predicate)
    if (match) return match
    await delay(25)
  }
  throw new Error(`Timed out waiting for fixture event in ${logPath}`)
}

function request(fixture, operation) {
  return {
    operation,
    filePath: fixture.sourcePath,
    workspaceRoot: fixture.workspace,
    position: { line: 0, character: 6 },
    languageId: 'typescript',
  }
}

function providerConfig(fixture, mode = 'normal') {
  return {
    id: `fixture-${mode}`,
    command: process.execPath,
    args: [fixture.serverPath],
    env: {
      FIXTURE_LOG: fixture.logPath,
      FIXTURE_MODE: mode,
      FIXTURE_VISIBLE: 'yes',
    },
    extensionToLanguage: { '.ts': 'typescript' },
    cwd: fixture.workspace,
    timeoutMs: 10_000,
  }
}

function createTerminator({ settleMs = 75 } = {}) {
  const calls = []
  const terminateProcessTreeFn = async ({ pid, child }) => {
    calls.push({ pid, child })
    await delay(settleMs)
    let closeTimeout
    const closed = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          const onClose = () => {
            clearTimeout(closeTimeout)
            resolve()
          }
          child.once('close', onClose)
          closeTimeout = setTimeout(() => {
            child.off('close', onClose)
            resolve()
          }, 5_000)
        })
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* process already exited */ }
    }
    await closed
    return true
  }
  return { calls, terminateProcessTreeFn }
}

test('runs all four operations over byte-accurate stdio and completes the LSP lifecycle', async (t) => {
  const fixture = await createFixture(t)
  const spawnCalls = []
  const terminator = createTerminator()
  const originalSecret = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'host-secret-must-not-reach-lsp'
  t.after(() => {
    if (originalSecret === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalSecret
  })

  const provider = createLspStdioProvider(providerConfig(fixture), {
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options })
      return spawn(command, args, options)
    },
    terminateProcessTreeFn: terminator.terminateProcessTreeFn,
  })

  assert.equal(provider.id, 'fixture-normal')
  assert.deepEqual(provider.extensionToLanguage, { '.ts': 'typescript' })

  const definition = await provider.query(request(fixture, 'goToDefinition'))
  const references = await provider.query(request(fixture, 'findReferences'))
  const implementation = await provider.query(request(fixture, 'goToImplementation'))
  const hover = await provider.query(request(fixture, 'hover'))
  await provider.close()

  const workspaceUri = pathToFileURL(await fs.realpath(fixture.workspace)).href
  assert.deepEqual(definition, {
    kind: 'locations',
    locations: [{
      uri: 'file:///definition.ts',
      range: {
        start: { line: 8, character: 6 },
        end: { line: 8, character: 12 },
      },
    }],
    resolvedWorkspaceUri: workspaceUri,
  })
  assert.equal(references.locations[0].uri, 'file:///reference.ts')
  assert.equal(implementation.locations[0].uri, 'file:///implementation.ts')
  assert.deepEqual(hover, {
    kind: 'hover',
    hover: {
      contents: 'const 名称: string\n\n**Unicode hover ☃️**',
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 8 },
      },
    },
  })

  assert.equal(spawnCalls.length, 4)
  for (const call of spawnCalls) {
    assert.equal(call.command, process.execPath)
    assert.deepEqual(call.args, [fixture.serverPath])
    assert.equal(call.options.shell, false)
    assert.equal(call.options.cwd, fixture.workspace)
    assert.equal(call.options.env.OPENAI_API_KEY, undefined)
    assert.equal(call.options.env.FIXTURE_VISIBLE, 'yes')
    assert.equal(call.options.detached, process.platform !== 'win32')
  }
  assert.equal(terminator.calls.length, 4)
  assert.ok(terminator.calls.every(({ pid }) => Number.isInteger(pid) && pid > 0))

  const events = await readEvents(fixture.logPath)
  const starts = events.filter(({ type }) => type === 'start')
  assert.equal(starts.length, 4)
  assert.ok(starts.every(({ cwd }) => path.resolve(cwd) === path.resolve(fixture.workspace)))
  assert.ok(starts.every(({ sensitiveHostEnvPresent }) => sensitiveHostEnvPresent === false))
  assert.ok(starts.every(({ fixtureEnvPresent }) => fixtureEnvPresent === true))

  const didOpenEvents = events.filter(({ method }) => method === 'textDocument/didOpen')
  assert.equal(didOpenEvents.length, 4)
  assert.ok(didOpenEvents.every(({ text }) => text === fixture.source))
  assert.ok(didOpenEvents.every(({ textBytes }) => textBytes === Buffer.byteLength(fixture.source, 'utf8')))

  const expectedOperations = [
    'textDocument/definition',
    'textDocument/references',
    'textDocument/implementation',
    'textDocument/hover',
  ]
  for (const operation of expectedOperations) {
    const operationEvent = events.find((event) => event.method === operation)
    assert.ok(operationEvent, `missing ${operation}`)
    const methods = events
      .filter(({ pid, type }) => pid === operationEvent.pid && type === 'clientMessage')
      .map(({ method }) => method)
    assert.deepEqual(methods, [
      'initialize',
      'initialized',
      'textDocument/didOpen',
      operation,
      'textDocument/didClose',
      'shutdown',
      'exit',
    ])
  }
})

test('aborting a hung query rejects it and invokes process-tree termination', async (t) => {
  const fixture = await createFixture(t)
  const terminator = createTerminator({ settleMs: 0 })
  const provider = createLspStdioProvider(providerConfig(fixture, 'hang'), {
    terminateProcessTreeFn: terminator.terminateProcessTreeFn,
  })
  const controller = new AbortController()
  const queryPromise = provider.query(request(fixture, 'goToDefinition'), controller.signal)

  await waitForEvent(fixture.logPath, ({ method }) => method === 'textDocument/definition')
  controller.abort(new Error('test cancellation'))

  await assert.rejects(queryPromise, (cause) => cause?.code === 'LSP_ABORTED')
  assert.equal(terminator.calls.length, 1)
  assert.ok(terminator.calls[0].pid > 0)
  await provider.close()
  await assert.rejects(
    provider.query(request(fixture, 'hover')),
    (cause) => cause?.code === 'LSP_DISPOSED',
  )
})

for (const mode of ['malformed', 'oversize']) {
  test(`${mode} server responses fail closed and terminate the process tree`, async (t) => {
    const fixture = await createFixture(t)
    const terminator = createTerminator({ settleMs: 0 })
    const provider = createLspStdioProvider(providerConfig(fixture, mode), {
      terminateProcessTreeFn: terminator.terminateProcessTreeFn,
    })

    await assert.rejects(
      provider.query(request(fixture, 'goToDefinition')),
      (cause) => cause?.code === 'LSP_MALFORMED_RESPONSE',
    )
    assert.equal(terminator.calls.length, 1)
    await provider.close()
  })
}

test('server requests that could mutate the workspace are rejected', async (t) => {
  const fixture = await createFixture(t)
  const terminator = createTerminator()
  const provider = createLspStdioProvider(providerConfig(fixture, 'side-effects'), {
    terminateProcessTreeFn: terminator.terminateProcessTreeFn,
  })

  await provider.query(request(fixture, 'goToDefinition'))
  await provider.close()

  const responses = (await readEvents(fixture.logPath))
    .filter(({ type }) => type === 'serverResponse')
  assert.deepEqual(responses.map(({ id }) => id), ['side-apply', 'side-command'])
  for (const response of responses) {
    assert.equal(Object.hasOwn(response, 'result'), false)
    assert.equal(response.error?.code, -32601)
  }
})

test('oversized documents are rejected before a child process is spawned', async (t) => {
  const fixture = await createFixture(t, 'x'.repeat(_testing.MAX_DOCUMENT_BYTES + 1))
  let spawnCalls = 0
  const provider = createLspStdioProvider(providerConfig(fixture), {
    spawnImpl() {
      spawnCalls += 1
      throw new Error('must not spawn')
    },
  })

  await assert.rejects(
    provider.query(request(fixture, 'hover')),
    (cause) => cause?.code === 'LSP_SOURCE_TOO_LARGE',
  )
  assert.equal(spawnCalls, 0)
  await provider.close()
})

test('concurrent queries reserve their slots before asynchronous document reads', async (t) => {
  const fixture = await createFixture(t)
  const terminator = createTerminator({ settleMs: 0 })
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  let readCalls = 0
  let spawnCalls = 0
  let releaseReads
  let confirmFourReads
  const readGate = new Promise((resolve) => { releaseReads = resolve })
  const fourReads = new Promise((resolve) => { confirmFourReads = resolve })
  const provider = createLspStdioProvider(providerConfig(fixture, 'hang'), {
    async readFile(...args) {
      readCalls += 1
      if (readCalls === 4) confirmFourReads()
      await readGate
      return fs.readFile(...args)
    },
    spawnImpl(command, args, options) {
      spawnCalls += 1
      return spawn(command, args, options)
    },
    terminateProcessTreeFn: terminator.terminateProcessTreeFn,
  })

  const firstFour = controllers.slice(0, 4).map((controller) => (
    provider.query(request(fixture, 'goToDefinition'), controller.signal)
  ))
  await withTimeout(fourReads, 10_000, 'four document reads did not start')

  const fifth = provider.query(request(fixture, 'goToDefinition'), controllers[4].signal)
  const fifthOutcome = fifth.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
  const earlyFifthOutcome = await Promise.race([
    fifthOutcome,
    delay(200).then(() => ({ status: 'pending' })),
  ])

  releaseReads()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const operationCount = (await readEvents(fixture.logPath))
      .filter(({ method }) => method === 'textDocument/definition').length
    if (operationCount >= 4) break
    await delay(25)
  }
  controllers.forEach((controller) => controller.abort(new Error('test cleanup')))
  await Promise.allSettled([...firstFour, fifth])
  await provider.close()

  assert.equal(earlyFifthOutcome.status, 'rejected')
  assert.equal(earlyFifthOutcome.reason?.code, 'LSP_BUSY')
  assert.equal(readCalls, 4)
  assert.equal(spawnCalls, 4)
})

test('close during document loading prevents the pending query from spawning', async (t) => {
  const fixture = await createFixture(t)
  const terminator = createTerminator({ settleMs: 0 })
  let releaseRead
  let confirmReadStarted
  let spawnCalls = 0
  const readGate = new Promise((resolve) => { releaseRead = resolve })
  const readStarted = new Promise((resolve) => { confirmReadStarted = resolve })
  const provider = createLspStdioProvider(providerConfig(fixture), {
    async readFile(...args) {
      confirmReadStarted()
      await readGate
      return fs.readFile(...args)
    },
    spawnImpl(command, args, options) {
      spawnCalls += 1
      return spawn(command, args, options)
    },
    terminateProcessTreeFn: terminator.terminateProcessTreeFn,
  })

  const queryOutcome = provider.query(request(fixture, 'goToDefinition')).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
  await withTimeout(readStarted, 10_000, 'document read did not start')
  const closePromise = provider.close()
  releaseRead()
  await closePromise
  const outcome = await queryOutcome

  assert.equal(outcome.status, 'rejected')
  assert.ok(
    outcome.reason?.code === 'LSP_DISPOSED' || outcome.reason?.code === 'LSP_ABORTED',
    `unexpected close-race error: ${outcome.reason?.code}`,
  )
  assert.equal(spawnCalls, 0)
})
