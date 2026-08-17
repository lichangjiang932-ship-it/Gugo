import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import {
  beginHtmlArtifactAssetInstall,
  discardStagedHtmlArtifactAssets,
  expandHtmlArtifactAssets,
  finishHtmlArtifactAssetInstall,
  getHtmlArtifactAsset,
  htmlArtifactAssetIds,
  htmlArtifactVisibleImageAssetIds,
  rollbackHtmlArtifactAssetInstall,
  stageHtmlArtifactAssets,
} from '../server/services/htmlArtifactAssets.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-html-assets-'))
const artifactDirectory = path.join(root, 'artifacts')
const sourceDirectory = path.join(root, 'sources')
fs.mkdirSync(artifactDirectory, { recursive: true })
fs.mkdirSync(sourceDirectory, { recursive: true })

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

function source(name, bytes) {
  const target = path.join(sourceDirectory, name)
  fs.writeFileSync(target, bytes)
  return target
}

async function rasterBytes(format = 'jpeg', { large = false } = {}) {
  const width = large ? 1024 : 2
  const height = large ? 1024 : 2
  const pixels = Buffer.alloc(width * height * 3)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31 + 17) % 256
  const image = sharp(pixels, { raw: { width, height, channels: 3 } })
  if (format === 'jpeg') return image.jpeg().toBuffer()
  if (format === 'png') return image.png({ compressionLevel: large ? 0 : 6 }).toBuffer()
  if (format === 'webp') return image.webp().toBuffer()
  if (format === 'avif') return image.avif().toBuffer()
  if (format === 'gif') return image.gif().toBuffer()
  throw new Error(`unsupported test raster format: ${format}`)
}

test('managed HTML assets copy real media, hide source paths, and expand offline', async () => {
  const portrait = source('portrait.jpg', await rasterBytes('jpeg'))
  const movie = source('clip.mp4', Buffer.from('fixture-mp4'))
  const stage = await stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    parentFilename: 'gallery.html',
    requiredAssetIds: ['portrait', 'movie'],
    sources: [
      { id: 'portrait', sourcePath: portrait },
      { id: 'movie', sourcePath: movie },
    ],
  })
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(stage))

  const image = getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'portrait' })
  const video = getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'movie' })
  assert.equal(image.mimeType, 'image/jpeg')
  assert.deepEqual(fs.readFileSync(image.fullPath), fs.readFileSync(portrait))
  assert.equal(video.mimeType, 'video/mp4')

  const expanded = expandHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    html: '<img src="gugo-asset://portrait"><video src="gugo-asset://movie"></video>',
  })
  assert.match(expanded, /src="data:image\/jpeg;base64,/)
  assert.match(expanded, /src="data:video\/mp4;base64,/)
  assert.doesNotMatch(expanded, /gugo-asset:\/\//)

  const manifestPath = path.join(path.dirname(image.fullPath), 'manifest.json')
  const manifestText = fs.readFileSync(manifestPath, 'utf8')
  assert.doesNotMatch(manifestText, new RegExp(root.replaceAll('\\', '\\\\'), 'i'))
  assert.doesNotMatch(manifestText, /sourcePath|[A-Za-z]:[\\/]/)
})

test('in-place revisions can replace one media item and retain another by id', async () => {
  const revisedPortrait = source('revised.jpg', await rasterBytes('jpeg'))
  const originalMovie = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    assetId: 'movie',
  }).fullPath)
  const stage = await stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    existingArtifactId: 'gallery-artifact',
    parentFilename: 'gallery.html',
    requiredAssetIds: ['portrait', 'movie'],
    sources: [{ id: 'portrait', sourcePath: revisedPortrait }],
  })
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(stage))

  assert.deepEqual(
    fs.readFileSync(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'portrait' }).fullPath),
    fs.readFileSync(revisedPortrait),
  )
  assert.deepEqual(
    fs.readFileSync(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'movie' }).fullPath),
    originalMovie,
  )
})

test('bundle install rollback restores the previous complete media set', async () => {
  const previous = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    assetId: 'portrait',
  }).fullPath)
  const next = source('next.jpg', await rasterBytes('jpeg'))
  const transaction = beginHtmlArtifactAssetInstall(await stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    existingArtifactId: 'gallery-artifact',
    parentFilename: 'gallery.html',
    requiredAssetIds: ['portrait'],
    sources: [{ id: 'portrait', sourcePath: next }],
  }))
  rollbackHtmlArtifactAssetInstall(transaction)
  assert.deepEqual(
    fs.readFileSync(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'portrait' }).fullPath),
    previous,
  )
  assert.ok(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'movie' }))
})

test('empty replacement removes obsolete assets and invalid sources are rejected', async () => {
  const empty = await stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    existingArtifactId: 'gallery-artifact',
    parentFilename: 'gallery.html',
    requiredAssetIds: [],
  })
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(empty))
  assert.equal(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'portrait' }), null)

  const unsupported = source('payload.html', '<script>alert(1)</script>')
  await assert.rejects(stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'unsupported',
    parentFilename: 'unsupported.html',
    requiredAssetIds: ['payload'],
    sources: [{ id: 'payload', sourcePath: unsupported }],
  }), /Unsupported HTML image\/audio\/video asset type/)
  await assert.rejects(stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'missing',
    parentFilename: 'missing.html',
    requiredAssetIds: ['missing'],
  }), /unavailable managed asset/)

  const disguisedImage = source('disguised.jpg', Buffer.from('this is not a JPEG image'))
  await assert.rejects(stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'disguised-image',
    parentFilename: 'disguised.html',
    requiredAssetIds: ['fake'],
    sources: [{ id: 'fake', sourcePath: disguisedImage }],
  }), (error) => error?.code === 'HTML_ASSET_CONTENT_INVALID')
})

test('plausible image signatures are rejected when pixels cannot be decoded', async () => {
  const corrupt = new Map([
    ['jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.from('not-a-jpeg')])],
    ['png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not-a-png')])],
    ['webp', Buffer.from('RIFF\x10\x00\x00\x00WEBPnot-a-webp', 'binary')],
    ['avif', Buffer.from('\x00\x00\x00\x18ftypavifnot-an-avif', 'binary')],
    ['gif', Buffer.from('GIF89anot-a-gif')],
    ['bmp', Buffer.from('BMnot-a-bitmap')],
  ])
  for (const [extension, bytes] of corrupt) {
    const filePath = source(`corrupt.${extension}`, bytes)
    await assert.rejects(stageHtmlArtifactAssets({
      artifactDirectory,
      artifactId: `corrupt-${extension}`,
      parentFilename: `corrupt-${extension}.html`,
      requiredAssetIds: ['media'],
      sources: [{ id: 'media', sourcePath: filePath }],
    }), (error) => error?.code === 'HTML_ASSET_CONTENT_INVALID', extension)
  }
})

test('managed asset ids come only from browser resource slots', () => {
  const html = `<!doctype html><html><head><style>
    /* .ignored { background: url(gugo-asset://css-comment); } */
    .hero { background-image: url("gugo-asset://css-image"); }
  </style></head><body>
    <!-- <img src="gugo-asset://html-comment"> -->
    <img src="gugo-asset://hero" srcset="gugo-asset://hero-small 1x, gugo-asset://hero-large 2x">
    <video poster="gugo-asset://poster"></video>
    <script>const ignored = "gugo-asset://javascript-string";</script>
  </body></html>`
  assert.deepEqual(htmlArtifactAssetIds(html), ['hero', 'hero-small', 'hero-large', 'poster', 'css-image'])
})

test('complete galleries count only visibly rendered image slots', () => {
  const html = `<!doctype html><html><head><style>
    .visible-card { background-image: url(gugo-asset://visible-background); }
    .missing-card { background-image: url(gugo-asset://unmatched-background); }
  </style></head><body>
    <img src="gugo-asset://visible-image">
    <img hidden src="gugo-asset://hidden-attribute">
    <section style="display:none"><img src="gugo-asset://hidden-parent"></section>
    <template><img src="gugo-asset://template-image"></template>
    <div class="visible-card"></div>
    <link rel="icon" href="gugo-asset://favicon-only">
  </body></html>`
  assert.deepEqual(htmlArtifactVisibleImageAssetIds(html), ['visible-image', 'visible-background'])
})

test('hashing is chunked and offline expansion rejects dangerous repeated growth before reading media', async () => {
  const pngPayload = await rasterBytes('png', { large: true })
  const payload = source('bounded.png', pngPayload)
  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = function guardedReadFileSync(filePath, ...args) {
    if (path.extname(String(filePath)).toLowerCase() === '.png') {
      throw new Error('asset hashing must not read a whole media file into memory')
    }
    return originalReadFileSync.call(this, filePath, ...args)
  }
  let stage
  try {
    stage = await stageHtmlArtifactAssets({
      artifactDirectory,
      artifactId: 'bounded-offline',
      parentFilename: 'bounded.html',
      requiredAssetIds: ['media'],
      sources: [{ id: 'media', sourcePath: payload }],
    })
  } finally {
    fs.readFileSync = originalReadFileSync
  }
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(stage))

  const repeated = Array.from({ length: 100 }, () => '<img src="gugo-asset://media">').join('')
  assert.throws(() => expandHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'bounded-offline',
    html: repeated,
  }), (error) => error?.code === 'HTML_ASSET_OFFLINE_TOO_LARGE' && /128 MB/.test(error.message))
})

test('cleanup helpers never replace the original staging or tool error', async () => {
  const originalRmSync = fs.rmSync
  fs.rmSync = () => { throw new Error('simulated cleanup failure') }
  try {
    await assert.rejects(stageHtmlArtifactAssets({
      artifactDirectory,
      artifactId: 'preserve-original-error',
      parentFilename: 'failure.html',
      requiredAssetIds: ['missing'],
    }), (error) => error?.code === 'HTML_ASSET_UNDECLARED')
    assert.equal(rollbackHtmlArtifactAssetInstall({
      installed: true,
      targetDirectory: path.join(artifactDirectory, 'cleanup-target'),
      stageDirectory: path.join(artifactDirectory, 'cleanup-stage'),
    }), false)
    assert.equal(discardStagedHtmlArtifactAssets({
      stageDirectory: path.join(artifactDirectory, 'cleanup-stage'),
    }), false)
  } finally {
    fs.rmSync = originalRmSync
  }
})
