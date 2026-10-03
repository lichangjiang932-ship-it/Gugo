import assert from 'node:assert/strict'
import test from 'node:test'
import { publishGitHubRelease } from '../scripts/release/publish-github-release.mjs'
import { COMMIT, REPOSITORY, TAG, UPLOADS_BASE_URL, assetMutations, createGitHubApi, draft, jsonResponse, publishOptions } from './helpers/githubReleasePublisherFixture.js'

const unrelated = (count = 100, start = 1000) => Array.from({ length: count }, (_, index) => (
  draft({ id: start + index, tag_name: `v0.0.${start + index}`, draft: false })
))
const noWrites = (state) => assert.equal(state.calls.every((call) => call.method === 'GET'), true)
const uploads = (state) => state.calls.filter((call) => call.method === 'POST' && new URL(call.url).origin === UPLOADS_BASE_URL)
const patches = (state) => state.calls.filter((call) => call.method === 'PATCH')

test('a draft hidden by the tag endpoint is discovered in the release list and reused by fixed ID', async (t) => {
  const api = createGitHubApi({ release: draft() })
  const result = await publishGitHubRelease(publishOptions(t, api))
  assert.equal(result.releaseId, 42)
  const paths = api.state.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
  const tagRead = paths.indexOf(`GET /repos/${REPOSITORY}/releases/tags/${TAG}`)
  const listRead = paths.indexOf(`GET /repos/${REPOSITORY}/releases`)
  assert.ok(tagRead >= 0 && listRead > tagRead)
  assert.equal(paths.includes(`POST /repos/${REPOSITORY}/releases`), false, 'the existing draft must not be duplicated')
  assert.ok(api.state.releaseReads >= 3)
  assert.ok(api.state.releaseScans >= api.state.releaseReads + 1, 'each mutation rechecks discovery consistency')
})

test('release discovery traverses full pages to find the exact tag on page two', async (t) => {
  const api = createGitHubApi({
    release: draft(),
    releaseListResponse: ({ state, page }) => jsonResponse(200, page === 1 ? unrelated() : [state.release]),
  })
  const result = await publishGitHubRelease(publishOptions(t, api))
  assert.equal(result.releaseId, 42)
  assert.deepEqual(api.state.releasePagesRead.filter((entry) => entry.scan === 1).map((entry) => entry.page), [1, 2])
  assert.equal(api.state.calls.some((call) => call.method === 'POST' && new URL(call.url).pathname === `/repos/${REPOSITORY}/releases`), false)
})

test('finding a draft does not stop the scan before later duplicate or published matches', async (t) => {
  for (const [name, collision, message] of [
    ['another draft', draft({ id: 43 }), /multiple releases.*tag/iu],
    ['duplicate row for same ID', draft(), /multiple releases.*tag/iu],
    ['published release', draft({ id: 43, draft: false }), /immutable/iu],
  ]) await t.test(name, async (subtest) => {
    const api = createGitHubApi({ release: draft(), releaseListResponse: ({ state, page }) => (
      jsonResponse(200, page === 1 ? [state.release, ...unrelated(99)] : [collision])
    ) })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), message)
    assert.deepEqual(api.state.releasePagesRead.map((entry) => entry.page), [1, 2])
    noWrites(api.state)
  })
})

test('multiple same-page matches fail closed before any remote mutation', async (t) => {
  const api = createGitHubApi({ release: draft(), extraReleases: [draft({ id: 43 })] })
  await assert.rejects(publishGitHubRelease(publishOptions(t, api)), /multiple releases.*tag/iu)
  noWrites(api.state)
})

test('list errors, invalid JSON and invalid list shapes are not treated as draft absence', async (t) => {
  const scenarios = [
    ['403', () => jsonResponse(403, { message: 'Forbidden' }), /HTTP 403/u],
    ['500', () => jsonResponse(500, { message: 'Unavailable' }), /HTTP 500/u],
    ['transport failure', () => { throw new Error('fixture disconnected') }, /fixture disconnected/u],
    ['invalid JSON', () => new Response('invalid-json', { status: 200 }), /invalid JSON/iu],
    ['object', () => jsonResponse(200, { releases: [] }), /invalid release list/iu],
    ['null', () => jsonResponse(200, null), /invalid release list/iu],
    ['oversized page', () => jsonResponse(200, unrelated(101)), /invalid release list/iu],
    ['invalid matching ID', () => jsonResponse(200, [draft({ id: 0 })]), /invalid release identity/iu],
    ['missing draft state', () => jsonResponse(200, [draft({ draft: undefined })]), /without draft state/iu],
  ]
  for (const [name, releaseListResponse, message] of scenarios) await t.test(name, async (subtest) => {
    const api = createGitHubApi({ releaseListResponse })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), message)
    noWrites(api.state)
    assert.equal(api.state.release, null)
  })
})

test('a later page failure after a match still blocks publication', async (t) => {
  const api = createGitHubApi({ release: draft(), releaseListResponse: ({ state, page }) => page === 1
    ? jsonResponse(200, [state.release, ...unrelated(99)]) : jsonResponse(503, { message: 'Unavailable' }) })
  await assert.rejects(publishGitHubRelease(publishOptions(t, api)), /HTTP 503/u)
  noWrites(api.state)
})

test('a full 20-page scan fails at the explicit bound with or without an early match', async (t) => {
  for (const found of [false, true]) await t.test(found ? 'match on first page' : 'no match', async (subtest) => {
    const api = createGitHubApi({ release: found ? draft() : null, releaseListResponse: ({ state, page }) => (
      jsonResponse(200, found && page === 1 ? [state.release, ...unrelated(99)] : unrelated(100, page * 1000))
    ) })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), /too many releases.*safely/iu)
    assert.equal(api.state.releaseListReads, 20)
    assert.deepEqual(api.state.releasePagesRead.map((entry) => entry.page), Array.from({ length: 20 }, (_, index) => index + 1))
    noWrites(api.state)
  })
})

test('a tag endpoint exposing a draft still requires a unique matching list identity', async (t) => {
  const valid = createGitHubApi({ release: draft(), exposeDraftAtTag: true })
  assert.equal((await publishGitHubRelease(publishOptions(t, valid))).releaseId, 42)
  assert.ok(valid.state.releaseListReads > 0)
  for (const [name, listed] of [['missing from list', []], ['different ID', [draft({ id: 43 })]]]) {
    await t.test(name, async (subtest) => {
      const api = createGitHubApi({ release: draft(), exposeDraftAtTag: true, releaseListResponse: () => jsonResponse(200, listed) })
      await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), /identity changed/iu)
      noWrites(api.state)
    })
  }
})

test('fixed-ID disappearance, replacement, retagging or publication never retargets a mutation', async (t) => {
  const scenarios = [
    ['missing ID', { removeReleaseOnRead: 1 }, /no longer exists/iu],
    ['different ID receipt', { replaceReleaseIdOnRead: 1 }, /identity changed/iu],
    ['retagged ID', { retagOnReleaseRead: 1 }, /returned release tag.*instead/iu],
    ['already published ID', { publishOnReleaseRead: 1 }, /immutable/iu],
    ['immutable draft ID', { immutableOnReleaseRead: 1 }, /immutable/iu],
    ['ID read unavailable', { releaseIdResponse: () => jsonResponse(500, { message: 'Unavailable' }) }, /HTTP 500/u],
  ]
  for (const [name, options, message] of scenarios) await t.test(name, async (subtest) => {
    const api = createGitHubApi({ release: draft(), assets: [{ id: 7, name: 'Gugo-Setup-1.2.3-x64.exe', size: 1 }], ...options })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), message)
    assert.deepEqual(assetMutations(api.state), [])
    assert.equal(api.state.assets[0].id, 7)
    assert.equal(api.state.calls.some((call) => /\/releases\/43(?:\/|$)/u.test(new URL(call.url).pathname)), false)
  })
})

test('a live fixed ID cannot override missing or changed list identity before a write', async (t) => {
  for (const [name, changedList] of [['missing', []], ['replacement', [draft({ id: 43 })]]]) {
    await t.test(name, async (subtest) => {
      const api = createGitHubApi({ release: draft(), releaseListResponse: ({ state }) => (
        jsonResponse(200, state.releaseReads ? changedList : [state.release])
      ) })
      await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), /identity changed/iu)
      assert.deepEqual(assetMutations(api.state), [])
      assert.equal(api.state.release.id, 42)
    })
  }
})

test('new same-tag drafts or published identities are detected at every mutation boundary', async (t) => {
  const scenarios = [
    { name: 'duplicate after creation', options: { onCreateDraft: (state) => state.extraReleases.push(draft({ id: 43 })) }, expectedUploads: 0, message: /multiple releases/iu },
    { name: 'duplicate before first upload', at: 1, expectedUploads: 0, message: /multiple releases/iu },
    { name: 'duplicate before conflicting deletion', at: 1, options: { release: draft(), assets: [{ id: 7, name: 'Gugo-Setup-1.2.3-x64.exe', size: 1 }] }, expectedUploads: 0, message: /multiple releases/iu },
    { name: 'duplicate before later upload', at: 2, expectedUploads: 1, message: /multiple releases/iu },
    { name: 'duplicate before final PATCH', at: 3, expectedUploads: 2, message: /multiple releases/iu },
    { name: 'different ID published while original remains draft', at: 1, published: true, expectedUploads: 0, message: /immutable/iu },
  ]
  for (const scenario of scenarios) await t.test(scenario.name, async (subtest) => {
    const api = createGitHubApi({ ...scenario.options, onReleaseRead: (state) => {
      if (state.releaseReads === scenario.at) state.extraReleases.push(draft({ id: 43, draft: !scenario.published }))
    } })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), scenario.message)
    assert.equal(uploads(api.state).length, scenario.expectedUploads)
    assert.equal(patches(api.state).length, 0)
    assert.equal(api.state.calls.some((call) => call.method === 'DELETE'), false)
    assert.equal(api.state.release.draft, true)
  })
})

test('published and server-immutable release flags are authoritative in both lookup paths', async (t) => {
  for (const [name, options] of [
    ['published visible by tag', { release: draft({ draft: false }) }],
    ['published visible only in list', { release: draft({ draft: false }), releaseTagResponse: () => jsonResponse(404, { message: 'Not Found' }) }],
    ['immutable draft visible by tag', { release: draft({ immutable: true }), exposeDraftAtTag: true }],
    ['immutable draft visible only in list', { release: draft({ immutable: true }) }],
  ]) await t.test(name, async (subtest) => {
    const api = createGitHubApi(options)
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), /immutable/iu)
    noWrites(api.state)
  })
})

test('a changed final PATCH identity, tag or draft state cannot be reported as successful publication', async (t) => {
  for (const [name, publishResponseOverride, message] of [
    ['different ID', { id: 43 }, /identity changed/iu],
    ['different tag', { tag_name: 'v9.9.9' }, /returned release tag.*instead/iu],
    ['still draft', { draft: true }, /did not become.*published/iu],
  ]) await t.test(name, async (subtest) => {
    const api = createGitHubApi({ publishResponseOverride })
    await assert.rejects(publishGitHubRelease(publishOptions(subtest, api)), message)
    assert.equal(patches(api.state).length, 1)
    assert.equal(new URL(patches(api.state)[0].url).pathname, `/repos/${REPOSITORY}/releases/42`)
  })
})

test('remote Git tag commit remains authoritative instead of the advisory draft target_commitish', async (t) => {
  const api = createGitHubApi({ release: draft({ target_commitish: 'some-existing-branch' }), annotatedTag: true })
  await publishGitHubRelease(publishOptions(t, api))
  assert.ok(api.state.tagReads >= 3)
  assert.equal(api.state.release.draft, false)
  const changed = createGitHubApi({ onTagRead: (state) => {
    if (state.tagReads === 3) state.tagCommit = 'abcdef0123456789abcdef0123456789abcdef01'
  } })
  await assert.rejects(publishGitHubRelease(publishOptions(t, changed)), /resolves to.*expected/iu)
  assert.equal(patches(changed.state).length, 0)
  assert.notEqual(changed.state.tagCommit, COMMIT)
})
