import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)))
const PYTHON = process.platform === 'win32' ? 'python.exe' : 'python3'
const pythonAvailable = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' }).status === 0

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.once('error', reject)
    req.once('end', () => resolve(body ? JSON.parse(body) : null))
  })
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function runPython(script, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-python-sdk-test-'))
    const scriptPath = path.join(directory, 'client.py')
    fs.writeFileSync(scriptPath, script)
    const child = spawn(PYTHON, ['-B', scriptPath, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: path.join(ROOT, 'sdk', 'python'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Python SDK test timed out\n${stderr || stdout}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fs.rmSync(directory, { recursive: true, force: true })
      if (code !== 0) reject(new Error(`Python SDK test exited ${code}\n${stderr || stdout}`))
      else resolve({ stdout, stderr })
    })
  })
}

const PYTHON_WORKFLOW = String.raw`
import json
import sys
import threading
from gugo_sdk import GugoClient, GugoSdkError

base_url = sys.argv[1]
client = GugoClient(base_url=base_url, token="python-sdk-token", request_timeout=10)
turn = client.start_turn({
    "sessionId": "session-1",
    "content": "Inspect the repository.",
    "modelMode": "agent",
    "intentMode": "answer",
    "unknownAuthority": "must-not-cross",
})
turn_id = turn["turnId"]
loaded = client.get_turn(session_id="session-1", turn_id=turn_id)
listed = client.list_turn_events(session_id="session-1", turn_id=turn_id, after=-1, limit=10)
polled = []
terminal = client.wait_for_terminal(
    session_id="session-1", turn_id=turn_id, after=1,
    poll_interval_ms=10, timeout_ms=1000, on_event=lambda event: polled.append(event["type"]),
)
streamed = []
activities = []
stream_terminal = client.stream_turn_events(
    session_id="session-1", turn_id=turn_id,
    on_event=lambda event: streamed.append(event["type"]),
    on_activity=lambda activity: activities.append(activity["kind"]),
)
steering = client.steer_turn(
    session_id="session-1", turn_id=turn_id,
    content="Focus on the failing test.", client_request_id="python-steer-1",
)
cancelled = client.cancel_turn(session_id="session-1", turn_id=turn_id)
resumed = client.resume_turn(
    session_id="session-1", turn_id=turn_id,
    resolution={"approved": True}, retry_failed=True, retry_recovery=False,
)
errors = {}
try:
    client.get_turn(session_id="hidden", turn_id="denied")
except GugoSdkError as error:
    errors["http"] = {"code": error.code, "status": error.status, "message": str(error)}
try:
    client.wait_for_terminal(
        session_id="session-1", turn_id="gap", poll_interval_ms=10, timeout_ms=1000,
    )
except GugoSdkError as error:
    errors["gap"] = error.code
cancel_event = threading.Event()
cancel_event.set()
try:
    client.wait_for_terminal(
        session_id="session-1", turn_id=turn_id,
        poll_interval_ms=10, timeout_ms=1000, cancel_event=cancel_event,
    )
except GugoSdkError as error:
    errors["abort"] = error.code
try:
    GugoClient(base_url="file:///tmp/gugo")
except GugoSdkError as error:
    errors["input"] = error.code
try:
    GugoClient(base_url="http://user:secret@example.test")
except GugoSdkError as error:
    errors["credentials"] = error.code
try:
    short_client = GugoClient(base_url=base_url, request_timeout=0.1)
    short_client.get_turn(session_id="session-1", turn_id="slow")
except GugoSdkError as error:
    errors["requestTimeout"] = error.code
print(json.dumps({
    "turn": turn,
    "loaded": loaded,
    "listed": [event["type"] for event in listed],
    "polled": polled,
    "terminal": terminal["type"],
    "streamed": streamed,
    "activities": activities,
    "streamTerminal": stream_terminal["type"],
    "steering": steering,
    "cancelled": cancelled,
    "resumed": resumed,
    "errors": errors,
}, separators=(",", ":")))
`

test('dependency-free Python SDK follows the versioned HTTP, polling, and SSE contracts', {
  skip: !pythonAvailable,
}, async () => {
  const requests = []
  const encodedTurnPath = '/api/turns/turn%2Fencoded'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readRequestBody(req) : null
    requests.push({ method: req.method, pathname: url.pathname, search: Object.fromEntries(url.searchParams), headers: req.headers, body })
    if (req.method === 'POST' && url.pathname === '/api/turns/run') {
      return sendJson(res, { turn: { turnId: 'turn/encoded', sessionId: 'session-1' } }, 202)
    }
    if (req.method === 'GET' && url.pathname === encodedTurnPath) {
      return sendJson(res, { turn: { turnId: 'turn/encoded', status: 'running' } })
    }
    if (req.method === 'GET' && url.pathname === '/api/turns/slow') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return sendJson(res, { turn: { turnId: 'slow', status: 'running' } })
    }
    if (req.method === 'GET' && url.pathname === '/api/turns/events') {
      if (url.searchParams.get('turnId') === 'gap') {
        return sendJson(res, { events: [{ sequence: 1, type: 'turn.completed', payload: {} }] })
      }
      const after = Number(url.searchParams.get('after'))
      return sendJson(res, { events: after < 0
        ? [
            { sequence: 0, type: 'turn.started', payload: {} },
            { sequence: 1, type: 'tool.completed', payload: { name: 'read_file' } },
          ]
        : [{ sequence: 2, type: 'turn.completed', payload: { text: 'done' } }],
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/turns/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('event: ready\ndata: {"phase":"connecting"}\n\n')
      res.write('event: turn_event\ndata: {"v":1,"type":"turn.event","event":{"sequence":0,"type":"turn.started","payload":{}}}\n\n')
      res.write('event: turn_activity\ndata: {"kind":"model_working"}\n\n')
      res.end('event: turn_event\ndata: {"v":1,"type":"turn.event","event":{"sequence":2,"compactedThrough":2,"type":"turn.completed","payload":{"text":"done"}}}\n\n')
      return
    }
    if (req.method === 'POST' && url.pathname === `${encodedTurnPath}/steer`) {
      return sendJson(res, { steering: { accepted: true, clientRequestId: body.clientRequestId } })
    }
    if (req.method === 'POST' && url.pathname === `${encodedTurnPath}/cancel`) {
      return sendJson(res, { turn: { turnId: 'turn/encoded', status: 'cancelling' } })
    }
    if (req.method === 'POST' && url.pathname === `${encodedTurnPath}/resume`) {
      return sendJson(res, { turn: { turnId: 'turn/encoded', status: 'queued', retryFailed: body.retryFailed } })
    }
    if (req.method === 'GET' && url.pathname === '/api/turns/denied') {
      return sendJson(res, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } }, 404)
    }
    return sendJson(res, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const { stdout } = await runPython(PYTHON_WORKFLOW, [
      `http://127.0.0.1:${server.address().port}/`,
    ])
    const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
    assert.deepEqual(result.listed, ['turn.started', 'tool.completed'])
    assert.deepEqual(result.polled, ['turn.completed'])
    assert.equal(result.terminal, 'turn.completed')
    assert.deepEqual(result.streamed, ['turn.started', 'turn.completed'])
    assert.deepEqual(result.activities, ['model_working'])
    assert.equal(result.streamTerminal, 'turn.completed')
    assert.deepEqual(result.errors, {
      http: { code: 'SESSION_NOT_FOUND', status: 404, message: 'session not found' },
      gap: 'GUGO_SDK_EVENT_SEQUENCE_INVALID',
      abort: 'GUGO_SDK_ABORTED',
      input: 'GUGO_SDK_INPUT_INVALID',
      credentials: 'GUGO_SDK_INPUT_INVALID',
      requestTimeout: 'GUGO_SDK_REQUEST_TIMEOUT',
    })

    const start = requests.find((entry) => entry.pathname === '/api/turns/run')
    assert.deepEqual(start.body, {
      sessionId: 'session-1',
      content: 'Inspect the repository.',
      modelMode: 'agent',
      intentMode: 'answer',
    })
    assert.equal(start.headers.authorization, 'Bearer python-sdk-token')
    assert.ok(requests.every((entry) => entry.headers['x-gugo-sdk-contract'] === '1'))
    assert.ok(requests.some((entry) => entry.pathname === encodedTurnPath))
    const stream = requests.find((entry) => entry.pathname === '/api/turns/stream')
    assert.equal(stream.search.turnEventVersion, '1')
    assert.match(stream.headers.accept, /text\/event-stream/)
    const resume = requests.find((entry) => entry.pathname.endsWith('/resume'))
    assert.deepEqual(resume.body, {
      sessionId: 'session-1',
      resolution: { approved: true },
      retryFailed: true,
      retryRecovery: false,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Python SDK denies cross-origin redirects before credentials reach the target', {
  skip: !pythonAvailable,
}, async () => {
  let targetHits = 0
  const sourceRequests = []
  const target = createServer((req, res) => {
    targetHits += 1
    sendJson(res, { turn: { turnId: 'leaked' } })
  })
  await new Promise((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
  const source = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    sourceRequests.push({ pathname: url.pathname, authorization: req.headers.authorization })
    if (url.pathname === '/api/turns/cross') {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${target.address().port}/credential-target`,
      })
      res.end()
      return
    }
    if (url.pathname === '/api/turns/same') {
      res.writeHead(302, { Location: '/api/turns/final?sessionId=session-1' })
      res.end()
      return
    }
    if (url.pathname === '/api/turns/final') {
      sendJson(res, { turn: { turnId: 'same', status: 'running' } })
      return
    }
    sendJson(res, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
  })
  await new Promise((resolve, reject) => {
    source.once('error', reject)
    source.listen(0, '127.0.0.1', resolve)
  })
  const script = String.raw`
import json, sys
from gugo_sdk import GugoClient, GugoSdkError
client = GugoClient(base_url=sys.argv[1], token="redirect-secret-token")
try:
    client.get_turn(session_id="session-1", turn_id="cross")
    denied = None
except GugoSdkError as error:
    denied = error.code
same = client.get_turn(session_id="session-1", turn_id="same")
print(json.dumps({"denied": denied, "same": same}, separators=(",", ":")))
`
  try {
    const { stdout } = await runPython(script, [
      `http://127.0.0.1:${source.address().port}/`,
    ])
    assert.deepEqual(JSON.parse(stdout.trim()), {
      denied: 'GUGO_SDK_REDIRECT_DENIED',
      same: { turnId: 'same', status: 'running' },
    })
    assert.equal(targetHits, 0)
    assert.ok(sourceRequests.length >= 3)
    assert.ok(sourceRequests.every((request) => request.authorization === 'Bearer redirect-secret-token'))
  } finally {
    await Promise.all([
      new Promise((resolve) => source.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ])
  }
})

test('Python SDK imports only the standard library and leaves no bytecode in the package', {
  skip: !pythonAvailable,
}, async () => {
  const sdkPath = path.join(ROOT, 'sdk', 'python', 'gugo_sdk.py')
  const source = fs.readFileSync(sdkPath, 'utf8')
  assert.doesNotMatch(source, /(?:server|src)[\\/]/u)
  assert.doesNotMatch(source, /^\s*(?:from|import)\s+(?:requests|httpx|aiohttp)\b/mu)
  const { stdout } = await runPython([
    'import ast, json, pathlib',
    `source = pathlib.Path(${JSON.stringify(sdkPath)}).read_text(encoding="utf-8")`,
    'ast.parse(source)',
    'from gugo_sdk import GUGO_SDK_CONTRACT_VERSION, GugoClient',
    'print(json.dumps({"version": GUGO_SDK_CONTRACT_VERSION, "client": GugoClient.__name__}))',
  ].join('\n'), [])
  assert.deepEqual(JSON.parse(stdout.trim()), { version: 1, client: 'GugoClient' })
  assert.equal(fs.existsSync(path.join(ROOT, 'sdk', 'python', '__pycache__')), false)
})
