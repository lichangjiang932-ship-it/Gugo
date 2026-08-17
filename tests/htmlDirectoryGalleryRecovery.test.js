import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-html-gallery-recovery-'))
process.env.APP_DATA_DIR = path.join(root, 'data')
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')

const { closeDb, createUser } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { getArtifactDir } = await import('../server/services/artifactGen.js')
const {
  expandHtmlArtifactAssets,
  getHtmlArtifactAsset,
  htmlArtifactAssetIds,
} = await import('../server/services/htmlArtifactAssets.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { getTurnArtifactById } = await import('../server/services/turnArtifactStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

async function createJpegFixtures(directory, count) {
  fs.mkdirSync(directory, { recursive: true })
  const files = []
  for (let index = 0; index < count; index += 1) {
    const filename = `photo-${String(index + 1).padStart(2, '0')}.jpg`
    const fullPath = path.join(directory, filename)
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: {
          r: (index * 31) % 255,
          g: (index * 53) % 255,
          b: (index * 79) % 255,
        },
      },
    }).jpeg().toFile(fullPath)
    files.push({ filename, fullPath, id: `photo_${String(index + 1).padStart(2, '0')}` })
  }
  return files
}

test('a failed local-path gallery call self-corrects, bundles every JPG, and exposes only the verified HTML', async () => {
  const userId = 'gallery-recovery-user'
  const sessionId = 'gallery-recovery-session'
  const turnId = 'gallery-recovery-turn'
  const sourceDirectory = path.join(root, 'input-gallery')
  const outputDirectory = path.join(root, 'explicit-output')
  const fixtures = await createJpegFixtures(sourceDirectory, 41)
  createUser({ id: userId, email: 'gallery-recovery@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Gallery recovery' })
  setApprovalMode({ userId, mode: 'bypass' })

  const prompt = `读取 ${sourceDirectory} 中全部 JPG，生成图片网站并保存到 ${outputDirectory}`
  const calls = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId,
      sessionId,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    maxIters: 8,
    enableToolHooks: false,
    runModel: async ({ messages, toolChoice }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'invalid-local-html',
            type: 'function',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Broken gallery draft',
                output_directory: outputDirectory,
                html: `<!doctype html><html><body><img src="file:///${fixtures[0].fullPath.replaceAll('\\', '/')}"></body></html>`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => (
          message?.role === 'tool'
            && /local disk path|gugo-asset:\/\//i.test(String(message.content || ''))
        )))
        return {
          content: '',
          toolCalls: [{
            id: 'scan-gallery-directory',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: sourceDirectory, limit: 500 }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        assert.ok(messages.some((message) => (
          message?.role === 'tool'
            && message?.name === 'list_directory'
            && String(message.content || '').includes('photo-41.jpg')
        )))
        const imageMarkup = fixtures
          .map(({ id, filename }) => `<figure><img src="gugo-asset://${id}" alt="${filename}"><figcaption>${filename}</figcaption></figure>`)
          .join('')
        return {
          content: '',
          toolCalls: [{
            id: 'corrected-gallery-html',
            type: 'function',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Complete gallery',
                output_directory: outputDirectory,
                asset_collection: {
                  directory: sourceDirectory,
                  extensions: ['jpg'],
                  recursive: true,
                },
                assets: fixtures.map(({ id, fullPath }) => ({ id, path: fullPath })),
                html: `<!doctype html><html><body><main>${imageMarkup}</main></body></html>`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        assert.equal(toolChoice, undefined)
        const artifactId = JSON.parse(messages.findLast((message) => (
          message?.role === 'tool' && message?.name === 'create_html_app'
        )).content).artifactId
        return {
          content: '',
          toolCalls: [{
            id: 'select-verified-gallery',
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [artifactId] }),
            },
          }],
        }
      }
      return { content: '图片网站已生成并验证。', toolCalls: [] }
    },
    onToolCall: async (call) => calls.push(call),
  })

  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.equal(result.text, '图片网站已生成并验证。')
  assert.equal(modelCalls, 5)
  assert.deepEqual(calls.map((call) => call.name), [
    'create_html_app',
    'list_directory',
    'create_html_app',
    'set_deliverables',
  ])
  assert.equal(result.deliveryArtifactIds.length, 1)

  const artifactId = result.deliveryArtifactIds[0]
  const artifact = getTurnArtifactById({ id: artifactId, userId, sessionId })
  assert.ok(artifact)
  const managedPath = path.join(getArtifactDir(), artifact.filename)
  const managedHtml = fs.readFileSync(managedPath, 'utf8')
  const referencedIds = htmlArtifactAssetIds(managedHtml)
  assert.equal(referencedIds.length, fixtures.length)
  assert.equal(new Set(referencedIds).size, fixtures.length)
  assert.doesNotMatch(managedHtml, /file:\/\/\/|(?:^|[\s"'(>])[A-Za-z]:[\\/]/)

  for (const fixture of fixtures) {
    const bundled = getHtmlArtifactAsset({
      artifactDirectory: getArtifactDir(),
      artifactId,
      assetId: fixture.id,
    })
    assert.ok(bundled)
    assert.deepEqual(fs.readFileSync(bundled.fullPath), fs.readFileSync(fixture.fullPath))
  }

  const deliveredPath = path.join(outputDirectory, artifact.filename)
  assert.equal(fs.existsSync(deliveredPath), true)
  const offlineHtml = fs.readFileSync(deliveredPath, 'utf8')
  assert.equal((offlineHtml.match(/data:image\/jpeg;base64,/g) || []).length, fixtures.length)
  assert.doesNotMatch(offlineHtml, /gugo-asset:\/\/|file:\/\/\/|(?:^|[\s"'(>])[A-Za-z]:[\\/]/)
  assert.doesNotThrow(() => expandHtmlArtifactAssets({
    artifactDirectory: getArtifactDir(),
    artifactId,
    html: managedHtml,
  }))
})
