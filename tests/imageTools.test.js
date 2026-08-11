import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import sharp from 'sharp'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-image-tools-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

process.env.APP_DB_PATH = path.join(workspace, 'image-tools.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { closeDb } = await import('../server/db.js')
const { IMAGE_TOOL_SPECS, dispatchImageTool } = await import('../server/adapters/imageTools.js')

before(async () => {
  await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 4,
      background: { r: 30, g: 90, b: 180, alpha: 0.75 },
    },
  }).png().toFile(path.join(workspace, 'source image (原图).png'))
})

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('IMAGE_TOOL_SPECS advertises info and transform tools', () => {
  assert.deepEqual(
    IMAGE_TOOL_SPECS.map((item) => item.function.name),
    ['image_info', 'image_transform'],
  )
})

test('image_info reads real metadata through the authorized path resolver', async () => {
  const result = await dispatchImageTool('image_info', { path: 'source image (原图).png' })

  assert.equal(result.ok, true)
  assert.equal(result.path, 'source image (原图).png')
  assert.equal(result.format, 'png')
  assert.equal(result.width, 80)
  assert.equal(result.height, 60)
  assert.equal(result.channels, 4)
  assert.equal(result.hasAlpha, true)
})

test('image_transform resizes and converts format using a Windows-safe Unicode path', async () => {
  const output = '转换 结果 (1).jpg'
  const result = await dispatchImageTool('image_transform', {
    input_path: 'source image (原图).png',
    output_path: output,
    resize: { width: 32, height: 24, fit: 'fill' },
    format: 'jpeg',
    quality: 82,
  })

  assert.equal(result.ok, true)
  assert.equal(result.path, output)
  assert.equal(result.format, 'jpeg')
  assert.equal(result.width, 32)
  assert.equal(result.height, 24)
  assert.equal(result.created, true)
  const metadata = await sharp(path.join(workspace, output)).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.width, 32)
  assert.equal(metadata.height, 24)
  assert.equal(
    fs.readdirSync(workspace).some((name) => name.startsWith('.gugo-image-')),
    false,
  )
})

test('image_transform refuses to overwrite by default without changing the destination', async () => {
  const output = path.join(workspace, 'existing.png')
  await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } })
    .png()
    .toFile(output)
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')

  await assert.rejects(
    dispatchImageTool('image_transform', {
      input_path: 'source image (原图).png',
      output_path: 'existing.png',
      resize: { width: 10 },
    }),
    (error) => error?.code === 'IMAGE_OUTPUT_EXISTS' && error?.statusCode === 409,
  )

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')
  assert.equal(afterHash, beforeHash)
})

test('image_transform supports the complete transform chain', async () => {
  const output = 'complete-transform.webp'
  const result = await dispatchImageTool('image_transform', {
    input_path: 'source image (原图).png',
    output_path: output,
    rotate: 90,
    flip: true,
    flop: true,
    crop: { left: 5, top: 10, width: 40, height: 50 },
    resize: { width: 20, height: 10, fit: 'fill' },
    grayscale: true,
    blur: 0.5,
    sharpen: true,
    normalize: true,
    format: 'webp',
    quality: 75,
  })

  assert.equal(result.ok, true)
  assert.equal(result.format, 'webp')
  assert.equal(result.width, 20)
  assert.equal(result.height, 10)
  const metadata = await sharp(path.join(workspace, output)).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 20)
  assert.equal(metadata.height, 10)
})

test('image_transform can atomically replace its own input when overwrite is explicit', async () => {
  const filename = 'in-place overwrite.png'
  fs.copyFileSync(path.join(workspace, 'source image (原图).png'), path.join(workspace, filename))

  const result = await dispatchImageTool('image_transform', {
    input_path: filename,
    output_path: filename,
    resize: { width: 16, height: 12, fit: 'fill' },
    overwrite: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.overwritten, true)
  const metadata = await sharp(path.join(workspace, filename)).metadata()
  assert.equal(metadata.width, 16)
  assert.equal(metadata.height, 12)
})

test('image_transform rejects a destination outside the authorized workspace', async () => {
  await assert.rejects(
    dispatchImageTool('image_transform', {
      input_path: 'source image (原图).png',
      output_path: path.join('..', `outside-${crypto.randomUUID()}.png`),
      resize: { width: 10 },
    }),
    (error) => error?.statusCode === 403,
  )
})

test('image tools process a valid input larger than the read_file 5 MB ceiling', async () => {
  const width = 1600
  const height = 1200
  const pixels = Buffer.allocUnsafe(width * height * 3)
  crypto.randomFillSync(pixels)
  const bigPath = path.join(workspace, 'large-noise.png')
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toFile(bigPath)
  assert.ok(fs.statSync(bigPath).size > 5 * 1024 * 1024)

  const info = await dispatchImageTool('image_info', { path: 'large-noise.png' })
  assert.equal(info.width, width)
  assert.equal(info.height, height)
  const transformed = await dispatchImageTool('image_transform', {
    input_path: 'large-noise.png',
    output_path: 'large-noise-thumbnail.webp',
    resize: { width: 160, height: 120, fit: 'fill' },
    quality: 70,
  })
  assert.equal(transformed.ok, true)
  assert.equal(transformed.width, 160)
  assert.equal(transformed.height, 120)
})

test('image_transform honors an already-aborted signal and leaves no output', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    dispatchImageTool('image_transform', {
      input_path: 'source image (原图).png',
      output_path: 'cancelled.png',
    }, { signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  )
  assert.equal(fs.existsSync(path.join(workspace, 'cancelled.png')), false)
})
