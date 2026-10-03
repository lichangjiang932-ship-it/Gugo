import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const API_BASE_URL = 'https://api.github.test'
export const UPLOADS_BASE_URL = 'https://uploads.github.test'
export const REPOSITORY = 'gugo-tests/release-fixture'
export const TAG = 'v1.2.3'
export const COMMIT = '0123456789abcdef0123456789abcdef01234567'
export const ANNOTATED_TAG_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'

export function draft(overrides = {}) {
  return { id: 42, tag_name: TAG, draft: true, prerelease: false, ...overrides }
}

export function jsonResponse(status, value) {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

async function readRequestBody(body) {
  if (typeof body === 'string') return Buffer.from(body)
  const chunks = []
  for await (const chunk of body || []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function releaseCollection(state) {
  return [...(state.release ? [state.release] : []), ...state.extraReleases]
}

function readReleaseId(state, options, id) {
  state.releaseReads += 1
  if (state.release && state.releaseReads === options.publishOnReleaseRead) state.release.draft = false
  const corruptId = state.release && state.releaseReads === options.replaceReleaseIdOnRead
  if (corruptId) state.release.id = 43
  if (state.releaseReads === options.removeReleaseOnRead) state.release = null
  if (state.release && state.releaseReads === options.retagOnReleaseRead) state.release.tag_name = 'v9.9.9'
  if (state.release && state.releaseReads === options.immutableOnReleaseRead) state.release.immutable = true
  options.onReleaseRead?.(state, id)
  const custom = options.releaseIdResponse?.({ state, id })
  if (custom !== undefined) return custom
  const release = corruptId ? state.release : releaseCollection(state).find((entry) => entry.id === id)
  return release ? jsonResponse(200, release) : jsonResponse(404, { message: 'Not Found' })
}

function readReleaseTag(state, options) {
  state.releaseTagReads += 1
  const custom = options.releaseTagResponse?.({ state })
  if (custom !== undefined) return custom
  const releases = releaseCollection(state).filter((entry) => entry.tag_name === TAG)
  const visible = releases.find((entry) => !entry.draft)
    || (options.exposeDraftAtTag ? releases.find((entry) => entry.draft) : null)
  // Match GitHub: tag lookup is not the draft-discovery endpoint.
  return visible ? jsonResponse(200, visible) : jsonResponse(404, { message: 'Not Found' })
}

function readReleaseList(state, options, url) {
  assert.equal(url.searchParams.get('per_page'), '100')
  const page = Number(url.searchParams.get('page'))
  assert.ok(Number.isInteger(page) && page > 0)
  state.releaseListReads += 1
  if (page === 1) state.releaseScans += 1
  state.releasePagesRead.push({ scan: state.releaseScans, page })
  const custom = options.releaseListResponse?.({ state, page, scan: state.releaseScans })
  if (custom !== undefined) return custom
  return jsonResponse(200, releaseCollection(state).slice((page - 1) * 100, page * 100))
}

function readAssets(state, options) {
  state.assetListReads += 1
  const visible = state.assets.map((asset) => ({ ...asset }))
  if (options.corruptVerification && state.assetListReads > 1 && visible[0]) visible[0].size += 1
  if (options.omitVerificationState && state.assetListReads > 1 && visible[0]) delete visible[0].state
  return jsonResponse(200, visible)
}

function createDraft(state, options, body) {
  assert.deepEqual(body, { tag_name: TAG, target_commitish: COMMIT, name: TAG, draft: true, prerelease: false, generate_release_notes: true })
  state.release = draft()
  options.onCreateDraft?.(state)
  return jsonResponse(201, state.release)
}

function publishDraft(state, options, body) {
  assert.deepEqual(body, { draft: false, prerelease: false,
    ...(options.expectedReleaseNotes == null ? {} : { name: TAG, target_commitish: COMMIT, body: options.expectedReleaseNotes }),
  })
  state.release = { ...state.release, ...body }
  return jsonResponse(200, { ...state.release, ...options.publishResponseOverride })
}

export function createGitHubApi(options = {}) {
  const state = {
    release: options.release ? { ...options.release } : null,
    extraReleases: (options.extraReleases || []).map((entry) => ({ ...entry })),
    assets: (options.assets || []).map((asset) => ({ state: 'uploaded', ...asset })),
    calls: [], nextAssetId: 100, assetListReads: 0,
    releaseReads: 0, releaseTagReads: 0, releaseListReads: 0, releaseScans: 0, releasePagesRead: [],
    tagReads: 0, tagCommit: Object.hasOwn(options, 'tagCommit') ? options.tagCommit : COMMIT,
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method || 'GET'
    assert.ok([API_BASE_URL, UPLOADS_BASE_URL].includes(url.origin), 'mock never forwards requests outside its fixture origins')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer release-test-token')
    state.calls.push({ method, url: url.href, body: typeof init.body === 'string' ? init.body : null })
    const base = `/repos/${REPOSITORY}`
    if (url.origin === UPLOADS_BASE_URL && method === 'POST') {
      assert.equal(url.pathname, `${base}/releases/42/assets`)
      const bytes = await readRequestBody(init.body)
      const asset = { id: state.nextAssetId++, name: url.searchParams.get('name'), size: bytes.length, state: 'uploaded' }
      state.assets.push(asset)
      return jsonResponse(201, asset)
    }
    if (url.pathname === `${base}/git/ref/tags/${TAG}` && method === 'GET') {
      state.tagReads += 1
      options.onTagRead?.(state)
      return state.tagCommit ? jsonResponse(200, { ref: `refs/tags/${TAG}`, object: options.annotatedTag
        ? { type: 'tag', sha: ANNOTATED_TAG_SHA } : { type: 'commit', sha: state.tagCommit } })
        : jsonResponse(404, { message: 'Not Found' })
    }
    if (url.pathname === `${base}/git/tags/${ANNOTATED_TAG_SHA}` && method === 'GET') {
      return options.annotatedTag ? jsonResponse(200, { object: { type: 'commit', sha: state.tagCommit } })
        : jsonResponse(404, { message: 'Not Found' })
    }
    if (url.pathname === `${base}/releases/tags/${TAG}` && method === 'GET') return readReleaseTag(state, options)
    if (url.pathname === `${base}/releases` && method === 'GET') return readReleaseList(state, options, url)
    if (url.pathname === `${base}/releases` && method === 'POST') return createDraft(state, options, JSON.parse(init.body))
    if (url.pathname === `${base}/releases/42/assets` && method === 'GET') return readAssets(state, options)
    const assetDelete = new RegExp(`^${base}/releases/assets/(\\d+)$`).exec(url.pathname)
    if (assetDelete && method === 'DELETE') {
      state.assets = state.assets.filter((asset) => asset.id !== Number(assetDelete[1]))
      return jsonResponse(204)
    }
    const releaseId = new RegExp(`^${base}/releases/(\\d+)$`).exec(url.pathname)
    if (releaseId && method === 'GET') return readReleaseId(state, options, Number(releaseId[1]))
    if (url.pathname === `${base}/releases/42` && method === 'PATCH') return publishDraft(state, options, JSON.parse(init.body))
    return jsonResponse(404, { message: `Unhandled ${method} ${url.pathname}` })
  }
  return { state, fetchImpl }
}

export function createAssets(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-publisher-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installer = path.join(root, 'Gugo-Setup-1.2.3-x64.exe')
  const updater = path.join(root, 'latest.yml')
  fs.writeFileSync(installer, Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(updater, 'version: 1.2.3\n')
  return { root, files: [installer, updater] }
}

export function publishOptions(t, api) {
  return {
    repository: REPOSITORY, tag: TAG, commit: COMMIT,
    files: createAssets(t).files, token: 'release-test-token', fetchImpl: api.fetchImpl,
    apiBaseUrl: API_BASE_URL, uploadsBaseUrl: UPLOADS_BASE_URL,
  }
}

export function assetMutations(state) {
  return state.calls.filter(({ method, url }) => method === 'DELETE' || method === 'PATCH'
    || (method === 'POST' && new URL(url).origin === UPLOADS_BASE_URL))
}
