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
const {
  prepareOfficeArtifactImages,
  resolveOfficeArtifactImageInputs,
} = await import('../server/services/officeArtifactImages.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { setAllFilesAccess, setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')
const { createDefaultExecuteStep, JobRuntime } = await import('../server/services/jobRuntime.js')
const { buildInitialPlan } = await import('../server/services/jobPlanner.js')

const directImageOwner = issueTestSession().userId
setAllFilesAccess({ userId: directImageOwner, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })

function authorizedImages(placement = {}) {
  return resolveOfficeArtifactImageInputs([{ path: imagePath, ...placement }], { userId: directImageOwner })
}

const resolveTestModelBinding = () => ({
  providerId: null,
  modelName: 'office-images-test-model',
  configRevision: null,
  env: {
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'office-images-test-model',
  },
})

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
    userId: directImageOwner,
    slides: [{ title: 'Image slide', bullets: ['Real image'] }],
    images: authorizedImages({ alt: 'blue panel', target_index: 1 }),
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
    userId: directImageOwner,
    paragraphs: [{ text: 'Body' }],
    images: authorizedImages({ alt: 'blue panel', target_index: 1 }),
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
    userId: directImageOwner,
    sheets: [{ name: 'Data', rows: [['name', 'value'], ['a', 1]] }],
    images: authorizedImages({ alt: 'blue panel', target_index: 1, anchor: 'D2' }),
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
  await assert.rejects(
    () => createDocx({ title: 'forged', paragraphs: [{ text: 'x' }], images: [{ sourcePath: imagePath }] }),
    /not resolved through authorized local-file access/,
  )
})

test('office image authorization is bound to its user and cannot be replayed', async () => {
  const owner = issueTestSession().userId
  const otherUser = issueTestSession().userId
  setAllFilesAccess({ userId: owner, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const images = resolveOfficeArtifactImageInputs([{ path: imagePath }], { userId: owner })

  await assert.rejects(
    () => prepareOfficeArtifactImages(images, { userId: otherUser }),
    /belongs to a different user/,
  )
  const [prepared] = await prepareOfficeArtifactImages(images, { userId: owner })
  assert.ok(prepared.buffer.length > 0)
  await assert.rejects(
    () => prepareOfficeArtifactImages(images, { userId: owner }),
    /already been consumed/,
  )
})

test('office image authorization fails closed after access is revoked', async () => {
  const owner = issueTestSession().userId
  setAllFilesAccess({ userId: owner, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const images = resolveOfficeArtifactImageInputs([{ path: imagePath }], { userId: owner })
  setAllFilesAccess({ userId: owner, enabled: false })

  await assert.rejects(
    () => prepareOfficeArtifactImages(images, { userId: owner }),
  )
})

test('office image authorization rejects a file changed after resolution', async () => {
  const owner = issueTestSession().userId
  const changedPath = path.join(root, `changed-${Date.now()}.png`)
  fs.copyFileSync(imagePath, changedPath)
  setAllFilesAccess({ userId: owner, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const images = resolveOfficeArtifactImageInputs([{ path: changedPath }], { userId: owner })
  fs.writeFileSync(changedPath, 'changed after authorization')

  await assert.rejects(
    () => prepareOfficeArtifactImages(images, { userId: owner }),
    /changed after authorization/,
  )
})

test('office image authorization rejects a file changed while its open handle is being read', async () => {
  const owner = issueTestSession().userId
  const changedDuringReadPath = path.join(root, `changed-during-read-${Date.now()}.png`)
  fs.copyFileSync(imagePath, changedDuringReadPath)
  setAllFilesAccess({ userId: owner, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const images = resolveOfficeArtifactImageInputs([{ path: changedDuringReadPath }], { userId: owner })
  const canonicalTarget = fs.realpathSync(changedDuringReadPath)
  const originalOpen = fs.promises.open
  let interceptedRead = false

  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (path.resolve(String(args[0])) !== path.resolve(canonicalTarget)) return handle
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      async readFile(...readArgs) {
        const bytes = await handle.readFile(...readArgs)
        interceptedRead = true
        fs.writeFileSync(canonicalTarget, Buffer.alloc(bytes.length + 17, 0x41))
        return bytes
      },
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }

  try {
    await assert.rejects(
      () => prepareOfficeArtifactImages(images, { userId: owner }),
      /changed after authorization/,
    )
    assert.equal(interceptedRead, true, 'test must mutate the file inside the open-handle read window')
  } finally {
    fs.promises.open = originalOpen
  }
})

test('agent tool loop resolves all-files image input and produces a real embedded DOCX image', async () => {
  const { userId } = issueTestSession()
  const outputDirectory = path.join(root, 'output')
  setDefaultOutputDirectory({ userId, rootPath: outputDirectory })
  setAllFilesAccess({ userId, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  let calls = 0
  const runtime = new JobRuntime({
    modelBindingResolver: resolveTestModelBinding,
    planner: buildInitialPlan,
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
