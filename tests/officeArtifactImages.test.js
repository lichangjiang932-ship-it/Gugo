import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-office-images-'))
const artifactDirectory = path.join(root, 'artifacts')
const imagePath = path.join(root, 'source.png')
process.env.ARTIFACT_DIR = artifactDirectory
process.env.APP_DATA_DIR = path.join(root, 'data')

await sharp({
  create: {
    width: 80,
    height: 50,
    channels: 4,
    background: { r: 20, g: 110, b: 220, alpha: 1 },
  },
}).png().toFile(imagePath)

const { createDocx, createPptx, createXlsx } = await import('../server/services/artifactGen.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { setAllFilesAccess, setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')
const { createDefaultExecuteStep, JobRuntime } = await import('../server/services/jobRuntime.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

async function openArtifact(result) {
  return JSZip.loadAsync(fs.readFileSync(result.fullPath))
}

test('createPptx embeds authorized image bytes and slide relationships', async () => {
  const result = await createPptx({
    title: 'PPT image',
    slides: [{ title: 'Image slide', bullets: ['Real image'] }],
    images: [{ sourcePath: imagePath, alt: 'blue panel', target_index: 1 }],
  })
  const zip = await openArtifact(result)
  const media = Object.keys(zip.files).filter((name) => /^ppt\/media\/.+\.(?:png|jpe?g)$/i.test(name))
  assert.equal(result.imageCount, 1)
  assert.equal(media.length, 1)
  assert.ok((await zip.file('ppt/slides/slide1.xml').async('string')).includes('<p:pic>'))
  assert.match(await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string'), /relationships\/image/)
  assert.ok((await zip.file(media[0]).async('nodebuffer')).length > 0)
})

test('createDocx embeds image bytes, drawing markup, and image relationship', async () => {
  const result = await createDocx({
    title: 'DOCX image',
    paragraphs: [{ text: 'Body' }],
    images: [{ sourcePath: imagePath, alt: 'blue panel', target_index: 1 }],
  })
  const zip = await openArtifact(result)
  assert.equal(result.imageCount, 1)
  assert.ok(zip.file('word/media/image1.png'))
  assert.match(await zip.file('word/document.xml').async('string'), /<w:drawing>[\s\S]*r:embed="rId2"/)
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /relationships\/image[^>]+media\/image1\.png/)
  assert.ok((await zip.file('word/media/image1.png').async('nodebuffer')).length > 0)
})

test('createXlsx embeds image bytes with worksheet and drawing relationships', async () => {
  const result = await createXlsx({
    title: 'XLSX image',
    sheets: [{ name: 'Data', rows: [['name', 'value'], ['a', 1]] }],
    images: [{ sourcePath: imagePath, alt: 'blue panel', target_index: 1, anchor: 'D2' }],
  })
  const zip = await openArtifact(result)
  assert.equal(result.imageCount, 1)
  assert.ok(zip.file('xl/media/image1.png'))
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<drawing r:id="rId1"\/>/)
  assert.match(await zip.file('xl/worksheets/_rels/sheet1.xml.rels').async('string'), /relationships\/drawing/)
  assert.match(await zip.file('xl/drawings/drawing1.xml').async('string'), /<xdr:col>3<\/xdr:col>[\s\S]*<xdr:row>1<\/xdr:row>[\s\S]*r:embed="rId1"/)
  assert.match(await zip.file('xl/drawings/_rels/drawing1.xml.rels').async('string'), /relationships\/image[^>]+media\/image1\.png/)
  assert.ok((await zip.file('xl/media/image1.png').async('nodebuffer')).length > 0)
})

test('office generators reject raw unresolved model paths', async () => {
  await assert.rejects(
    () => createDocx({ title: 'unsafe', paragraphs: [{ text: 'x' }], images: [{ path: imagePath }] }),
    /not resolved through authorized local-file access/,
  )
})

test('agent tool loop resolves all-files image input and produces a real embedded DOCX image', async () => {
  const { userId } = issueTestSession()
  const outputDirectory = path.join(root, 'output')
  setDefaultOutputDirectory({ userId, rootPath: outputDirectory })
  setAllFilesAccess({ userId, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  let calls = 0
  const runtime = new JobRuntime({
    executeStep: createDefaultExecuteStep({
      runModelWithTools: async () => {
        calls += 1
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'office-image-docx',
              type: 'function',
              function: {
                name: 'create_docx',
                arguments: JSON.stringify({
                  title: 'Embedded image',
                  paragraphs: [{ text: 'The supplied image is embedded below.' }],
                  images: [{ path: imagePath, alt: 'blue panel', target_index: 1 }],
                }),
              },
            }],
          }
        }
        return { content: 'Word file created.', toolCalls: [] }
      },
    }),
  })

  const job = await runtime.createJob(`生成一份 Word 文档，把 ${imagePath} 插入其中`, { userId })
  await runtime.drain()
  const completed = runtime.getJob(job.id, { userId })
  assert.equal(completed.status, 'completed', completed.error || 'job did not complete')
  const artifact = completed.artifacts.find((entry) => entry.filename?.endsWith('.docx'))
  assert.ok(artifact)
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(artifactDirectory, artifact.filename)))
  assert.ok(zip.file('word/media/image1.png'))
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /relationships\/image/)
  assert.ok(fs.existsSync(path.join(outputDirectory, artifact.filename)), 'default-directory delivery should also exist')
})
