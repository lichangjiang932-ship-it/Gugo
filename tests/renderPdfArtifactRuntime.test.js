import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PDFDocument, rgb } from 'pdf-lib'
import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-render-pdf-runtime-'))
const workspace = path.join(root, 'workspace')
const artifactDirectory = path.join(root, 'artifacts')
process.env.APP_DATA_DIR = path.join(root, 'data')
process.env.ARTIFACT_DIR = artifactDirectory
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'
fs.mkdirSync(workspace, { recursive: true })

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { createUser, closeDb } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('runToolsLoop records and delivers every page returned by render_pdf_pages', async () => {
  const userId = 'render-pdf-runtime-user'
  const sessionId = 'render-pdf-runtime-session'
  const turnId = 'render-pdf-runtime-turn'
  createUser({ id: userId, email: 'render-pdf-runtime@example.com' })
  upsertSession({ id: sessionId, userId, title: 'PDF render runtime' })

  const source = await PDFDocument.create()
  source.addPage([120, 80]).drawRectangle({ x: 0, y: 0, width: 120, height: 80, color: rgb(1, 0, 0) })
  source.addPage([140, 90]).drawRectangle({ x: 0, y: 0, width: 140, height: 90, color: rgb(0, 0, 1) })
  fs.writeFileSync(path.join(workspace, 'two-pages.pdf'), await source.save())

  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId,
      sessionId,
      origin: 'chat',
      prompt: '把 two-pages.pdf 转成图片，每一页都要交付',
      userPrompt: '把 two-pages.pdf 转成图片，每一页都要交付',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: '把 two-pages.pdf 转成图片，每一页都要交付' }],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const names = tools.map((spec) => spec?.function?.name)
      assert.equal(names.includes('generate_image'), false)
      assert.equal(names.includes('render_pdf_pages'), true)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'render-real-pages',
            type: 'function',
            function: {
              name: 'render_pdf_pages',
              arguments: JSON.stringify({ input: 'two-pages.pdf', dpi: 72, format: 'png' }),
            },
          }],
        }
      }
      const renderedMessage = messages.findLast((message) => message?.role === 'tool'
        && message?.name === 'render_pdf_pages')
      const rendered = JSON.parse(renderedMessage.content)
      assert.equal(rendered.artifactIds.length, 2)
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-real-pages',
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: rendered.artifactIds }),
            },
          }],
        }
      }
      return { content: '两页 PDF 已分别转换并交付。', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.equal(result.artifactIds.length, 2)
  assert.deepEqual(result.deliveryArtifactIds, result.artifactIds)
  const artifacts = listTurnArtifacts({ userId, sessionId, turnId })
  assert.equal(artifacts.length, 2)
  for (const [index, artifact] of artifacts.entries()) {
    const bytes = fs.readFileSync(path.join(artifactDirectory, artifact.filename))
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const metadata = await sharp(bytes).metadata()
    assert.deepEqual([metadata.width, metadata.height], index === 0 ? [120, 80] : [140, 90])
  }
})
