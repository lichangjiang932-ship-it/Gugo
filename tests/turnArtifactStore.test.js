import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-artifacts-'))
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = path.join(tempDir, 'artifacts')

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { getSessionSnapshot, upsertSession } = await import('../server/services/sessionStore.js')
const { getTurnArtifactByFilename, listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const {
  persistLocalToolArtifacts,
  runToolsLoop,
  SERVER_TOOL_SPECS,
} = await import('../server/services/toolLoopRuntime.js')

createUser({ id: 'artifact-user', email: 'turn-artifact@example.com' })
setApprovalMode({ userId: 'artifact-user', mode: 'bypass' })
upsertSession({ id: 'artifact-session', userId: 'artifact-user', title: 'Artifacts' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('chat TurnEngine persists generated files without a jobs-table foreign key', async () => {
  let calls = 0
  const engine = new TurnEngine({
    runModel: async () => {
      calls += 1
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'doc-call',
              function: { name: 'create_docx', arguments: JSON.stringify({ title: 'Turn Doc', paragraphs: [{ text: 'hello' }] }) },
            }],
          }
        : { content: '文档已生成。', toolCalls: [] }
    },
  })
  await engine.startTurn({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn', content: '生成 Word 文档',
  })
  await engine.waitForTurn({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  const artifacts = listTurnArtifacts({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].type, 'docx')
  assert.equal(getTurnArtifactByFilename(artifacts[0].filename).userId, 'artifact-user')
  assert.deepEqual(listTurnArtifacts({ userId: 'other-user', sessionId: 'artifact-session', turnId: 'artifact-turn' }), [])
  const assistant = getSessionSnapshot({ userId: 'artifact-user', sessionId: 'artifact-session' })
    .messages.find((message) => message.id === 'artifact-turn:assistant')
  assert.deepEqual(assistant.artifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url })), [{
    id: artifacts[0].id,
    filename: artifacts[0].filename,
    type: 'docx',
    url: artifacts[0].url,
  }])
})

test('/webpage creates a persisted self-contained HTML artifact for preview', async () => {
  let calls = 0
  const engine = new TurnEngine({
    runModel: async () => {
      calls += 1
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'html-call',
              function: {
                name: 'create_html_app',
                arguments: JSON.stringify({
                  title: '本地模型介绍',
                  html: '<!doctype html><html lang="zh-CN"><head><style>body{font-family:sans-serif}</style></head><body><main>本地模型介绍</main></body></html>',
                }),
              },
            }],
          }
        : { content: '网页已生成。', toolCalls: [] }
    },
  })
  await engine.startTurn({
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId: 'webpage-artifact-turn',
    content: '/webpage 帮我生成一个网页来介绍本地模型',
    skillIds: ['webpage'],
  })
  await engine.waitForTurn({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'webpage-artifact-turn',
  })

  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'webpage-artifact-turn',
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].type, 'html')
  assert.match(artifacts[0].filename, /\.html$/)
  const saved = fs.readFileSync(path.join(process.env.ARTIFACT_DIR, artifacts[0].filename), 'utf8')
  assert.match(saved, /<main>本地模型介绍<\/main>/)
})

test('archive_create publishes its ZIP as a downloadable turn artifact', async () => {
  const archivePath = path.join(tempDir, 'bundled-output.zip')
  fs.writeFileSync(archivePath, Buffer.from('PK\x03\x04test-archive'))
  const archiveCreate = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'archive_create'
  ))
  const archiveList = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'archive_list'
  ))
  assert.ok(archiveCreate)
  assert.ok(archiveList)

  let modelCalls = 0
  let publishedResult = null
  const result = await runToolsLoop({
    job: {
      id: 'archive-artifact-turn',
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Create a ZIP archive from the requested files.',
    },
    step: { id: 'archive-artifact-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create a ZIP archive from the requested files.' }],
    intentMode: 'execute',
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    toolSpecs: [archiveCreate, archiveList],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'archive-create-call',
            type: 'function',
            function: {
              name: 'archive_create',
              arguments: JSON.stringify({ inputs: ['source.txt'], output: archivePath }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        publishedResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        return {
          content: '',
          toolCalls: [{
            id: 'archive-list-call',
            type: 'function',
            function: {
              name: 'archive_list',
              arguments: JSON.stringify({ input: archivePath }),
            },
          }],
        }
      }
      return { content: 'The ZIP archive is ready.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'archive_create') {
        assert.equal(args.output, archivePath)
        return { ok: true, output: archivePath, format: 'zip', entries: 1 }
      }
      assert.equal(name, 'archive_list')
      assert.equal(args.input, archivePath)
      return { ok: true, input: archivePath, format: 'zip', entryCount: 1, entries: [] }
    },
  })

  assert.equal(result.text, 'The ZIP archive is ready.')
  assert.equal(result.artifactIds.length, 1)
  assert.equal(publishedResult.artifactId, result.artifactIds[0])
  assert.equal(publishedResult.filename, 'bundled-output.zip')
  assert.match(publishedResult.url, /^\/api\/artifacts\/bundled-output\.zip$/)
  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'archive-artifact-turn',
  })
  assert.deepEqual(artifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url })), [{
    id: result.artifactIds[0],
    filename: 'bundled-output.zip',
    type: 'zip',
    url: '/api/artifacts/bundled-output.zip',
  }])
})

test('verified write_file and bash_exec outputs keep Windows Unicode filenames as turn artifacts', () => {
  const outputDir = path.join(tempDir, '本地 输出')
  fs.mkdirSync(outputDir, { recursive: true })
  const textPath = path.join(outputDir, '授权结果.txt')
  const pdfPath = path.join(outputDir, '填写后 答题卡.pdf')
  const pngPath = path.join(outputDir, '第 1 页.png')
  fs.writeFileSync(textPath, 'INLINE_AUTH_RESUMED')
  fs.writeFileSync(pdfPath, '%PDF-1.4\nlocal output')
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const job = {
    id: 'local-output-turn',
    origin: 'chat',
    userId: 'artifact-user',
    sessionId: 'artifact-session',
  }
  const written = persistLocalToolArtifacts({
    call: { name: 'write_file', args: { path: textPath } },
    result: { ok: true, path: textPath, scope: 'grant' },
    job,
    step: null,
  })
  const executed = persistLocalToolArtifacts({
    call: { name: 'bash_exec', args: { cwd: outputDir } },
    result: {
      ok: true,
      cwd: outputDir,
      verifiedOutputs: [
        { path: pdfPath, declaredPath: pdfPath, scope: 'grant', type: 'file', status: 'created' },
        { path: pngPath, declaredPath: pngPath, scope: 'grant', type: 'file', status: 'created' },
      ],
    },
    job,
    step: null,
  })

  assert.deepEqual(written.map((artifact) => artifact.filename), ['授权结果.txt'])
  assert.deepEqual(executed.map((artifact) => artifact.filename), ['填写后 答题卡.pdf', '第 1 页.png'])
  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'local-output-turn',
  })
  assert.deepEqual(artifacts.map((artifact) => artifact.filename), [
    '授权结果.txt', '填写后 答题卡.pdf', '第 1 页.png',
  ])
  for (const artifact of artifacts) {
    assert.match(artifact.url, /^\/api\/artifacts\//)
    assert.equal(fs.existsSync(path.join(process.env.ARTIFACT_DIR, artifact.filename)), true)
  }
})
