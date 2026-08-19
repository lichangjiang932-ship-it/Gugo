import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
const testRoot = path.join(os.tmpdir(), `gugo-artifact-revision-${testToken}`)
process.env.APP_DATA_DIR = path.join(testRoot, 'data')
process.env.ARTIFACT_DIR = path.join(testRoot, 'artifacts')

const { createUser } = await import('../server/db.js')
const { createHtmlArtifact, getArtifactDir } = await import('../server/services/artifactGen.js')
const { readArtifactSourcePage } = await import('../server/services/artifactSourceStore.js')
const { createManagedAttachment } = await import('../server/services/managedAttachmentStore.js')
const { SERVER_TOOL_SPECS, runToolsLoop } = await import('../server/services/jobTools.js')
const { executeServerTool } = await import('../server/services/toolLoopHeuristics.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const {
  appendTurnArtifact,
  getTurnArtifactById,
  listSessionTurnArtifacts,
} = await import('../server/services/turnArtifactStore.js')

function createScope(label) {
  const userId = `artifact-revision-user-${label}-${testToken}`
  const sessionId = `artifact-revision-session-${label}-${testToken}`
  createUser({ id: userId, email: `${userId}@example.com` })
  upsertSession({ id: sessionId, userId, title: `Artifact revision ${label}` })
  return { userId, sessionId }
}

function binarySource(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return (async function* stream() { yield buffer })()
}

function createOriginalHtml({ label, source }) {
  const scope = createScope(label)
  const artifact = createHtmlArtifact({ title: `Original ${label}`, html: source })
  appendTurnArtifact({
    id: artifact.id,
    userId: scope.userId,
    sessionId: scope.sessionId,
    turnId: `previous-turn-${label}-${testToken}`,
    type: 'html',
    title: artifact.title,
    url: artifact.url,
    filename: artifact.filename,
  })
  return { ...scope, artifact }
}

function adjacentArtifactMessages({ artifact, prompt, originalSource }) {
  return [
    { role: 'user', content: '生成一个产品网页' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `previous-create-${artifact.id}`,
        function: {
          name: 'create_html_app',
          arguments: JSON.stringify({ title: artifact.title, html: originalSource }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: `previous-create-${artifact.id}`,
      name: 'create_html_app',
      content: JSON.stringify({
        ok: true,
        artifactId: artifact.id,
        filename: artifact.filename,
        url: artifact.url,
      }),
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `previous-deliver-${artifact.id}`,
        function: {
          name: 'set_deliverables',
          arguments: JSON.stringify({ artifact_ids: [artifact.id] }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: `previous-deliver-${artifact.id}`,
      name: 'set_deliverables',
      content: JSON.stringify({ ok: true, deliveryArtifactIds: [artifact.id] }),
    },
    { role: 'assistant', content: '网页已生成。' },
    { role: 'user', content: prompt },
  ]
}

function createdArtifactResult(messages, toolCallId) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'tool'
      || message?.name !== 'create_html_app'
      || message?.tool_call_id !== toolCallId) continue
    try {
      const result = JSON.parse(String(message.content || ''))
      return result
    } catch { /* keep searching */ }
  }
  return null
}

async function readArtifactSourceThroughTool({ userId, sessionId, artifactId, label }) {
  const pages = []
  let nextOffset = 0
  let observedError = null
  let sourceComplete = false
  let callNumber = 0
  const consumedToolCallIds = new Set()
  await runToolsLoop({
    job: {
      id: `source-read-turn-${label}-${testToken}`,
      userId,
      sessionId,
      origin: 'chat',
      prompt: '读取这个已生成产物的当前源码进行检查，不要修改文件。',
      userPrompt: '读取这个已生成产物的当前源码进行检查，不要修改文件。',
    },
    step: { id: `source-read-step-${label}-${testToken}`, kind: 'chat' },
    messages: [{ role: 'user', content: '读取这个已生成产物的当前源码进行检查，不要修改文件。' }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages }) => {
      const latest = messages.findLast((message) => (
        message?.role === 'tool' && message?.name === 'read_artifact_source'
      ))
      const latestId = String(latest?.tool_call_id || '')
      if (latest && !consumedToolCallIds.has(latestId)) {
        consumedToolCallIds.add(latestId)
        const result = JSON.parse(String(latest.content || '{}'))
        if (result.ok !== true) {
          observedError = result
          return { content: '读取失败。', toolCalls: [] }
        }
        if (result.offset === nextOffset) {
          pages.push(result.content)
          sourceComplete = result.complete === true
          nextOffset = result.complete ? result.totalChars : result.nextOffset
        }
      }
      if (observedError) return { content: '读取失败。', toolCalls: [] }
      if (sourceComplete) return { content: '源码读取完成。', toolCalls: [] }
      callNumber += 1
      return {
        content: '',
        toolCalls: [{
          id: `read-artifact-source-${label}-${callNumber}-${testToken}`,
          function: {
            name: 'read_artifact_source',
            arguments: JSON.stringify({
              artifact_id: artifactId,
              offset: nextOffset,
              limit: 16000,
            }),
          },
        }],
      }
    },
  })
  return { source: pages.join(''), error: observedError }
}

async function runHtmlRevision({
  label,
  prompt,
  originalSource,
  revisedSource,
  replaceOriginal,
  omitReplacementId = false,
}) {
  const scope = createOriginalHtml({ label, source: originalSource })
  const turnId = `revision-turn-${label}-${testToken}`
  const createCallId = `create-revision-${label}-${testToken}`
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: turnId, kind: 'chat' },
    messages: adjacentArtifactMessages({
      artifact: scope.artifact,
      prompt,
      originalSource,
    }),
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: createCallId,
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: `Revised ${label}`,
                html: revisedSource,
                ...(replaceOriginal && !omitReplacementId
                  ? { replace_artifact_id: scope.artifact.id }
                  : {}),
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        const created = createdArtifactResult(messages, createCallId)
        assert.equal(created?.ok, true, `artifact generation failed: ${JSON.stringify(created)}`)
        assert.ok(created?.artifactId, 'the real artifact tool result must expose an artifact ID')
        const deliveredId = String(created.artifactId)
        return {
          content: '',
          toolCalls: [{
            id: `deliver-revision-${label}-${testToken}`,
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [deliveredId] }),
            },
          }],
        }
      }
      return { content: '网页文件已按要求修改并验证。', toolCalls: [] }
    },
  })
  return { ...scope, result }
}

test('an explicit in-place HTML revision preserves artifact ID and filename', async () => {
  const originalSource = '<!doctype html><html><body><main data-version="original">Original</main></body></html>'
  const revisedSource = '<!doctype html><html><body><main data-version="blue-revision">Blue revision</main></body></html>'
  const { artifact, userId, sessionId, result } = await runHtmlRevision({
    label: 'replace',
    prompt: '不要新建，直接修改原文件，把配色改成蓝色',
    originalSource,
    revisedSource,
    replaceOriginal: true,
  })

  assert.deepEqual(result.artifactIds, [artifact.id])
  assert.deepEqual(result.deliveryArtifactIds, [artifact.id])
  const stored = getTurnArtifactById({ id: artifact.id, userId, sessionId })
  assert.equal(stored.filename, artifact.filename)
  assert.equal(fs.readFileSync(path.join(getArtifactDir(), artifact.filename), 'utf8'), revisedSource)
  const sourcePage = readArtifactSourcePage({ artifact: stored })
  assert.equal(sourcePage.sourceFormat, 'artifact_tool_arguments_json')
  assert.equal(JSON.parse(sourcePage.content).html, revisedSource)
  assert.equal(listSessionTurnArtifacts({ userId, sessionId }).length, 1)
})

test('an explicit in-place HTML revision infers the sole adjacent artifact ID when omitted', async () => {
  const originalSource = '<!doctype html><html><body><main data-version="original">Original</main></body></html>'
  const revisedSource = '<!doctype html><html><body style="background: lightblue"><main data-version="blue-revision">Original</main></body></html>'
  const { artifact, userId, sessionId, result } = await runHtmlRevision({
    label: 'replace-inferred-id',
    prompt: '修改刚才的原版文件，背景改成浅蓝色，不要新建版本',
    originalSource,
    revisedSource,
    replaceOriginal: true,
    omitReplacementId: true,
  })

  assert.deepEqual(result.artifactIds, [artifact.id])
  assert.deepEqual(result.deliveryArtifactIds, [artifact.id])
  const stored = getTurnArtifactById({ id: artifact.id, userId, sessionId })
  assert.equal(stored.filename, artifact.filename)
  assert.equal(fs.readFileSync(path.join(getArtifactDir(), artifact.filename), 'utf8'), revisedSource)
  assert.equal(listSessionTurnArtifacts({ userId, sessionId }).length, 1)
})

test('an adjacent webpage revision safely inlines an owned background-image attachment', async () => {
  const originalSource = '<!doctype html><html><body><main data-version="original">Original</main></body></html>'
  const scope = createOriginalHtml({ label: 'attachment-background', source: originalSource })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const attachment = await createManagedAttachment({
    userId: scope.userId,
    sessionId: scope.sessionId,
    name: 'portrait.png',
    mimeType: 'image/png',
    source: binarySource(png),
    contentLength: png.length,
  })
  const prompt = '把这张人物图作为背景'
  const turnId = `revision-turn-attachment-background-${testToken}`
  const createCallId = `create-attachment-background-${testToken}`
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: turnId, kind: 'chat' },
    messages: adjacentArtifactMessages({
      artifact: scope.artifact,
      prompt: `${prompt}\n[GUGO_MANAGED_ATTACHMENT uri="${attachment.uri}"]`,
      originalSource,
    }),
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        const names = tools.map((tool) => tool.function.name)
        for (const name of ['create_html_app', 'image_info', 'image_transform', 'read_artifact_source']) {
          assert.ok(names.includes(name), name)
        }
        assert.equal(names.includes('generate_image'), false)
        return {
          content: '',
          toolCalls: [{
            id: createCallId,
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Attachment background revision',
                html: `<!doctype html><html><head><style>body{background-image:url('${attachment.uri}');background-size:cover}</style></head><body><main>Updated</main></body></html>`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        const created = createdArtifactResult(messages, createCallId)
        assert.equal(created?.ok, true, JSON.stringify(created))
        return {
          content: '',
          toolCalls: [{
            id: `deliver-attachment-background-${testToken}`,
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [created.artifactId] }),
            },
          }],
        }
      }
      return { content: '人物图已直接加入网页背景并完成文件交付。', toolCalls: [] }
    },
  })

  assert.equal(result.artifactIds.length, 1)
  assert.deepEqual(result.deliveryArtifactIds, result.artifactIds)
  const artifact = getTurnArtifactById({
    id: result.artifactIds[0],
    userId: scope.userId,
    sessionId: scope.sessionId,
  })
  const deliveredHtml = fs.readFileSync(path.join(getArtifactDir(), artifact.filename), 'utf8')
  assert.match(deliveredHtml, /data:image\/png;base64,/)
  assert.doesNotMatch(deliveredHtml, /attachment:\/\//i)
  const sourceSnapshot = readArtifactSourcePage({ artifact })
  const sourceArgs = JSON.parse(sourceSnapshot.content)
  assert.match(sourceArgs.html, /data:image\/png;base64,/)
  assert.doesNotMatch(sourceArgs.html, /attachment:\/\//i)
})

test('HTML attachment inlining rejects unavailable, cross-user, and oversized images before creating files', async () => {
  const owner = createScope('attachment-rejection-owner')
  const outsider = createScope('attachment-rejection-outsider')
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const owned = await createManagedAttachment({
    userId: owner.userId,
    sessionId: owner.sessionId,
    name: 'private.png',
    mimeType: 'image/png',
    source: binarySource(image),
    contentLength: image.length,
  })
  const oversizedBytes = Buffer.alloc(1_600_000, 0x61)
  const oversized = await createManagedAttachment({
    userId: owner.userId,
    sessionId: owner.sessionId,
    name: 'oversized.jpg',
    mimeType: 'image/jpeg',
    source: binarySource(oversizedBytes),
    contentLength: oversizedBytes.length,
  })
  const artifactFilesBefore = new Set(fs.readdirSync(getArtifactDir()))
  const executeHtml = ({ userId, uri }) => executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Rejected attachment',
      html: `<!doctype html><html><body style="background-image:url('${uri}')"><main>Rejected</main></body></html>`,
    },
    job: { id: `attachment-rejection-${testToken}`, userId, origin: 'chat' },
    step: { id: `attachment-rejection-step-${testToken}`, kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
  })

  await assert.rejects(
    executeHtml({ userId: outsider.userId, uri: owned.uri }),
    /unavailable or not owned/i,
  )
  await assert.rejects(
    executeHtml({ userId: owner.userId, uri: 'attachment://missing-attachment-123' }),
    /unavailable or not owned/i,
  )
  await assert.rejects(
    executeHtml({ userId: owner.userId, uri: oversized.uri }),
    /too large to inline/i,
  )
  assert.deepEqual(new Set(fs.readdirSync(getArtifactDir())), artifactFilesBefore)
})

test('an explicit new-version HTML revision preserves the original and creates a new artifact', async () => {
  const originalSource = '<!doctype html><html><body><main data-version="original">Original</main></body></html>'
  const revisedSource = '<!doctype html><html><body><main data-version="green-copy">Green copy</main></body></html>'
  const { artifact, userId, sessionId, result } = await runHtmlRevision({
    label: 'copy',
    prompt: '保留原版，创建一个新版本，把配色改成绿色',
    originalSource,
    revisedSource,
    replaceOriginal: false,
  })

  assert.equal(result.artifactIds.length, 1)
  assert.notEqual(result.artifactIds[0], artifact.id)
  assert.deepEqual(result.deliveryArtifactIds, result.artifactIds)
  assert.equal(fs.readFileSync(path.join(getArtifactDir(), artifact.filename), 'utf8'), originalSource)
  const copy = getTurnArtifactById({ id: result.artifactIds[0], userId, sessionId })
  assert.ok(copy)
  assert.equal(fs.readFileSync(path.join(getArtifactDir(), copy.filename), 'utf8'), revisedSource)
  assert.equal(listSessionTurnArtifacts({ userId, sessionId }).length, 2)
})

test('read_artifact_source pages a legacy 70k HTML artifact without storing it in chat history', async () => {
  const tailMarker = '<!-- CURRENT_SOURCE_TAIL -->'
  const source = `<!doctype html><html><body>${'section-content-'.repeat(5_000)}${tailMarker}</body></html>`
  const scope = createOriginalHtml({ label: 'paged-source', source })
  const read = await readArtifactSourceThroughTool({
    userId: scope.userId,
    sessionId: scope.sessionId,
    artifactId: scope.artifact.id,
    label: 'paged-source',
  })

  assert.equal(read.error, null)
  const currentFileSource = fs.readFileSync(
    path.join(getArtifactDir(), scope.artifact.filename),
    'utf8',
  )
  assert.equal(read.source.length, currentFileSource.length)
  assert.equal(read.source, currentFileSource)
  assert.match(read.source, /CURRENT_SOURCE_TAIL/)
})

test('read_artifact_source rejects an artifact ID outside the current chat session', async () => {
  const owner = createOriginalHtml({
    label: 'source-owner',
    source: '<!doctype html><html><body>private source</body></html>',
  })
  const outsider = createScope('source-outsider')
  const read = await readArtifactSourceThroughTool({
    userId: outsider.userId,
    sessionId: outsider.sessionId,
    artifactId: owner.artifact.id,
    label: 'cross-session',
  })

  assert.equal(read.source, '')
  assert.equal(read.error?.code, 'artifact_source_not_found')
})

test('replace_artifact_id is rejected before execution without current-turn authorization', async () => {
  const originalSource = '<!doctype html><html><body><main>Original</main></body></html>'
  const prompt = '把配色改一下'
  const scope = createOriginalHtml({ label: 'unauthorized', source: originalSource })
  const messages = adjacentArtifactMessages({ artifact: scope.artifact, prompt, originalSource })
  let executions = 0
  let modelCalls = 0

  const result = await runToolsLoop({
      job: {
        id: `revision-turn-unauthorized-${testToken}`,
        userId: scope.userId,
        sessionId: scope.sessionId,
        origin: 'chat',
        prompt,
        userPrompt: prompt,
      },
      step: { id: `revision-turn-unauthorized-${testToken}`, kind: 'chat' },
      messages,
      toolSpecs: SERVER_TOOL_SPECS,
      maxIters: 2,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      executeTool: async () => {
        executions += 1
        return { ok: true }
      },
      runModel: async ({ messages: currentMessages }) => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `unauthorized-replace-${testToken}`,
              function: {
                name: 'create_html_app',
                arguments: JSON.stringify({
                  title: 'Unauthorized replacement',
                  html: '<!doctype html><html><body><main>Changed</main></body></html>',
                  replace_artifact_id: scope.artifact.id,
                }),
              },
            }],
          }
        }
        assert.ok(currentMessages.some((message) => (
          message?.role === 'tool'
            && String(message.content || '').includes('artifact_replacement_not_authorized')
        )))
        return { content: '无法完成。', toolCalls: [] }
      },
    })
  assert.equal(executions, 0)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'artifact_delivery_not_converged')
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.doesNotMatch(result.text, /The requested file was not created|ARTIFACT_NOT_CREATED/)
})
