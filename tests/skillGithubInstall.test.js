import test from 'node:test'
import assert from 'node:assert/strict'

import {
  __test,
  parseGithubSkillUrl,
  parseSkillMdFrontmatter,
  adaptSkillMdToYma,
  installSkillFromGithubUrl,
  fetchSkillPackFromGithub,
} from '../server/services/skillGithubInstall.js'

test('GitHub fetch forwards runtime proxy env and cancels oversized streams early', async () => {
  const runtimeEnv = { HTTPS_PROXY: 'http://127.0.0.1:57417' }
  let reads = 0
  let cancelled = false
  const fetchImpl = async (_url, _init, forwardedEnv) => {
    assert.equal(forwardedEnv, runtimeEnv)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            reads += 1
            return { done: false, value: Uint8Array.from([1, 2, 3]) }
          },
          async cancel() { cancelled = true },
          releaseLock() {},
        }),
      },
      async arrayBuffer() { throw new Error('must not buffer the whole response') },
    }
  }

  const result = await __test.fetchRawFile('https://raw.githubusercontent.com/o/r/main/SKILL.md', fetchImpl, {
    env: runtimeEnv,
    maxBytes: 4,
  })
  assert.equal(result.ok, false)
  assert.equal(cancelled, true)
  assert.equal(reads, 2)
})

test('parseGithubSkillUrl handles repo root', () => {
  const r = parseGithubSkillUrl('https://github.com/owner/repo')
  assert.deepEqual(r, { owner: 'owner', repo: 'repo', branch: 'HEAD', subpath: '' })
})

test('parseGithubSkillUrl handles /tree/branch/subpath', () => {
  const r = parseGithubSkillUrl('https://github.com/owner/repo/tree/main/skills/foo')
  assert.deepEqual(r, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'skills/foo' })
})

test('parseGithubSkillUrl handles /blob/branch/file → directory only', () => {
  const r = parseGithubSkillUrl('https://github.com/owner/repo/blob/main/skills/foo/SKILL.md')
  assert.deepEqual(r, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'skills/foo' })
})

test('parseGithubSkillUrl rejects non-github hosts', () => {
  assert.equal(parseGithubSkillUrl('https://gitlab.com/owner/repo'), null)
  assert.equal(parseGithubSkillUrl('not a url'), null)
  assert.equal(parseGithubSkillUrl(''), null)
  assert.equal(parseGithubSkillUrl(null), null)
})

test('parseSkillMdFrontmatter extracts YAML frontmatter', () => {
  const md = '---\nname: hello-skill\ndescription: "demo"\nicon: ✨\n---\n# body\n\ncontent here'
  const { meta, body } = parseSkillMdFrontmatter(md)
  assert.equal(meta.name, 'hello-skill')
  assert.equal(meta.description, 'demo')
  assert.equal(meta.icon, '✨')
  assert.ok(body.startsWith('# body'))
})

test('parseSkillMdFrontmatter returns empty meta when no frontmatter', () => {
  const { meta, body } = parseSkillMdFrontmatter('# just a title\n\nbody')
  assert.deepEqual(meta, {})
  assert.ok(body.startsWith('# just a title'))
})

test('adaptSkillMdToYma generates skill.json + prompts/system.md', () => {
  const md = '---\nname: cool-skill\ndescription: cool\nversion: 1.2.3\n---\n# prompt\n\nbody'
  const files = adaptSkillMdToYma(md)
  assert.ok(files)
  assert.ok(files['skill.json'])
  assert.ok(files['prompts/system.md'])
  const manifest = JSON.parse(files['skill.json'])
  assert.equal(manifest.id, 'cool-skill')
  assert.equal(manifest.name, 'cool-skill')
  assert.equal(manifest.version, '1.2.3')
  assert.ok(files['prompts/system.md'].startsWith('# prompt'))
})

test('adaptSkillMdToYma returns null when missing id/name', () => {
  const md = '---\nversion: 1\n---\nbody'
  assert.equal(adaptSkillMdToYma(md), null)
})

test('adaptSkillMdToYma sanitizes id to a-z0-9-', () => {
  const md = '---\nname: "Wild Name!! 中文"\n---\nbody'
  const files = adaptSkillMdToYma(md)
  const manifest = JSON.parse(files['skill.json'])
  assert.match(manifest.id, /^[a-z0-9-]+$/)
})

// fakeFetch: 给定一组 url → response 的映射
function makeFetch(responses) {
  return async (url) => {
    if (Object.prototype.hasOwnProperty.call(responses, url)) {
      const entry = responses[url]
      const bytes = entry.bytes || new TextEncoder().encode(entry.body || '')
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        headers: { get: () => String(bytes.byteLength) },
        async text() { return entry.body || '' },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      }
    }
    return { ok: false, status: 404, async text() { return '' }, async arrayBuffer() { return new ArrayBuffer(0) } }
  }
}

test('fetchSkillPackFromGithub prefers yma format', async () => {
  const parsed = parseGithubSkillUrl('https://github.com/o/r')
  const fetchImpl = makeFetch({
    'https://raw.githubusercontent.com/o/r/HEAD/skill.json': {
      status: 200,
      body: JSON.stringify({ id: 'foo', name: 'Foo', description: 'd', version: '1', icon: '✨', permissions: [] }),
    },
    'https://raw.githubusercontent.com/o/r/HEAD/prompts/system.md': { status: 200, body: '# sys' },
  })
  const r = await fetchSkillPackFromGithub(parsed, { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'yma')
  assert.ok(r.files['skill.json'])
  assert.equal(r.files['prompts/system.md'], '# sys')
})

test('fetchSkillPackFromGithub falls back to SKILL.md', async () => {
  const parsed = parseGithubSkillUrl('https://github.com/o/r/tree/main/sk')
  const fetchImpl = makeFetch({
    'https://raw.githubusercontent.com/o/r/main/sk/SKILL.md': {
      status: 200,
      body: '---\nname: my-skill\ndescription: my skill\n---\n# Hello',
    },
  })
  const r = await fetchSkillPackFromGithub(parsed, { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'skill-md')
  const manifest = JSON.parse(r.files['skill.json'])
  assert.equal(manifest.id, 'my-skill')
})

test('installSkillFromGithubUrl wires install + dedup', async () => {
  const fetchImpl = makeFetch({
    'https://raw.githubusercontent.com/o/r/HEAD/skill.json': {
      status: 200,
      body: JSON.stringify({ id: 'bar', name: 'Bar', description: 'd', version: '1', icon: '✨', permissions: [] }),
    },
    'https://raw.githubusercontent.com/o/r/HEAD/prompts/system.md': { status: 200, body: '# sys' },
  })
  const calls = []
  const installFn = ({ files, existingIds, userId }) => {
    calls.push({ files, existingIds, userId })
    return { ok: true, skill: { id: 'bar', userId } }
  }
  const r = await installSkillFromGithubUrl({
    url: 'https://github.com/o/r',
    userId: 'u1',
    installFn,
    listExistingIdsFn: () => ['existing-1'],
    fetchImpl,
  })
  assert.equal(r.ok, true)
  assert.equal(r.skill.id, 'bar')
  assert.equal(r.source, 'yma')
  assert.equal(r.repo, 'o/r')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].existingIds, ['existing-1'])
})

test('installSkillFromGithubUrl rejects without userId', async () => {
  const r = await installSkillFromGithubUrl({ url: 'https://github.com/o/r' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /登录/)
})

test('installSkillFromGithubUrl rejects bad url', async () => {
  const r = await installSkillFromGithubUrl({ url: 'nope', userId: 'u1', installFn: () => {} })
  assert.equal(r.ok, false)
  assert.match(r.reason, /github/)
})

test('parseSkillMdFrontmatter supports folded and literal YAML block scalars', () => {
  const { meta } = parseSkillMdFrontmatter([
    '---',
    'name: yaml-blocks',
    'description: >-',
    '  First line',
    '  continues here.',
    'notes: |-',
    '  alpha',
    '  beta',
    '---',
    'body',
  ].join('\n'))
  assert.equal(meta.description, 'First line continues here.')
  assert.equal(meta.notes, 'alpha\nbeta')
})

test('parseGithubSkillUrl rejects insecure and non-repository URLs', () => {
  assert.equal(parseGithubSkillUrl('http://github.com/owner/repo'), null)
  assert.equal(parseGithubSkillUrl('https://user:pass@github.com/owner/repo'), null)
  assert.equal(parseGithubSkillUrl('https://github.com/owner/repo/issues/1'), null)
})

test('fetchSkillPackFromGithub pins revision, records license, and imports nested resources', async () => {
  const sha = 'a'.repeat(40)
  const parsed = parseGithubSkillUrl('https://github.com/o/r/tree/main/sk')
  const fetchImpl = makeFetch({
    'https://api.github.com/repos/o/r/commits/main': {
      status: 200,
      body: JSON.stringify({ sha }),
    },
    [`https://raw.githubusercontent.com/o/r/${sha}/sk/skill.json`]: { status: 404 },
    [`https://raw.githubusercontent.com/o/r/${sha}/sk/SKILL.md`]: {
      status: 200,
      body: '---\nname: nested-skill\ndescription: >-\n  Nested resource\n  example\n---\nUse the resources.',
    },
    [`https://api.github.com/repos/o/r/license?ref=${sha}`]: {
      status: 200,
      body: JSON.stringify({ license: { spdx_id: 'Apache-2.0' } }),
    },
    [`https://api.github.com/repos/o/r/contents/sk/prompts?ref=${sha}`]: { status: 404 },
    [`https://api.github.com/repos/o/r/contents/sk/scripts?ref=${sha}`]: {
      status: 200,
      body: JSON.stringify([{ type: 'dir', path: 'sk/scripts/tools' }]),
    },
    [`https://api.github.com/repos/o/r/contents/sk/scripts/tools?ref=${sha}`]: {
      status: 200,
      body: JSON.stringify([{ type: 'file', path: 'sk/scripts/tools/run.js', size: 18 }]),
    },
    [`https://raw.githubusercontent.com/o/r/${sha}/sk/scripts/tools/run.js`]: {
      status: 200,
      body: 'export default 1\n',
    },
    [`https://api.github.com/repos/o/r/contents/sk/references?ref=${sha}`]: {
      status: 200,
      body: JSON.stringify([{ type: 'file', path: 'sk/references/guide.md', size: 7 }]),
    },
    [`https://raw.githubusercontent.com/o/r/${sha}/sk/references/guide.md`]: { status: 200, body: '# Guide' },
    [`https://api.github.com/repos/o/r/contents/sk/assets?ref=${sha}`]: {
      status: 200,
      body: JSON.stringify([{ type: 'file', path: 'sk/assets/pixel.png', size: 4 }]),
    },
    [`https://raw.githubusercontent.com/o/r/${sha}/sk/assets/pixel.png`]: {
      status: 200,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    },
  })

  const result = await fetchSkillPackFromGithub(parsed, { fetchImpl, env: {} })
  assert.equal(result.ok, true)
  assert.equal(result.meta.revision, sha)
  assert.equal(result.meta.license, 'Apache-2.0')
  assert.equal(result.files['scripts/tools/run.js'], 'export default 1\n')
  assert.equal(result.files['references/guide.md'], '# Guide')
  assert.match(result.files['assets/pixel.png'], /^data:image\/png;base64,/)
  const manifest = JSON.parse(result.files['skill.json'])
  assert.equal(manifest.description, 'Nested resource example')
  assert.equal(manifest.source.repository, 'o/r')
  assert.equal(manifest.source.revision, sha)
  assert.equal(manifest.source.license, 'Apache-2.0')
})

test('fetchSkillPackFromGithub rejects paths outside the requested skill folder', async () => {
  const parsed = parseGithubSkillUrl('https://github.com/o/r/tree/main/sk')
  const fetchImpl = makeFetch({
    'https://raw.githubusercontent.com/o/r/main/sk/skill.json': { status: 404 },
    'https://raw.githubusercontent.com/o/r/main/sk/SKILL.md': {
      status: 200,
      body: '---\nname: safe-skill\ndescription: safe\n---\nbody',
    },
    'https://api.github.com/repos/o/r/contents/sk/prompts?ref=main': { status: 404 },
    'https://api.github.com/repos/o/r/contents/sk/scripts?ref=main': {
      status: 200,
      body: JSON.stringify([{ type: 'file', path: 'other/scripts/escape.js', size: 1 }]),
    },
  })
  const result = await fetchSkillPackFromGithub(parsed, { fetchImpl, env: {} })
  assert.equal(result.ok, false)
  assert.match(result.reason, /越界路径/)
})

test('S1: extractDirectoryEntries detects truncated contents responses', () => {
  // 普通目录 → 数组
  assert.deepEqual(__test.extractDirectoryEntries([
    { path: 'a.txt', type: 'file' },
  ]).map((e) => e.path), ['a.txt'])
  // 截断响应 { truncated: true, content: [...] } → 仍返回条目数组（调用方靠 truncated 判断拒绝）
  const truncated = __test.extractDirectoryEntries({ truncated: true, content: [{ path: 'a.txt' }] })
  assert.ok(Array.isArray(truncated))
  // 非目录结构 → null
  assert.equal(__test.extractDirectoryEntries({ type: 'file', name: 'x' }), null)
  assert.equal(__test.extractDirectoryEntries(null), null)
  assert.equal(__test.extractDirectoryEntries('not-an-object'), null)
})
