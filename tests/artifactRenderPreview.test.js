import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-preview-test-'))
process.env.ARTIFACT_DIR = TMP
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-preview-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { createPptx } = await import('../server/services/artifactGen.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

async function findLibreOffice() {
  try {
    const { stdout } = await execFileAsync('which', ['libreoffice'], { timeout: 3000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

const libreOfficePath = await findLibreOffice()

test('POST /api/artifacts/render-preview returns a PNG dataUrl', {
  skip: libreOfficePath ? false : 'libreoffice is not installed',
}, async () => {
  const { token, userId } = issueTestSession()
  const result = await createPptx({
    title: 'Preview Smoke',
    theme: 'ocean',
    slides: [
      { title: '封面' },
      { title: '章节', layout: 'section' },
    ],
    userId,
  })

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/artifacts/render-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ artifactPath: result.fullPath, page: 1 }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.match(body.dataUrl, /^data:image\/png;base64,/)
    assert.ok(body.dataUrl.split(',')[1].length > 1000, 'base64 PNG 应有实际内容')
    assert.equal(body.page, 1)
    assert.equal(body.renderer, 'libreoffice')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
})
