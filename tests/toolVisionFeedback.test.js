import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import sharp from 'sharp'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-vision-feedback-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

process.env.APP_DB_PATH = path.join(workspace, 'vision-feedback.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { closeDb } = await import('../server/db.js')
const { _testing } = await import('../server/services/toolLoopRuntime.js')

let pngPath
let jpegPath
before(async () => {
  await sharp({
    create: { width: 24, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toFile(path.join(workspace, 'tiny.png'))
  pngPath = path.join(workspace, 'tiny.png')
  await sharp({
    create: { width: 12, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).jpeg().toFile(path.join(workspace, 'frame.jpg'))
  jpegPath = path.join(workspace, 'frame.jpg')
})

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('image_transform result is annotated with a bounded base64 image and hides fullPath', async () => {
  const result = await _testing.attachVisionFeedback({
    name: 'image_transform',
    result: {
      ok: true,
      path: 'tiny.png',
      fullPath: pngPath,
      format: 'png',
      width: 24,
      height: 16,
    },
  })

  assert.equal(result.ok, true)
  assert.equal('fullPath' in result, false)
  assert.equal(result.image.mimeType, 'image/png')
  assert.equal(result.image.bytes > 0, true)
  assert.equal(typeof result.image.data, 'string')
  assert.ok(result.image.data.length > 0)
})

test('extract_frame media output is annotated from its file extension', async () => {
  const result = await _testing.attachVisionFeedback({
    name: 'media_transform',
    result: {
      ok: true,
      operation: 'extract_frame',
      output_path: 'frame.jpg',
      fullPath: jpegPath,
      bytes: 123,
    },
  })

  assert.equal(result.image.mimeType, 'image/jpeg')
  assert.equal('fullPath' in result, false)
})

test('non-image media outputs keep no image payload', async () => {
  const result = await _testing.attachVisionFeedback({
    name: 'media_transform',
    result: { ok: true, operation: 'transcode', output_path: 'clip.mp4', fullPath: path.join(workspace, 'clip.mp4') },
  })
  assert.equal(result.ok, true)
  assert.equal('image' in result, false)
  assert.equal('fullPath' in result, false)
})

test('generate_image buffers are annotated with an explicit mime type', async () => {
  const png = await fs.promises.readFile(pngPath)
  const result = await _testing.attachVisionFeedback({
    name: 'generate_image',
    buffer: png,
    result: { ok: true, artifactId: 'a1', filename: 'a1.png', imageMime: 'image/png' },
  })
  assert.equal(result.image.mimeType, 'image/png')
  assert.equal(result.image.bytes, png.length)
  assert.equal('imageMime' in result, false)
})

test('oversized images are stripped of fullPath but never embedded', async () => {
  const previous = process.env.VISION_FEEDBACK_MAX_BYTES
  process.env.VISION_FEEDBACK_MAX_BYTES = '32'
  try {
    const result = await _testing.attachVisionFeedback({
      name: 'image_transform',
      result: { ok: true, path: 'tiny.png', fullPath: pngPath, format: 'png' },
    })
    assert.equal(result.ok, true)
    assert.equal('image' in result, false)
    assert.equal('fullPath' in result, false)
  } finally {
    if (previous === undefined) delete process.env.VISION_FEEDBACK_MAX_BYTES
    else process.env.VISION_FEEDBACK_MAX_BYTES = previous
  }
})
