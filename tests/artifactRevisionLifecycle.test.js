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
const { SERVER_TOOL_SPECS, runToolsLoop } = await import('../server/services/jobTools.js')
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

  await assert.rejects(
    runToolsLoop({
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
    }),
    (error) => error?.code === 'ARTIFACT_NOT_CREATED',
  )
  assert.equal(executions, 0)
})
