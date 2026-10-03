import assert from 'node:assert/strict'
import test from 'node:test'
import { publishGitHubRelease } from '../scripts/release/publish-github-release.mjs'
import { ANNOTATED_TAG_SHA, COMMIT, REPOSITORY, TAG, UPLOADS_BASE_URL, createGitHubApi, publishOptions } from './helpers/githubReleasePublisherFixture.js'

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

test('declared unsigned notes replace a stale blocked draft only when verified assets are published', async (t) => {
  const notes = 'Windows build: unsigned. Verify checksums and provenance; these are not a signing certificate.'
  const api = createGitHubApi({
    release: { id: 42, tag_name: TAG, draft: true, prerelease: false, body: 'Draft blocked by missing certificate', target_commitish: 'old-main' },
    expectedReleaseNotes: notes,
  })
  await publishGitHubRelease({ ...publishOptions(t, api), releaseNotes: notes })
  assert.equal(api.state.release.body, notes)
  assert.equal(api.state.release.target_commitish, COMMIT)
  const patch = api.state.calls.findIndex(call => call.method === 'PATCH')
  const verification = api.state.calls.findLastIndex(call => call.method === 'GET' && call.url.includes('/assets?'))
  assert.ok(patch > verification && verification >= 0)
})

test('invalid release notes are rejected before any GitHub mutation', async (t) => {
  for (const releaseNotes of ['', ' ', {}, 'x'.repeat(24_001)]) {
    const api = createGitHubApi()
    await assert.rejects(publishGitHubRelease({ ...publishOptions(t, api), releaseNotes }), /release notes must/)
    assert.deepEqual(api.state.calls, [])
  }
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
      apiOptions: { publishOnReleaseRead: 1 },
      expectedUploads: 0,
      expectedDeletes: 0,
    },
    {
      name: 'conflicting asset deletion',
      apiOptions: {
        release: { id: 42, tag_name: TAG, draft: true, prerelease: false },
        assets: [{ id: 7, name: 'Gugo-Setup-1.2.3-x64.exe', size: 1 }],
        publishOnReleaseRead: 1,
      },
      expectedUploads: 0,
      expectedDeletes: 0,
    },
    {
      name: 'later upload',
      apiOptions: { publishOnReleaseRead: 2 },
      expectedUploads: 1,
      expectedDeletes: 0,
    },
    {
      name: 'final publish',
      apiOptions: { publishOnReleaseRead: 3 },
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
  const api = createGitHubApi({ replaceReleaseIdOnRead: 1 })
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
