#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API_VERSION = '2022-11-28'
const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_UPLOADS_BASE_URL = 'https://uploads.github.com'
const MAX_RELEASE_ASSETS = 128
const MAX_ASSET_PAGES = 20
const ASSETS_PER_PAGE = 100
const MAX_TAG_INDIRECTIONS = 8

function assertRepository(repository) {
  if (typeof repository !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub repository must use the owner/name form')
  }
}

function assertReleaseTag(tag) {
  if (typeof tag !== 'string'
    || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error('release tag must be a semantic version prefixed with v')
  }
}

function assertCommitSha(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error('release commit must be a full 40-character Git SHA')
  }
}

function assertRelease(release, tag) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error('GitHub returned an invalid release identity')
  }
  if (release.tag_name !== tag) {
    throw new Error(`GitHub returned release tag ${String(release.tag_name)} instead of ${tag}`)
  }
  if (typeof release.draft !== 'boolean') {
    throw new Error('GitHub returned a release without draft state')
  }
  return release
}

function responseDetail(text) {
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    return String(parsed?.message || text).slice(0, 2_000)
  } catch {
    return String(text).slice(0, 2_000)
  }
}

async function requestJson(fetchImpl, url, {
  method = 'GET',
  headers,
  body,
  expectedStatuses = [200],
  context,
  duplex,
} = {}) {
  let response
  try {
    response = await fetchImpl(url, { method, headers, body, duplex })
  } catch (error) {
    throw new Error(`${context} failed: ${error?.message || error}`, { cause: error })
  }
  const text = await response.text()
  if (!expectedStatuses.includes(response.status)) {
    const detail = responseDetail(text)
    throw new Error(`${context} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  if (!text) return { status: response.status, data: null }
  try {
    return { status: response.status, data: JSON.parse(text) }
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error })
  }
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Gugo-release-publisher',
    'X-GitHub-Api-Version': API_VERSION,
    ...extra,
  }
}

export async function prepareReleaseAssets(files, { cwd = process.cwd() } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('at least one release asset is required')
  }
  if (files.length > MAX_RELEASE_ASSETS) {
    throw new Error(`release asset count exceeds ${MAX_RELEASE_ASSETS}`)
  }

  const names = new Set()
  const assets = []
  for (const candidate of files) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('release asset paths must be non-empty strings')
    }
    const filePath = path.resolve(cwd, candidate)
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`release asset must be a regular file: ${candidate}`)
    }
    if (stat.size <= 0) {
      throw new Error(`release asset must not be empty: ${candidate}`)
    }
    const name = path.basename(filePath)
    if (!name || /[\0\r\n\\/]/.test(name)) {
      throw new Error(`release asset has an unsafe filename: ${JSON.stringify(name)}`)
    }
    const identity = name.toLowerCase()
    if (names.has(identity)) throw new Error(`duplicate release asset filename: ${name}`)
    names.add(identity)
    assets.push(Object.freeze({ filePath, name, size: stat.size, identity }))
  }
  return Object.freeze(assets)
}

async function getReleaseByTag({ fetchImpl, apiBaseUrl, repository, tag, headers }) {
  const url = `${apiBaseUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
  const response = await requestJson(fetchImpl, url, {
    headers,
    expectedStatuses: [200, 404],
    context: `read GitHub Release ${tag}`,
  })
  return response.status === 404 ? null : assertRelease(response.data, tag)
}

async function assertDraftReleaseCurrent(options, expectedReleaseId) {
  const release = await getReleaseByTag(options)
  if (!release) {
    throw new Error(`Draft GitHub Release ${options.tag} no longer exists`)
  }
  if (release.id !== expectedReleaseId) {
    throw new Error(`GitHub Release ${options.tag} identity changed during publication`)
  }
  if (!release.draft) {
    throw new Error(`Published GitHub Release ${options.tag} already exists and is immutable`)
  }
  return release
}

async function createDraftRelease({
  fetchImpl,
  apiBaseUrl,
  repository,
  tag,
  commit,
  headers,
}) {
  const response = await requestJson(fetchImpl, `${apiBaseUrl}/repos/${repository}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: commit,
      name: tag,
      draft: true,
      prerelease: false,
      generate_release_notes: true,
    }),
    expectedStatuses: [201],
    context: `create draft GitHub Release ${tag}`,
  })
  const release = assertRelease(response.data, tag)
  if (!release.draft) throw new Error(`GitHub Release ${tag} was not created as a draft`)
  return release
}

async function resolveTagCommit({ fetchImpl, apiBaseUrl, repository, tag, headers }) {
  const refUrl = `${apiBaseUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`
  const refResponse = await requestJson(fetchImpl, refUrl, {
    headers,
    expectedStatuses: [200, 404],
    context: `verify Git tag ${tag}`,
  })
  if (refResponse.status === 404) {
    throw new Error(`Git tag ${tag} does not exist on GitHub`)
  }
  if (refResponse.data?.ref !== `refs/tags/${tag}`) {
    throw new Error(`GitHub returned an invalid reference for tag ${tag}`)
  }

  let object = refResponse.data?.object
  for (let depth = 0; depth <= MAX_TAG_INDIRECTIONS; depth += 1) {
    if (object?.type === 'commit' && /^[0-9a-f]{40}$/i.test(object.sha || '')) {
      return object.sha.toLowerCase()
    }
    if (object?.type !== 'tag' || !/^[0-9a-f]{40}$/i.test(object.sha || '')) {
      throw new Error(`Git tag ${tag} does not resolve to a commit`)
    }
    if (depth === MAX_TAG_INDIRECTIONS) break
    const tagResponse = await requestJson(
      fetchImpl,
      `${apiBaseUrl}/repos/${repository}/git/tags/${object.sha}`,
      { headers, context: `resolve annotated Git tag ${tag}` },
    )
    object = tagResponse.data?.object
  }
  throw new Error(`Git tag ${tag} has too many levels of indirection`)
}

async function assertRemoteTagCommit(options, expectedCommit) {
  const actualCommit = await resolveTagCommit(options)
  if (actualCommit !== expectedCommit.toLowerCase()) {
    throw new Error(`Git tag ${options.tag} resolves to ${actualCommit}, expected ${expectedCommit}`)
  }
}

async function listReleaseAssets({ fetchImpl, apiBaseUrl, repository, releaseId, headers }) {
  const assets = []
  for (let page = 1; page <= MAX_ASSET_PAGES; page += 1) {
    const url = `${apiBaseUrl}/repos/${repository}/releases/${releaseId}/assets?per_page=${ASSETS_PER_PAGE}&page=${page}`
    const response = await requestJson(fetchImpl, url, {
      headers,
      context: `list assets for GitHub Release ${releaseId}`,
    })
    if (!Array.isArray(response.data)) {
      throw new Error(`GitHub Release ${releaseId} returned an invalid asset list`)
    }
    assets.push(...response.data)
    if (response.data.length < ASSETS_PER_PAGE) return assets
  }
  throw new Error(`GitHub Release ${releaseId} has too many assets to verify safely`)
}

async function deleteAsset({ fetchImpl, apiBaseUrl, repository, asset, headers }) {
  if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) {
    throw new Error(`GitHub returned an invalid asset identity for ${String(asset?.name)}`)
  }
  await requestJson(fetchImpl, `${apiBaseUrl}/repos/${repository}/releases/assets/${asset.id}`, {
    method: 'DELETE',
    headers,
    expectedStatuses: [204],
    context: `delete conflicting GitHub Release asset ${String(asset.name)}`,
  })
}

async function uploadAsset({
  fetchImpl,
  uploadsBaseUrl,
  repository,
  releaseId,
  asset,
  headers,
}) {
  const stream = createReadStream(asset.filePath)
  try {
    const url = `${uploadsBaseUrl}/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`
    const response = await requestJson(fetchImpl, url, {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/vnd.github+json',
        'Content-Length': String(asset.size),
        'Content-Type': 'application/octet-stream',
      },
      body: stream,
      duplex: 'half',
      expectedStatuses: [201],
      context: `upload GitHub Release asset ${asset.name}`,
    })
    if (response.data?.name !== asset.name || response.data?.size !== asset.size) {
      throw new Error(`GitHub upload receipt does not match ${asset.name}`)
    }
    return response.data
  } finally {
    stream.destroy()
  }
}

function verifyRemoteAssets(remoteAssets, expectedAssets) {
  if (remoteAssets.length !== expectedAssets.length) {
    throw new Error(
      `GitHub Release asset verification found ${remoteAssets.length} assets, expected ${expectedAssets.length}`,
    )
  }
  for (const expected of expectedAssets) {
    const matches = remoteAssets.filter((asset) => (
      typeof asset?.name === 'string' && asset.name.toLowerCase() === expected.identity
    ))
    if (matches.length !== 1) {
      throw new Error(`GitHub Release asset verification found ${matches.length} copies of ${expected.name}`)
    }
    const [remote] = matches
    if (remote.name !== expected.name || remote.size !== expected.size) {
      throw new Error(`GitHub Release asset verification failed for ${expected.name}`)
    }
    if (remote.state !== 'uploaded') {
      throw new Error(`GitHub Release asset ${expected.name} is not fully uploaded`)
    }
  }
}

function assertNoUnexpectedAssets(remoteAssets, expectedNames) {
  const unexpected = remoteAssets.filter((asset) => (
    typeof asset?.name !== 'string' || !expectedNames.has(asset.name.toLowerCase())
  ))
  if (unexpected.length === 0) return
  const names = unexpected.map((asset) => String(asset?.name || '<unnamed>')).join(', ')
  throw new Error(`Draft GitHub Release contains unexpected assets: ${names}`)
}

async function publishDraft({ fetchImpl, apiBaseUrl, repository, release, tag, headers }) {
  const response = await requestJson(
    fetchImpl,
    `${apiBaseUrl}/repos/${repository}/releases/${release.id}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false, prerelease: false }),
      context: `publish draft GitHub Release ${tag}`,
    },
  )
  const published = assertRelease(response.data, tag)
  if (published.draft || published.prerelease) {
    throw new Error(`GitHub Release ${tag} did not become a stable published release`)
  }
  return published
}

export async function publishGitHubRelease({
  repository,
  tag,
  commit,
  files,
  token,
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  uploadsBaseUrl = DEFAULT_UPLOADS_BASE_URL,
} = {}) {
  assertRepository(repository)
  assertReleaseTag(tag)
  assertCommitSha(commit)
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('GITHUB_TOKEN is required for GitHub Release publication')
  }
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required')

  const assets = await prepareReleaseAssets(files, { cwd })
  const headers = githubHeaders(token)
  const tagOptions = { fetchImpl, apiBaseUrl, repository, tag, headers }
  const releaseOptions = { fetchImpl, apiBaseUrl, repository, tag, headers }
  await assertRemoteTagCommit(tagOptions, commit)
  let release = await getReleaseByTag(releaseOptions)
  if (release && !release.draft) {
    throw new Error(`Published GitHub Release ${tag} already exists and is immutable`)
  }
  release ||= await createDraftRelease({
    fetchImpl,
    apiBaseUrl,
    repository,
    tag,
    commit,
    headers,
  })
  await assertRemoteTagCommit(tagOptions, commit)

  const expectedNames = new Set(assets.map((asset) => asset.identity))
  const existingAssets = await listReleaseAssets({
    fetchImpl,
    apiBaseUrl,
    repository,
    releaseId: release.id,
    headers,
  })
  assertNoUnexpectedAssets(existingAssets, expectedNames)
  for (const existing of existingAssets) {
    if (typeof existing?.name === 'string' && expectedNames.has(existing.name.toLowerCase())) {
      await assertDraftReleaseCurrent(releaseOptions, release.id)
      await deleteAsset({ fetchImpl, apiBaseUrl, repository, asset: existing, headers })
    }
  }

  for (const asset of assets) {
    await assertDraftReleaseCurrent(releaseOptions, release.id)
    await uploadAsset({
      fetchImpl,
      uploadsBaseUrl,
      repository,
      releaseId: release.id,
      asset,
      headers,
    })
  }

  const uploadedAssets = await listReleaseAssets({
    fetchImpl,
    apiBaseUrl,
    repository,
    releaseId: release.id,
    headers,
  })
  verifyRemoteAssets(uploadedAssets, assets)
  await assertRemoteTagCommit(tagOptions, commit)
  release = await assertDraftReleaseCurrent(releaseOptions, release.id)
  release = await publishDraft({ fetchImpl, apiBaseUrl, repository, release, tag, headers })
  return Object.freeze({
    releaseId: release.id,
    tag,
    assets: Object.freeze(assets.map(({ name, size }) => Object.freeze({ name, size }))),
  })
}

export function parseArgs(argv) {
  const parsed = {
    repository: process.env.GITHUB_REPOSITORY || '',
    tag: process.env.RELEASE_TAG || '',
    commit: '',
    files: [],
  }
  let positionalOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!positionalOnly && value === '--') {
      positionalOnly = true
    } else if (!positionalOnly && value === '--repo') {
      parsed.repository = argv[++index] || ''
    } else if (!positionalOnly && value === '--tag') {
      parsed.tag = argv[++index] || ''
    } else if (!positionalOnly && value === '--commit') {
      parsed.commit = argv[++index] || ''
    } else if (!positionalOnly && value.startsWith('--')) {
      throw new Error(`unknown option: ${value}`)
    } else {
      parsed.files.push(value)
    }
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await publishGitHubRelease({
    ...args,
    token: process.env.GITHUB_TOKEN,
  })
  process.stdout.write(`Published ${result.tag} with ${result.assets.length} verified assets through GitHub REST API\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 1
  })
}
