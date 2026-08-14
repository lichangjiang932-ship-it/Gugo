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
const { appendTurnArtifact, getTurnArtifactByFilename, listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const {
  persistLocalToolArtifacts,
  runToolsLoop,
  SERVER_TOOL_SPECS,
} = await import('../server/services/toolLoopRuntime.js')
const {
  isLocalMutationCall,
  isReadOnlyPowerShellVerificationCall,
} = await import('../server/services/toolLoopHeuristics.js')

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
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'set_deliverables'
  ))
  assert.ok(archiveCreate)
  assert.ok(archiveList)
  assert.ok(setDeliverables)

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
    toolSpecs: [archiveCreate, archiveList, setDeliverables],
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
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-archive-call',
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [publishedResult.artifactId] }),
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

test('set_deliverables strictly scopes artifact ids, replaces selections, and preserves explicit empty delivery on resume', async () => {
  const currentTurnId = 'deliverable-selection-turn'
  const draftId = 'deliverable-draft'
  const finalId = 'deliverable-final'
  const crossTurnId = 'deliverable-cross-turn'
  const crossSessionId = 'deliverable-cross-session'
  const crossUserId = 'deliverable-cross-user'
  const append = ({ id, userId = 'artifact-user', sessionId = 'artifact-session', turnId = currentTurnId }) => (
    appendTurnArtifact({
      id,
      userId,
      sessionId,
      turnId,
      type: 'pdf',
      title: id,
      filename: `${id}.pdf`,
      url: `/api/artifacts/${id}.pdf`,
    })
  )

  upsertSession({ id: 'deliverable-other-session', userId: 'artifact-user', title: 'Other session' })
  createUser({ id: 'deliverable-other-user', email: 'deliverable-other@example.com' })
  upsertSession({ id: 'deliverable-other-user-session', userId: 'deliverable-other-user', title: 'Other user' })
  append({ id: draftId })
  append({ id: finalId })
  append({ id: crossTurnId, turnId: 'another-turn' })
  append({ id: crossSessionId, sessionId: 'deliverable-other-session' })
  append({
    id: crossUserId,
    userId: 'deliverable-other-user',
    sessionId: 'deliverable-other-user-session',
  })

  const setDeliverablesSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const readFileSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(setDeliverablesSpec)
  assert.ok(readFileSpec)

  const selections = []
  const checkpoints = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: currentTurnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Review the completed files and select the final deliverables.',
    },
    step: { id: currentTurnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Review the completed files and select the final deliverables.' }],
    intentMode: 'execute',
    toolSpecs: [readFileSpec, setDeliverablesSpec],
    maxIters: 8,
    enableToolHooks: false,
    requestToolApproval: async () => assert.fail('set_deliverables must not require approval'),
    loadCheckpoint: async () => ({
      state: { artifactIds: [draftId, finalId], iterations: 0 },
    }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async () => {
      modelCalls += 1
      const calls = {
        1: ['read-evidence', 'read_file', { path: 'README.md' }],
        2: ['reject-foreign', 'set_deliverables', { artifact_ids: [crossTurnId, crossSessionId, crossUserId] }],
        3: ['select-draft', 'set_deliverables', { artifact_ids: [draftId] }],
        4: ['replace-with-final', 'set_deliverables', { artifact_ids: [finalId] }],
        5: ['clear-delivery', 'set_deliverables', { artifact_ids: [] }],
      }
      const entry = calls[modelCalls]
      if (!entry) return { content: 'No files are intentionally delivered.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'read_file', 'set_deliverables must be handled by the scoped runtime control path')
      return { ok: true, path: 'README.md', content: 'evidence' }
    },
    onToolCompleted: async (outcome) => {
      if (outcome.call.name === 'set_deliverables') selections.push(outcome.result)
    },
  })

  assert.equal(selections[0].code, 'deliverable_artifact_scope_mismatch')
  assert.deepEqual(selections[0].invalidArtifactIds, [crossTurnId, crossSessionId, crossUserId])
  assert.deepEqual(selections.slice(1).map((selection) => selection.deliveryArtifactIds), [
    [draftId],
    [finalId],
    [],
  ])
  assert.deepEqual(result.artifactIds, [draftId, finalId])
  assert.ok(Object.hasOwn(result, 'deliveryArtifactIds'))
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.ok(checkpoints.some((state) => JSON.stringify(state.deliveryArtifactIds) === JSON.stringify([draftId])))
  assert.ok(checkpoints.some((state) => JSON.stringify(state.deliveryArtifactIds) === JSON.stringify([finalId])))
  assert.deepEqual(checkpoints.at(-1).deliveryArtifactIds, [])
})

test('created chat artifacts require an explicit set_deliverables call before normal completion', async () => {
  const turnId = 'deliverable-required-turn'
  const artifactId = 'deliverable-required-final'
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'pdf',
    title: 'Final report',
    filename: 'final-report.pdf',
    url: '/api/artifacts/final-report.pdf',
  })
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  let modelCalls = 0
  let guardObserved = false
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'What is the status of the generated report?',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'What is the status of the generated report?' }],
    intentMode: 'auto',
    toolSpecs: [setDeliverables],
    maxIters: 6,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [artifactId], iterations: 0 } }),
    saveCheckpoint: async () => true,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) return { content: 'The report is ready.', toolCalls: [] }
      if (modelCalls === 2) {
        guardObserved = messages.some((message) => String(message?.content || '').includes('[FINAL DELIVERABLE SELECTION REQUIRED]'))
        return {
          content: '',
          toolCalls: [{
            id: 'select-final-report',
            type: 'function',
            function: { name: 'set_deliverables', arguments: JSON.stringify({ artifact_ids: [artifactId] }) },
          }],
        }
      }
      return { content: 'The report is ready.', toolCalls: [] }
    },
  })

  assert.equal(guardObserved, true)
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  assert.equal(result.incomplete, undefined)
})

test('PowerShell readback does not revive workspace verification after final deliverables are selected', async () => {
  const turnId = 'powershell-readback-terminal-turn'
  const artifactId = 'powershell-readback-terminal-artifact'
  const outputPath = 'D:\\destok\\Gugo\\output\\execution-check.txt'
  const normalizedOutputPath = outputPath.replaceAll('\\', '/')
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'txt',
    title: 'Execution check',
    filename: 'execution-check.txt',
    url: '/api/artifacts/execution-check.txt',
  })
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const runProjectCheck = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'run_project_check')
  const calls = [
    ['write-output', 'bash_exec', {
      command: `powershell -NoProfile -Command "Set-Content -Path '${outputPath}' -Value 'EXECUTION_OK'"`,
      expected_outputs: [outputPath],
    }],
    ['powershell-readback', 'bash_exec', {
      command: `powershell -NoProfile -Command "Get-Content -Path '${outputPath}' -Raw"`,
      expected_outputs: [],
    }],
    ['powershell-hash', 'bash_exec', {
      command: `powershell -NoProfile -Command "(Get-FileHash -Path '${outputPath}' -Algorithm SHA256).Hash"`,
      expected_outputs: [],
    }],
    ['readback-file', 'read_file', { path: outputPath, offset: 0, limit: 0 }],
    ['select-output', 'set_deliverables', { artifact_ids: [artifactId] }],
  ]
  const checkpoints = []
  const executed = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Write, verify, and deliver the execution check file.',
      userPrompt: 'Write, verify, and deliver the execution check file.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Write, verify, and deliver the execution check file.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile, setDeliverables, runProjectCheck],
    maxIters: 10,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async () => {
      modelCalls += 1
      const entry = calls[modelCalls - 1]
      if (!entry) {
        assert.equal(modelCalls, 6, 'the turn must stop on the first final answer after set_deliverables')
        return { content: '验收完成，最终文件已交付。', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
    executeTool: async ({ name, args }) => {
      executed.push([name, args.command || args.path || ''])
      assert.notEqual(name, 'run_project_check', 'ordinary file readback must not require a project check')
      if (name === 'read_file') return { ok: true, path: outputPath, content: 'EXECUTION_OK' }
      if (String(args.command).includes('Set-Content')) {
        return {
          ok: true,
          exitCode: 0,
          cwd: 'D:\\destok\\Gugo',
          verifiedOutputs: [{ path: outputPath, status: 'created', type: 'file' }],
          changedPaths: [outputPath],
          artifactId,
          filename: 'execution-check.txt',
          url: '/api/artifacts/execution-check.txt',
        }
      }
      if (String(args.command).includes('Get-Content')) {
        return { ok: true, exitCode: 0, cwd: 'D:\\destok\\Gugo', stdout: 'EXECUTION_OK\r\n' }
      }
      return { ok: true, exitCode: 0, cwd: 'D:\\destok\\Gugo', stdout: 'ABC123\r\n' }
    },
  })

  assert.equal(modelCalls, 6)
  assert.equal(result.text, '验收完成，最终文件已交付。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  assert.equal(executed.some(([name]) => name === 'run_project_check'), false)
  assert.equal(checkpoints.some((state) => (
    state.completionGuards?.pendingMutationTargets?.includes('<workspace>')
  )), false)
  assert.deepEqual(checkpoints.at(-1)?.completionGuards?.pendingMutationTargets, [])
  assert.ok(checkpoints.some((state) => (
    state.completionGuards?.pendingMutationTargets?.includes(normalizedOutputPath)
  )))
})

test('PowerShell verification classification rejects mixed read and write scripts', () => {
  const readOnly = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt' -Raw\"" },
  }
  const mixed = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt'; Set-Content -Path 'result.txt' -Value changed\"" },
  }
  const aliasMutation = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt' | sc 'copy.txt'\"" },
  }
  assert.equal(isReadOnlyPowerShellVerificationCall(readOnly), true)
  assert.equal(isLocalMutationCall(readOnly), false)
  assert.equal(isReadOnlyPowerShellVerificationCall(mixed), false)
  assert.equal(isLocalMutationCall(mixed), true)
  assert.equal(isReadOnlyPowerShellVerificationCall(aliasMutation), false)
  assert.equal(isLocalMutationCall(aliasMutation), true)
})

test('creating another artifact after selection invalidates it and requires reconfirmation', async () => {
  const turnId = 'deliverable-dirty-turn'
  const draftId = 'deliverable-dirty-draft'
  const finalId = 'deliverable-dirty-final'
  appendTurnArtifact({
    id: draftId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'docx',
    title: 'Draft',
    filename: 'draft.docx',
    url: '/api/artifacts/draft.docx',
  })
  const createDocx = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_docx')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  let modelCalls = 0
  let guardObserved = false
  const checkpoints = []
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Create the final Word document.',
      userPrompt: 'Create the final Word document.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Create the final Word document.' }],
    intentMode: 'execute',
    toolSpecs: [createDocx, setDeliverables],
    maxIters: 8,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [draftId], iterations: 0 } }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      assert.equal(name, 'create_docx')
      appendTurnArtifact({
        id: finalId,
        userId: 'artifact-user',
        sessionId: 'artifact-session',
        turnId,
        type: 'docx',
        title: 'Final',
        filename: 'final.docx',
        url: '/api/artifacts/final.docx',
      })
      return { ok: true, artifactId: finalId, filename: 'final.docx', url: '/api/artifacts/final.docx' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      const calls = {
        1: ['select-draft-first', 'set_deliverables', { artifact_ids: [draftId] }],
        2: ['create-final-doc', 'create_docx', { title: 'Final', paragraphs: [{ text: 'done' }] }],
        4: ['reselect-final-doc', 'set_deliverables', { artifact_ids: [finalId] }],
      }
      if (modelCalls === 3) return { content: 'The final document is ready.', toolCalls: [] }
      if (modelCalls === 4) {
        guardObserved = messages.some((message) => String(message?.content || '').includes('[FINAL DELIVERABLE SELECTION REQUIRED]'))
      }
      const entry = calls[modelCalls]
      if (!entry) return { content: 'The final document is ready.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
  })

  assert.equal(guardObserved, true)
  assert.deepEqual(result.artifactIds, [draftId, finalId])
  assert.deepEqual(result.deliveryArtifactIds, [finalId])
  const invalidatedCheckpoint = checkpoints.find((state) => (
    JSON.stringify(state.artifactIds) === JSON.stringify([draftId, finalId])
    && state.completionGuards?.deliveryArtifactSelectionArtifactIds?.length === 0
  ))
  assert.ok(invalidatedCheckpoint, 'the invalidated selection must be checkpointed before reselection')
  assert.ok(Object.hasOwn(invalidatedCheckpoint, 'deliveryArtifactIds'))
  assert.deepEqual(invalidatedCheckpoint.deliveryArtifactIds, [])
})

test('refusing final artifact selection ends incomplete with explicit empty delivery', async () => {
  const turnId = 'deliverable-refused-turn'
  const artifactId = 'deliverable-refused-artifact'
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'png',
    title: 'Preview',
    filename: 'preview.png',
    url: '/api/artifacts/preview.png',
  })
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'What is the status of the generated preview?',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'What is the status of the generated preview?' }],
    intentMode: 'auto',
    toolSpecs: [setDeliverables],
    maxIters: 1,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [artifactId], iterations: 0 } }),
    saveCheckpoint: async () => true,
    runModel: async () => ({ content: 'Done.', toolCalls: [] }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'deliverable_selection_missing')
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.deepEqual(result.artifactIds, [artifactId])
})
