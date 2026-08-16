import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-verified-local-files-'))
const workspace = path.join(tempRoot, 'workspace')
const outside = path.join(tempRoot, 'outside')
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
process.env.APP_DB_PATH = path.join(tempRoot, 'verified-local-files.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const {
  serializeToolResult,
  TRUNCATED_TOOL_RESULT_METADATA_KEY,
} = await import('../server/utils/toolCallHarness.js')
const {
  buildAssistantModelContext,
  extractVerifiedLocalFiles,
  recoverLegacyVerifiedLocalFiles,
  TURN_TOOL_CONTEXT_LIMITS,
} = await import('../server/services/turnMessageContext.js')

const integrationUserId = 'verified-local-files-integration-user'
const integrationSessionId = 'verified-local-files-integration-session'
createUser({ id: integrationUserId, email: 'verified-local-files@example.com' })
upsertSession({ id: integrationSessionId, userId: integrationUserId, title: 'Verified files' })

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function assistantCall(id, name, args) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function toolResult(id, name, result) {
  return { role: 'tool', tool_call_id: id, name, content: JSON.stringify(result) }
}

function serializedToolResult(id, name, result, maxChars = 24_000) {
  return { role: 'tool', tool_call_id: id, name, content: serializeToolResult(result, { maxChars }) }
}

function mutationAndReadMessages({
  mutationId,
  mutationName = 'write_file',
  mutationArgs,
  mutationResult,
  readId,
  readPath,
  content,
}) {
  const totalLines = content.split('\n').length
  return [
    assistantCall(mutationId, mutationName, mutationArgs),
    toolResult(mutationId, mutationName, mutationResult),
    assistantCall(readId, 'read_file', { path: readPath }),
    toolResult(readId, 'read_file', {
      ok: true,
      path: readPath,
      size: Buffer.byteLength(content),
      totalLines,
      offset: 0,
      returnedLines: totalLines,
      content,
    }),
  ]
}

test('a bounded read after mutation creates a lightweight clickable-file receipt', () => {
  const relativePath = 'pages/legacy-sampled.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>Legacy sampled file</title>\n<h1>Current</h1>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const messages = [
    assistantCall('legacy-sampled-write', 'write_file', { path: relativePath, content }),
    toolResult('legacy-sampled-write', 'write_file', { ok: true, path: relativePath }),
    assistantCall('legacy-sampled-read', 'read_file', { path: relativePath, offset: 0, limit: 1 }),
    toolResult('legacy-sampled-read', 'read_file', {
      ok: true,
      path: relativePath,
      offset: 0,
      returnedLines: 1,
      totalLines: 3,
      content: '<!doctype html>',
    }),
  ]

  const [currentReceipt] = extractVerifiedLocalFiles(messages, {
    userId: integrationUserId,
    verifiedAt: 111,
  })
  assert.equal(currentReceipt.path, fs.realpathSync(fullPath))
  assert.equal(currentReceipt.filename, 'legacy-sampled.html')
  assert.equal(currentReceipt.verifiedAt, 111)
  const [receipt] = recoverLegacyVerifiedLocalFiles(messages, {
    userId: integrationUserId,
    verifiedAt: 111,
  })
  assert.equal(receipt.path, fs.realpathSync(fullPath))
  assert.equal(receipt.filename, 'legacy-sampled.html')
  assert.equal(receipt.verifiedAt, 111)
  assert.deepEqual(recoverLegacyVerifiedLocalFiles(messages.slice(0, 2), {
    userId: integrationUserId,
  }), [])
})

test('new turn context persists an authoritative empty receipt list without readback', () => {
  const relativePath = 'pages/partial-new-turn.html'
  const content = '<!doctype html>\n<title>Partial</title>\n<h1>Not fully read</h1>'
  const messages = [
    assistantCall('partial-new-write', 'write_file', { path: relativePath, content }),
    toolResult('partial-new-write', 'write_file', { ok: true, path: relativePath }),
  ]

  const context = buildAssistantModelContext({
    turnId: 'partial-new-turn',
    checkpointMessages: messages,
    baselineToolCallIds: new Set(),
    userId: integrationUserId,
  })

  assert.deepEqual(context.verifiedLocalFiles, [])
})

test('a nonzero partial read after edit produces a link without embedding the whole file', () => {
  const relativePath = 'pages/partial-edit.html'
  const fullPath = path.join(workspace, relativePath)
  const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join('\n')
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const messages = [
    assistantCall('partial-edit', 'edit_file', {
      path: relativePath,
      old_string: 'line 80',
      new_string: 'line eighty',
    }),
    toolResult('partial-edit', 'edit_file', {
      ok: true,
      path: relativePath,
      replacedCount: 1,
      changes: [{ path: relativePath, additions: 1, deletions: 1 }],
    }),
    assistantCall('partial-edit-read', 'read_file', { path: relativePath, offset: 76, limit: 10 }),
    toolResult('partial-edit-read', 'read_file', {
      ok: true,
      path: relativePath,
      offset: 76,
      returnedLines: 10,
      totalLines: 120,
      content: 'line 77\nline 78\nline 79\nline eighty\nline 81',
    }),
  ]

  const [receipt] = extractVerifiedLocalFiles(messages, {
    userId: integrationUserId,
    verifiedAt: 222,
  })
  assert.equal(receipt.path, fs.realpathSync(fullPath))
  assert.equal(receipt.filename, 'partial-edit.html')
  assert.equal(receipt.size, Buffer.byteLength(content))
  assert.equal('content' in receipt, false)
})

test('large read_file bodies are bounded while verified receipts survive persisted model context', () => {
  const relativePath = 'pages/large.html'
  const fullPath = path.join(workspace, relativePath)
  const content = `<!doctype html>\n${'large-body-'.repeat(1_200)}\n</html>`
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const messages = mutationAndReadMessages({
    mutationId: 'large-write',
    mutationArgs: { path: relativePath, content },
    mutationResult: { ok: true, path: relativePath, bytes: Buffer.byteLength(content) },
    readId: 'large-read',
    readPath: relativePath,
    content,
  })

  const context = buildAssistantModelContext({
    turnId: 'turn-large',
    checkpointMessages: messages,
    baselineToolCallIds: new Set(),
    userId: 'verified-local-files-user',
    turnCompletedAt: 123_456,
  })
  const retainedRead = context.toolTrace.find((message) => message.tool_call_id === 'large-read')
  assert.ok(retainedRead.content.length <= TURN_TOOL_CONTEXT_LIMITS.maxResultChars)
  assert.match(retainedRead.content, /tool result truncated/u)
  assert.deepEqual(context.verifiedLocalFiles, [{
    id: context.verifiedLocalFiles[0].id,
    path: fs.realpathSync(fullPath),
    filename: 'large.html',
    size: Buffer.byteLength(content),
    verifiedAt: 123_456,
  }])
  assert.equal('content' in context.verifiedLocalFiles[0], false)

  const refreshed = JSON.parse(JSON.stringify(context))
  assert.deepEqual(refreshed.verifiedLocalFiles, context.verifiedLocalFiles)
})

test('verified receipts survive tool harness truncation of a greater-than-24KB HTML read', () => {
  const relativePath = 'pages/serializer-large.html'
  const fullPath = path.join(workspace, relativePath)
  const content = `<!doctype html>\n${'serializer-large-body-'.repeat(3_000)}\n</html>`
  const totalLines = content.split('\n').length
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const messages = [
    assistantCall('serializer-write', 'write_file', { path: relativePath, content }),
    toolResult('serializer-write', 'write_file', {
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content),
    }),
    assistantCall('serializer-read', 'read_file', { path: relativePath }),
    serializedToolResult('serializer-read', 'read_file', {
      ok: true,
      path: relativePath,
      size: Buffer.byteLength(content),
      totalLines,
      offset: 0,
      returnedLines: totalLines,
      content,
    }),
  ]

  const serializedRead = JSON.parse(messages.at(-1).content)
  assert.equal(serializedRead._truncated, true)
  assert.ok(messages.at(-1).content.length <= 24_000)
  assert.deepEqual(serializedRead[TRUNCATED_TOOL_RESULT_METADATA_KEY], {
    version: 1,
    path: relativePath,
    size: Buffer.byteLength(content),
    totalLines,
    offset: 0,
    returnedLines: totalLines,
    contentPresent: true,
    sourceTruncated: false,
  })
  assert.equal('content' in serializedRead[TRUNCATED_TOOL_RESULT_METADATA_KEY], false)

  const receipts = extractVerifiedLocalFiles(messages, {
    userId: 'verified-local-files-user',
    verifiedAt: 222,
  })
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].path, fs.realpathSync(fullPath))
  assert.equal(receipts[0].size, Buffer.byteLength(content))
})

test('workspace-relative receipts accept authorized files and reject ../outside traversal', () => {
  const safeRelative = 'safe/index.html'
  const safePath = path.join(workspace, safeRelative)
  const outsidePath = path.join(outside, 'outside.html')
  const outsideRelative = path.relative(workspace, outsidePath)
  fs.mkdirSync(path.dirname(safePath), { recursive: true })
  fs.writeFileSync(safePath, '<h1>safe</h1>', 'utf8')
  fs.writeFileSync(outsidePath, '<h1>outside</h1>', 'utf8')

  const messages = [
    ...mutationAndReadMessages({
      mutationId: 'safe-write',
      mutationArgs: { path: safeRelative, content: '<h1>safe</h1>' },
      mutationResult: { ok: true, path: safeRelative },
      readId: 'safe-read',
      readPath: safeRelative,
      content: '<h1>safe</h1>',
    }),
    ...mutationAndReadMessages({
      mutationId: 'outside-write',
      mutationArgs: { path: outsideRelative, content: '<h1>outside</h1>' },
      mutationResult: { ok: true, path: outsideRelative },
      readId: 'outside-read',
      readPath: outsideRelative,
      content: '<h1>outside</h1>',
    }),
  ]

  const receipts = extractVerifiedLocalFiles(messages, {
    userId: 'verified-local-files-user',
    verifiedAt: 99,
  })
  assert.deepEqual(receipts.map((receipt) => receipt.path), [fs.realpathSync(safePath)])
})

test('command mutations use changedPaths and ignore empty changedPaths', () => {
  const bashRelative = 'generated/bash.html'
  const runRelative = 'generated/run.html'
  const unchangedRelative = 'generated/unchanged.html'
  for (const [relativePath, content] of [
    [bashRelative, '<p>bash</p>'],
    [runRelative, '<p>run</p>'],
    [unchangedRelative, '<p>unchanged</p>'],
  ]) {
    const fullPath = path.join(workspace, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
  }

  const messages = [
    ...mutationAndReadMessages({
      mutationId: 'bash-command',
      mutationName: 'bash_exec',
      mutationArgs: { command: 'generate bash', expected_outputs: [bashRelative] },
      mutationResult: { ok: true, exitCode: 0, changedPaths: [bashRelative] },
      readId: 'bash-read',
      readPath: bashRelative,
      content: '<p>bash</p>',
    }),
    ...mutationAndReadMessages({
      mutationId: 'run-command',
      mutationName: 'run_command',
      mutationArgs: { command: 'generate run', expected_outputs: [runRelative] },
      mutationResult: { ok: true, exitCode: 0, changedPaths: [runRelative] },
      readId: 'run-read',
      readPath: runRelative,
      content: '<p>run</p>',
    }),
    ...mutationAndReadMessages({
      mutationId: 'empty-command',
      mutationName: 'bash_exec',
      mutationArgs: { command: 'no changes', expected_outputs: [unchangedRelative] },
      mutationResult: { ok: true, exitCode: 0, changedPaths: [] },
      readId: 'unchanged-read',
      readPath: unchangedRelative,
      content: '<p>unchanged</p>',
    }),
  ]

  const receipts = extractVerifiedLocalFiles(messages, {
    userId: 'verified-local-files-user',
    verifiedAt: 101,
  })
  assert.deepEqual(
    receipts.map((receipt) => receipt.filename).sort(),
    ['bash.html', 'run.html'],
  )
})

test('patch_file mutations create receipts after readback while dry runs never do', () => {
  const relativePath = 'pages/patched.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>Patched</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')

  const applied = mutationAndReadMessages({
    mutationId: 'patch-file-applied',
    mutationName: 'patch_file',
    mutationArgs: { path: relativePath, start_line: 2, end_line: 2, replacement: '<title>Patched</title>' },
    mutationResult: { ok: true, path: relativePath, beforeSha256: 'before', afterSha256: 'after' },
    readId: 'patch-file-read',
    readPath: relativePath,
    content,
  })
  const dryRun = mutationAndReadMessages({
    mutationId: 'patch-file-dry-run',
    mutationName: 'patch_file',
    mutationArgs: { path: relativePath, start_line: 2, end_line: 2, replacement: '<title>Preview</title>', dry_run: true },
    mutationResult: { ok: true, dryRun: true, path: relativePath, beforeSha256: 'before', afterSha256: 'preview' },
    readId: 'patch-file-dry-run-read',
    readPath: relativePath,
    content,
  })

  assert.deepEqual(
    extractVerifiedLocalFiles(applied, { userId: integrationUserId }).map((receipt) => receipt.path),
    [fs.realpathSync(fullPath)],
  )
  assert.deepEqual(extractVerifiedLocalFiles(dryRun, { userId: integrationUserId }), [])
})

test('command changedPaths survive truncation of very long stdout without trusting preview text', () => {
  const relativePath = 'generated/long-command.html'
  const fakeRelativePath = 'generated/preview-only.html'
  const fullPath = path.join(workspace, relativePath)
  const fakePath = path.join(workspace, fakeRelativePath)
  const content = '<p>long command output</p>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  fs.writeFileSync(fakePath, '<p>preview only</p>', 'utf8')
  const commandResult = serializedToolResult('long-command', 'bash_exec', {
    ok: true,
    exitCode: 0,
    stdout: `${JSON.stringify({ changedPaths: [fakeRelativePath] })}\n${'command-output-'.repeat(6_000)}`,
    changedPaths: [relativePath],
  })
  const parsedCommandResult = JSON.parse(commandResult.content)
  assert.equal(parsedCommandResult._truncated, true)
  assert.deepEqual(
    parsedCommandResult[TRUNCATED_TOOL_RESULT_METADATA_KEY].changedPaths,
    [relativePath],
  )
  assert.equal('stdout' in parsedCommandResult[TRUNCATED_TOOL_RESULT_METADATA_KEY], false)

  const messages = [
    assistantCall('long-command', 'bash_exec', {
      command: 'generate a page',
      expected_outputs: [relativePath],
    }),
    commandResult,
    assistantCall('long-command-read', 'read_file', { path: relativePath }),
    toolResult('long-command-read', 'read_file', {
      ok: true,
      path: relativePath,
      totalLines: 1,
      offset: 0,
      returnedLines: 1,
      content,
    }),
    assistantCall('preview-only-read', 'read_file', { path: fakeRelativePath }),
    toolResult('preview-only-read', 'read_file', {
      ok: true,
      path: fakeRelativePath,
      totalLines: 1,
      offset: 0,
      returnedLines: 1,
      content: '<p>preview only</p>',
    }),
  ]

  const receipts = extractVerifiedLocalFiles(messages, {
    userId: 'verified-local-files-user',
    verifiedAt: 333,
  })
  assert.deepEqual(receipts.map((receipt) => receipt.path), [fs.realpathSync(fullPath)])
})

test('TurnEngine persists the same verified receipt in the completed event and assistant message', async () => {
  const turnId = 'verified-local-files-completed-turn'
  const relativePath = 'completed/final.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>complete</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const checkpointMessages = mutationAndReadMessages({
    mutationId: 'completed-write',
    mutationArgs: { path: relativePath, content },
    mutationResult: { ok: true, path: relativePath },
    readId: 'completed-read',
    readPath: relativePath,
    content,
  })
  const engine = new TurnEngine({
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: checkpointMessages, artifactIds: [], iterations: 1 })
      return { text: 'File updated.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    content: 'Update the file.',
  })
  await engine.waitForTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })

  const completed = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.completed')
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(completed.payload.verifiedLocalFiles.length, 1)
  assert.deepEqual(assistant.modelContext.verifiedLocalFiles, completed.payload.verifiedLocalFiles)
  assert.equal(completed.payload.verifiedLocalFiles[0].path, fs.realpathSync(fullPath))
})
