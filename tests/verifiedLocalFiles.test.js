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
  YMA_TEST_DEFAULT_OUTPUT_DIR: process.env.YMA_TEST_DEFAULT_OUTPUT_DIR,
}
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
process.env.APP_DB_PATH = path.join(tempRoot, 'verified-local-files.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'
process.env.YMA_TEST_DEFAULT_OUTPUT_DIR = workspace

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent, listTurnEvents } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { createTestTurnEnginePersistence } = await import('./helpers/turnEnginePersistence.js')
const {
  serializeToolResult,
  TRUNCATED_TOOL_RESULT_METADATA_KEY,
} = await import('../server/utils/toolCallHarness.js')
const {
  buildAssistantModelContext,
  extractRetainedLocalFiles,
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
  assert.deepEqual(context.retainedLocalFiles, [])
})

test('a successful write without readback creates only a retained pending-verification receipt', () => {
  const relativePath = 'pages/retained-pending.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>Retained pending</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const messages = [
    assistantCall('retained-pending-write', 'write_file', { path: relativePath, content }),
    toolResult('retained-pending-write', 'write_file', {
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content),
    }),
  ]

  const retainedLocalFiles = extractRetainedLocalFiles(messages, {
    userId: integrationUserId,
    retainedAt: 333,
  })
  assert.deepEqual(extractVerifiedLocalFiles(messages, { userId: integrationUserId }), [])
  assert.deepEqual(retainedLocalFiles, [{
    id: retainedLocalFiles[0].id,
    path: fs.realpathSync(fullPath),
    filename: 'retained-pending.html',
    size: Buffer.byteLength(content),
    retainedAt: 333,
  }])

  const context = buildAssistantModelContext({
    turnId: 'retained-pending-turn',
    checkpointMessages: messages,
    baselineToolCallIds: new Set(),
    userId: integrationUserId,
    retainedLocalFiles,
  })
  assert.deepEqual(context.verifiedLocalFiles, [])
  assert.deepEqual(context.retainedLocalFiles, retainedLocalFiles)
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
    persistence: createTestTurnEnginePersistence(),
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
  assert.deepEqual(completed.payload.retainedLocalFiles, [])
  assert.deepEqual(assistant.modelContext.verifiedLocalFiles, completed.payload.verifiedLocalFiles)
  assert.deepEqual(assistant.modelContext.retainedLocalFiles, [])
  assert.equal(completed.payload.verifiedLocalFiles[0].path, fs.realpathSync(fullPath))
})

test('TurnEngine keeps current-turn receipts when a provider reuses a historical tool call id', async () => {
  const turnId = 'verified-local-files-reused-call-id-turn'
  const prompt = 'Update the current file despite reused provider ids.'
  const historicalPath = 'reused-id/historical.html'
  const currentPath = 'reused-id/current.html'
  const historicalContent = '<title>historical</title>'
  const currentContent = '<title>current</title>'
  for (const [relativePath, value] of [[historicalPath, historicalContent], [currentPath, currentContent]]) {
    const fullPath = path.join(workspace, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, value, 'utf8')
  }
  const checkpointMessages = [
    { role: 'user', content: 'Historical request.' },
    assistantCall('call-0-write_file', 'write_file', { path: historicalPath, content: historicalContent }),
    toolResult('call-0-write_file', 'write_file', { ok: true, path: historicalPath }),
    { role: 'user', content: prompt },
    assistantCall('call-0-write_file', 'write_file', { path: currentPath, content: currentContent }),
    toolResult('call-0-write_file', 'write_file', { ok: true, path: currentPath }),
    assistantCall('call-1-read_file', 'read_file', { path: currentPath, offset: 0, limit: 0 }),
    toolResult('call-1-read_file', 'read_file', {
      ok: true,
      path: currentPath,
      offset: 0,
      returnedLines: 1,
      totalLines: 1,
      complete: true,
      content: currentContent,
    }),
  ]
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: checkpointMessages, artifactIds: [], iterations: 1 })
      return { text: 'Current file updated.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    content: prompt,
  })
  await engine.waitForTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })

  const completed = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.completed')
  assert.deepEqual(completed.payload.verifiedLocalFiles.map((file) => file.path), [
    fs.realpathSync(path.join(workspace, currentPath)),
  ])
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(assistant.modelContext.toolTrace.some((message) => (
    message.role === 'tool' && message.tool_call_id === 'call-0-write_file'
  )), true)
})

test('TurnEngine keeps a verified edited file clickable when a later artifact step fails', async () => {
  const turnId = 'verified-local-files-partial-delivery-turn'
  const relativePath = 'partial/gallery.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>edited and verified</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const checkpointMessages = mutationAndReadMessages({
    mutationId: 'partial-edit',
    mutationName: 'edit_file',
    mutationArgs: { path: relativePath, old_text: 'old', new_text: 'new' },
    mutationResult: { ok: true, path: relativePath },
    readId: 'partial-read',
    readPath: relativePath,
    content,
  })
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: checkpointMessages, artifactIds: ['failed-image'], iterations: 2 })
      return {
        incomplete: true,
        text: 'The image generator failed after the HTML edit.',
        artifactIds: ['failed-image'],
        deliveryArtifactIds: [],
        iterations: 2,
      }
    },
  })

  await engine.startTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    content: 'Edit the gallery and generate an image.',
  })
  await engine.waitForTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })

  const failed = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.failed')
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.deepEqual(failed.payload.deliveryArtifactIds, [])
  assert.equal(failed.payload.verifiedLocalFiles.length, 1)
  assert.deepEqual(failed.payload.retainedLocalFiles, [])
  assert.equal(failed.payload.verifiedLocalFiles[0].path, fs.realpathSync(fullPath))
  assert.deepEqual(assistant.modelContext.verifiedLocalFiles, failed.payload.verifiedLocalFiles)
  assert.deepEqual(assistant.modelContext.retainedLocalFiles, [])
})

test('TurnEngine preserves an unverified successful write as a retained file on an incomplete turn', async () => {
  const turnId = 'retained-local-files-incomplete-turn'
  const relativePath = 'partial/retained.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<!doctype html>\n<title>written but pending verification</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const checkpointMessages = [
    assistantCall('retained-write', 'write_file', { path: relativePath, content }),
    toolResult('retained-write', 'write_file', {
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content),
    }),
  ]
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: checkpointMessages, artifactIds: [], iterations: 1 })
      return {
        incomplete: true,
        reason: 'post_mutation_verification_missing',
        text: 'The write succeeded but readback is pending.',
        artifactIds: [],
        deliveryArtifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    content: 'Update the file and verify it.',
  })
  await engine.waitForTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })

  const failed = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.failed')
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(failed.payload.code, 'TURN_INCOMPLETE')
  assert.deepEqual(failed.payload.verifiedLocalFiles, [])
  assert.equal(failed.payload.retainedLocalFiles.length, 1)
  assert.equal(failed.payload.retainedLocalFiles[0].path, fs.realpathSync(fullPath))
  assert.deepEqual(assistant.modelContext.retainedLocalFiles, failed.payload.retainedLocalFiles)
  assert.equal(assistant.modelContext.evidenceState, 'failed')
  assert.match(failed.payload.message, /已成功写入的本地修改会保留/)
})

test('TurnEngine keeps retained writes distinct from verified files in every remaining terminal state', async () => {
  const cases = [
    {
      name: 'completed',
      eventType: 'turn.completed',
      outcome: () => ({ text: 'Written; verification is still pending.', iterations: 1 }),
    },
    {
      name: 'interrupted',
      eventType: 'turn.interrupted',
      outcome: () => ({
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'provider unavailable',
        text: 'The write finished before interruption.',
        iterations: 1,
      }),
    },
    {
      name: 'paused',
      eventType: 'turn.paused',
      outcome: () => ({
        paused: true,
        text: 'Choose how to continue verification.',
        clarification: { question: 'Continue verification?' },
        iterations: 1,
      }),
    },
    {
      name: 'failed',
      eventType: 'turn.failed',
      outcome: () => {
        const error = new Error('verification service failed')
        error.code = 'VERIFY_FAILED'
        error.iterations = 1
        throw error
      },
    },
  ]

  for (const terminalCase of cases) {
    const turnId = `retained-local-files-${terminalCase.name}-turn`
    const relativePath = `terminal/${terminalCase.name}.html`
    const fullPath = path.join(workspace, relativePath)
    const content = `<title>${terminalCase.name} pending verification</title>`
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
    const mutationId = `${turnId}-write`
    const checkpointMessages = [
      assistantCall(mutationId, 'write_file', { path: relativePath, content }),
      toolResult(mutationId, 'write_file', {
        ok: true,
        path: relativePath,
        bytes: Buffer.byteLength(content),
      }),
    ]
    const engine = new TurnEngine({
      persistence: createTestTurnEnginePersistence(),
      scheduleMemoryExtraction: () => {},
      runLoop: async ({ saveCheckpoint }) => {
        await saveCheckpoint({ messages: checkpointMessages, artifactIds: [], iterations: 1 })
        return terminalCase.outcome()
      },
    })

    await engine.startTurn({
      userId: integrationUserId,
      sessionId: integrationSessionId,
      turnId,
      content: `Write the ${terminalCase.name} fixture.`,
    })
    await engine.waitForTurn({
      userId: integrationUserId,
      sessionId: integrationSessionId,
      turnId,
    })

    const terminal = listTurnEvents({
      requestedUser: integrationUserId,
      userId: integrationUserId,
      sessionId: integrationSessionId,
      turnId,
      limit: 100,
    }).find((event) => event.type === terminalCase.eventType)
    const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
      .find((message) => message.id === `${turnId}:assistant`)
    assert.ok(terminal, `${terminalCase.name} must emit ${terminalCase.eventType}`)
    assert.deepEqual(terminal.payload.verifiedLocalFiles, [])
    assert.equal(terminal.payload.retainedLocalFiles.length, 1)
    assert.equal(terminal.payload.retainedLocalFiles[0].path, fs.realpathSync(fullPath))
    assert.equal(Object.hasOwn(terminal.payload.retainedLocalFiles[0], 'verifiedAt'), false)
    assert.deepEqual(assistant.modelContext.verifiedLocalFiles, [])
    assert.deepEqual(assistant.modelContext.retainedLocalFiles, terminal.payload.retainedLocalFiles)
  }
})

test('TurnEngine persists retained writes when an active turn is cancelled', async () => {
  const turnId = 'retained-local-files-cancelled-turn'
  const relativePath = 'terminal/cancelled.html'
  const fullPath = path.join(workspace, relativePath)
  const content = '<title>cancelled pending verification</title>'
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  const checkpointMessages = [
    assistantCall('cancelled-write', 'write_file', { path: relativePath, content }),
    toolResult('cancelled-write', 'write_file', {
      ok: true,
      path: relativePath,
      bytes: Buffer.byteLength(content),
    }),
  ]
  let checkpointReady
  const ready = new Promise((resolve) => { checkpointReady = resolve })
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    scheduleMemoryExtraction: () => {},
    runLoop: async ({ saveCheckpoint, signal }) => {
      await saveCheckpoint({ messages: checkpointMessages, artifactIds: [], iterations: 1 })
      checkpointReady()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { text: 'unreachable' }
    },
  })

  await engine.startTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    content: 'Write, then wait before verification.',
  })
  await ready
  await engine.cancelTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })
  await engine.waitForTurn({ userId: integrationUserId, sessionId: integrationSessionId, turnId })

  const cancelled = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.cancelled')
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.deepEqual(cancelled.payload.verifiedLocalFiles, [])
  assert.equal(cancelled.payload.retainedLocalFiles.length, 1)
  assert.equal(cancelled.payload.retainedLocalFiles[0].path, fs.realpathSync(fullPath))
  assert.deepEqual(assistant.modelContext.retainedLocalFiles, cancelled.payload.retainedLocalFiles)
  assert.equal(assistant.modelContext.evidenceState, 'cancelled')
})

test('TurnEngine restores checkpoint-only retained files when a restarted worker cancels the turn', async () => {
  const turnId = 'retained-local-files-restarted-cancel-turn'
  const retainedRelativePath = 'terminal/restarted-cancel-retained.html'
  const verifiedRelativePath = 'terminal/restarted-cancel-verified.txt'
  const retainedFullPath = path.join(workspace, retainedRelativePath)
  const verifiedFullPath = path.join(workspace, verifiedRelativePath)
  const retainedContent = '<title>checkpoint-only retained write</title>'
  const verifiedContent = 'checkpoint verified write\n'
  fs.mkdirSync(path.dirname(retainedFullPath), { recursive: true })
  fs.writeFileSync(retainedFullPath, retainedContent, 'utf8')
  fs.writeFileSync(verifiedFullPath, verifiedContent, 'utf8')
  const checkpointMessages = [
    assistantCall('restarted-retained-write', 'write_file', {
      path: retainedRelativePath,
      content: retainedContent,
    }),
    toolResult('restarted-retained-write', 'write_file', {
      ok: true,
      path: retainedRelativePath,
      bytes: Buffer.byteLength(retainedContent),
    }),
    ...mutationAndReadMessages({
      mutationId: 'restarted-verified-write',
      mutationArgs: { path: verifiedRelativePath, content: verifiedContent },
      mutationResult: {
        ok: true,
        path: verifiedRelativePath,
        bytes: Buffer.byteLength(verifiedContent),
      },
      readId: 'restarted-verified-read',
      readPath: verifiedRelativePath,
      content: verifiedContent,
    }),
  ]
  appendTurnEvent({
    userId: integrationUserId,
    event: createTurnEvent({
      id: `${turnId}:started`,
      sessionId: integrationSessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'Write both files, then verify one.' },
      createdAt: 100,
    }),
  })
  appendTurnEvent({
    userId: integrationUserId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`,
      sessionId: integrationSessionId,
      turnId,
      sequence: 1,
      type: 'turn.checkpoint',
      payload: { storage: 'turn_checkpoints', checkpointVersion: 1 },
      createdAt: 200,
    }),
    checkpointState: {
      messages: checkpointMessages,
      artifactIds: [],
      iterations: 1,
    },
  })

  // A fresh engine has no in-memory active entry, and this worker cannot find
  // an active lease. The receipts therefore have to come from the durable
  // checkpoint rather than from a terminal/intermediate event payload.
  const restartedEngine = new TurnEngine({
    scheduleMemoryExtraction: () => {},
    executionLeases: {
      ownerId: 'restarted-cancel-worker',
      isActive: () => false,
      requestCancellation: () => false,
      claim: () => true,
      hold: () => () => {},
      owns: () => true,
    },
  })
  await restartedEngine.cancelTurn({
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
  })

  const cancelled = listTurnEvents({
    requestedUser: integrationUserId,
    userId: integrationUserId,
    sessionId: integrationSessionId,
    turnId,
    limit: 100,
  }).find((event) => event.type === 'turn.cancelled')
  const assistant = listMessages({ userId: integrationUserId, sessionId: integrationSessionId })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(cancelled.payload.retainedLocalFiles.length, 1)
  assert.equal(cancelled.payload.retainedLocalFiles[0].path, fs.realpathSync(retainedFullPath))
  assert.equal(cancelled.payload.verifiedLocalFiles.length, 1)
  assert.equal(cancelled.payload.verifiedLocalFiles[0].path, fs.realpathSync(verifiedFullPath))
  assert.equal(
    cancelled.payload.retainedLocalFiles.some((file) => file.path === fs.realpathSync(verifiedFullPath)),
    false,
  )
  assert.deepEqual(assistant.modelContext.retainedLocalFiles, cancelled.payload.retainedLocalFiles)
  assert.deepEqual(assistant.modelContext.verifiedLocalFiles, cancelled.payload.verifiedLocalFiles)
  assert.equal(assistant.modelContext.evidenceState, 'cancelled')
  assert.equal(assistant.modelContext.turnEvidence, true)
})
