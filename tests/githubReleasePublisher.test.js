import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { publishGitHubRelease } from '../scripts/release/publish-github-release.mjs'

const API_BASE_URL = 'https://api.github.test'
const UPLOADS_BASE_URL = 'https://uploads.github.test'
const REPOSITORY = 'gugo-tests/release-fixture'
const TAG = 'v1.2.3'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const ANNOTATED_TAG_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'

function jsonResponse(status, value) {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readRequestBody(body) {
  if (typeof body === 'string') return Buffer.from(body)
  const chunks = []
  for await (const chunk of body || []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function createGitHubApi({
  release = null,
  assets = [],
  corruptVerification = false,
  omitVerificationState = false,
  publishOnReleaseRead = 0,
  replaceReleaseIdOnRead = 0,
  tagCommit = COMMIT,
  annotatedTag = false,
} = {}) {
  const state = {
    release: release ? { ...release } : null,
    assets: assets.map((asset) => ({ state: 'uploaded', ...asset })),
    calls: [],
    nextAssetId: 100,
    assetListReads: 0,
    releaseReads: 0,
  }

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method || 'GET'
    const authorization = new Headers(init.headers).get('Authorization')
    assert.equal(authorization, 'Bearer release-test-token')
    state.calls.push({ method, url: url.href, body: typeof init.body === 'string' ? init.body : null })

    if (url.origin === UPLOADS_BASE_URL && method === 'POST') {
      const bytes = await readRequestBody(init.body)
      const asset = {
        id: state.nextAssetId++,
        name: url.searchParams.get('name'),
        size: bytes.length,
        state: 'uploaded',
      }
      state.assets.push(asset)
      return jsonResponse(201, asset)
    }

    if (url.pathname === `/repos/${REPOSITORY}/git/ref/tags/${TAG}` && method === 'GET') {
      return tagCommit
        ? jsonResponse(200, {
          ref: `refs/tags/${TAG}`,
          object: annotatedTag
            ? { type: 'tag', sha: ANNOTATED_TAG_SHA }
            : { type: 'commit', sha: tagCommit },
        })
        : jsonResponse(404, { message: 'Not Found' })
    }
    if (url.pathname === `/repos/${REPOSITORY}/git/tags/${ANNOTATED_TAG_SHA}` && method === 'GET') {
      return annotatedTag
        ? jsonResponse(200, { object: { type: 'commit', sha: tagCommit } })
        : jsonResponse(404, { message: 'Not Found' })
    }

    const tagPath = `/repos/${REPOSITORY}/releases/tags/${TAG}`
    if (url.pathname === tagPath && method === 'GET') {
      state.releaseReads += 1
      if (state.release && state.releaseReads === publishOnReleaseRead) {
        state.release = { ...state.release, draft: false }
      }
      if (state.release && state.releaseReads === replaceReleaseIdOnRead) {
        state.release = { ...state.release, id: 43 }
      }
      return state.release
        ? jsonResponse(200, state.release)
        : jsonResponse(404, { message: 'Not Found' })
    }
    if (url.pathname === `/repos/${REPOSITORY}/releases` && method === 'POST') {
      const body = JSON.parse(init.body)
      assert.deepEqual(body, {
        tag_name: TAG,
        target_commitish: COMMIT,
        name: TAG,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      })
      state.release = { id: 42, tag_name: TAG, draft: true, prerelease: false }
      return jsonResponse(201, state.release)
    }
    if (url.pathname === `/repos/${REPOSITORY}/releases/42/assets` && method === 'GET') {
      state.assetListReads += 1
      const visibleAssets = state.assets.map((asset) => ({ ...asset }))
      if (corruptVerification && state.assetListReads > 1 && visibleAssets[0]) {
        visibleAssets[0].size += 1
      }
      if (omitVerificationState && state.assetListReads > 1 && visibleAssets[0]) {
        delete visibleAssets[0].state
      }
      return jsonResponse(200, visibleAssets)
    }
    const assetDelete = new RegExp(`^/repos/${REPOSITORY}/releases/assets/(\\d+)$`).exec(url.pathname)
    if (assetDelete && method === 'DELETE') {
      const id = Number(assetDelete[1])
      state.assets = state.assets.filter((asset) => asset.id !== id)
      return jsonResponse(204)
    }
    if (url.pathname === `/repos/${REPOSITORY}/releases/42` && method === 'PATCH') {
      assert.deepEqual(JSON.parse(init.body), { draft: false, prerelease: false })
      state.release = { ...state.release, draft: false, prerelease: false }
      return jsonResponse(200, state.release)
    }
    return jsonResponse(404, { message: `Unhandled ${method} ${url.pathname}` })
  }

  return { state, fetchImpl }
}

function createAssets(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-publisher-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installer = path.join(root, 'Gugo-Setup-1.2.3-x64.exe')
  const updater = path.join(root, 'latest.yml')
  fs.writeFileSync(installer, Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(updater, 'version: 1.2.3\n')
  return { root, files: [installer, updater] }
}

function publishOptions(t, api) {
  const fixture = createAssets(t)
  return {
    repository: REPOSITORY,
    tag: TAG,
    commit: COMMIT,
    files: fixture.files,
    token: 'release-test-token',
    fetchImpl: api.fetchImpl,
    apiBaseUrl: API_BASE_URL,
    uploadsBaseUrl: UPLOADS_BASE_URL,
  }
}

test('GitHub REST publisher creates a draft, verifies assets, then publishes it', async (t) => {
  const api = createGitHubApi()
  const result = await publishGitHubRelease(publishOptions(t, api))

  assert.equal(result.releaseId, 42)
  assert.equal(result.assets.length, 2)
  assert.equal(api.state.release.draft, false)
  const events = api.state.calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`)
  const create = events.indexOf(`POST /repos/${REPOSITORY}/releases`)
  const firstUpload = events.indexOf(`POST /repos/${REPOSITORY}/releases/42/assets`)
  const secondAssetRead = events.lastIndexOf(`GET /repos/${REPOSITORY}/releases/42/assets`)
  const publish = events.indexOf(`PATCH /repos/${REPOSITORY}/releases/42`)
  assert.ok(create >= 0 && create < firstUpload)
  assert.ok(firstUpload < secondAssetRead)
  assert.ok(secondAssetRead < publish)
})

test('GitHub REST publisher resumes a draft by replacing conflicting named assets', async (t) => {
  const api = createGitHubApi({
    release: { id: 42, tag_name: TAG, draft: true, prerelease: false },
    assets: [
      { id: 7, name: 'Gugo-Setup-1.2.3-x64.exe', size: 1 },
    ],
  })
  await publishGitHubRelease(publishOptions(t, api))

  assert.equal(api.state.assets.some((asset) => asset.id === 7), false)
  const deleteIndex = api.state.calls.findIndex(({ method }) => method === 'DELETE')
  const uploadIndex = api.state.calls.findIndex(({ method, url }) => (
    method === 'POST' && new URL(url).origin === UPLOADS_BASE_URL
  ))
  assert.ok(deleteIndex >= 0 && deleteIndex < uploadIndex)
})

test('GitHub REST publisher rejects unexpected draft assets without mutating the draft', async (t) => {
  const api = createGitHubApi({
    release: { id: 42, tag_name: TAG, draft: true, prerelease: false },
    assets: [{ id: 8, name: 'keep-me.txt', size: 9 }],
  })
  await assert.rejects(
    publishGitHubRelease(publishOptions(t, api)),
    /contains unexpected assets: keep-me\.txt/,
  )
  assert.equal(api.state.release.draft, true)
  assert.equal(api.state.calls.some(({ method }) => ['DELETE', 'PATCH'].includes(method)), false)
  assert.equal(api.state.calls.some(({ url }) => new URL(url).origin === UPLOADS_BASE_URL), false)
})

test('GitHub REST publisher refuses to mutate an already published release', async (t) => {
  const api = createGitHubApi({
    release: { id: 42, tag_name: TAG, draft: false, prerelease: false },
  })
  await assert.rejects(
    publishGitHubRelease(publishOptions(t, api)),
    /already exists and is immutable/,
  )
  assert.equal(api.state.calls.every(({ method }) => method === 'GET'), true)
})

test('GitHub REST publisher rechecks draft state before every mutation stage', async (t) => {
  const scenarios = [
    {
      name: 'first upload',
      apiOptions: { publishOnReleaseRead: 2 },
      expectedUploads: 0,
      expectedDeletes: 0,
    },
    {
      name: 'conflicting asset deletion',
      apiOptions: {
        release: { id: 42, tag_name: TAG, draft: true, prerelease: false },
        assets: [{ id: 7, name: 'Gugo-Setup-1.2.3-x64.exe', size: 1 }],
        publishOnReleaseRead: 2,
      },
      expectedUploads: 0,
      expectedDeletes: 0,
    },
    {
      name: 'later upload',
      apiOptions: { publishOnReleaseRead: 3 },
      expectedUploads: 1,
      expectedDeletes: 0,
    },
    {
      name: 'final publish',
      apiOptions: { publishOnReleaseRead: 4 },
      expectedUploads: 2,
      expectedDeletes: 0,
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const api = createGitHubApi(scenario.apiOptions)
      await assert.rejects(
        publishGitHubRelease(publishOptions(subtest, api)),
        /already exists and is immutable/,
      )
      const uploads = api.state.calls.filter(({ method, url }) => (
        method === 'POST' && new URL(url).origin === UPLOADS_BASE_URL
      ))
      const deletes = api.state.calls.filter(({ method }) => method === 'DELETE')
      assert.equal(api.state.release.draft, false)
      assert.equal(uploads.length, scenario.expectedUploads)
      assert.equal(deletes.length, scenario.expectedDeletes)
      assert.equal(api.state.calls.some(({ method }) => method === 'PATCH'), false)
    })
  }
})

test('GitHub REST publisher stops if the draft identity changes during publication', async (t) => {
  const api = createGitHubApi({ replaceReleaseIdOnRead: 2 })
  await assert.rejects(
    publishGitHubRelease(publishOptions(t, api)),
    /identity changed during publication/,
  )
  assert.equal(api.state.release.id, 43)
  assert.equal(api.state.release.draft, true)
  assert.equal(api.state.calls.some(({ method }) => ['DELETE', 'PATCH'].includes(method)), false)
  assert.equal(api.state.calls.some(({ url }) => new URL(url).origin === UPLOADS_BASE_URL), false)
})

test('GitHub REST publisher leaves the release as a draft when remote verification fails', async (t) => {
  const api = createGitHubApi({ corruptVerification: true })
  await assert.rejects(
    publishGitHubRelease(publishOptions(t, api)),
    /asset verification failed/,
  )
  assert.equal(api.state.release.draft, true)
  assert.equal(api.state.calls.some(({ method }) => method === 'PATCH'), false)
})

test('GitHub REST publisher requires every verified asset to be fully uploaded', async (t) => {
  const api = createGitHubApi({ omitVerificationState: true })
  await assert.rejects(
    publishGitHubRelease(publishOptions(t, api)),
    /is not fully uploaded/,
  )
  assert.equal(api.state.release.draft, true)
  assert.equal(api.state.calls.some(({ method }) => method === 'PATCH'), false)
})

test('GitHub REST publisher requires the remote tag to exist at the exact release commit', async (t) => {
  for (const [tagCommit, message] of [
    [null, /does not exist on GitHub/],
    ['abcdef0123456789abcdef0123456789abcdef01', /resolves to .* expected/],
  ]) {
    const api = createGitHubApi({ tagCommit })
    await assert.rejects(publishGitHubRelease(publishOptions(t, api)), message)
    assert.equal(api.state.release, null)
    assert.equal(api.state.calls.every(({ method }) => method === 'GET'), true)
  }
})

test('GitHub REST publisher resolves annotated tags before matching the release commit', async (t) => {
  const api = createGitHubApi({ annotatedTag: true })
  await publishGitHubRelease(publishOptions(t, api))
  assert.equal(api.state.release.draft, false)
  assert.equal(api.state.calls.some(({ method, url }) => (
    method === 'GET' && new URL(url).pathname === `/repos/${REPOSITORY}/git/tags/${ANNOTATED_TAG_SHA}`
  )), true)
})
