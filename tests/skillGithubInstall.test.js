import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseGithubSkillUrl,
  parseSkillMdFrontmatter,
  adaptSkillMdToYma,
  installSkillFromGithubUrl,
  fetchSkillPackFromGithub,
} from '../server/services/skillGithubInstall.js'

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
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        async text() { return entry.body || '' },
        async arrayBuffer() { return new TextEncoder().encode(entry.body || '').buffer },
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
