import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  beginHtmlArtifactAssetInstall,
  discardStagedHtmlArtifactAssets,
  expandHtmlArtifactAssets,
  finishHtmlArtifactAssetInstall,
  getHtmlArtifactAsset,
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

test('managed HTML assets copy real media, hide source paths, and expand offline', () => {
  const portrait = source('portrait.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]))
  const movie = source('clip.mp4', Buffer.from('fixture-mp4'))
  const stage = stageHtmlArtifactAssets({
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

test('in-place revisions can replace one media item and retain another by id', () => {
  const revisedPortrait = source('revised.jpg', Buffer.from([0xff, 0xd8, 0xff, 9, 8, 7]))
  const originalMovie = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    assetId: 'movie',
  }).fullPath)
  const stage = stageHtmlArtifactAssets({
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

test('bundle install rollback restores the previous complete media set', () => {
  const previous = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    assetId: 'portrait',
  }).fullPath)
  const next = source('next.jpg', Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]))
  const transaction = beginHtmlArtifactAssetInstall(stageHtmlArtifactAssets({
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

test('empty replacement removes obsolete assets and invalid sources are rejected', () => {
  const empty = stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'gallery-artifact',
    existingArtifactId: 'gallery-artifact',
    parentFilename: 'gallery.html',
    requiredAssetIds: [],
  })
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(empty))
  assert.equal(getHtmlArtifactAsset({ artifactDirectory, artifactId: 'gallery-artifact', assetId: 'portrait' }), null)

  const unsupported = source('payload.html', '<script>alert(1)</script>')
  assert.throws(() => stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'unsupported',
    parentFilename: 'unsupported.html',
    requiredAssetIds: ['payload'],
    sources: [{ id: 'payload', sourcePath: unsupported }],
  }), /Unsupported HTML image\/audio\/video asset type/)
  assert.throws(() => stageHtmlArtifactAssets({
    artifactDirectory,
    artifactId: 'missing',
    parentFilename: 'missing.html',
    requiredAssetIds: ['missing'],
  }), /unavailable managed asset/)
})

test('hashing is chunked and offline expansion rejects dangerous repeated growth before reading media', () => {
  const payload = source('bounded.png', Buffer.alloc(1024 * 1024, 0x5a))
  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = function guardedReadFileSync(filePath, ...args) {
    if (path.extname(String(filePath)).toLowerCase() === '.png') {
      throw new Error('asset hashing must not read a whole media file into memory')
    }
    return originalReadFileSync.call(this, filePath, ...args)
  }
  let stage
  try {
    stage = stageHtmlArtifactAssets({
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

test('cleanup helpers never replace the original staging or tool error', () => {
  const originalRmSync = fs.rmSync
  fs.rmSync = () => { throw new Error('simulated cleanup failure') }
  try {
    assert.throws(() => stageHtmlArtifactAssets({
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
