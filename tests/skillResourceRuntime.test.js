import assert from 'node:assert/strict'
import test from 'node:test'
import { installValidatedSkillPack, validateSkillPack } from '../server/services/skillImport.js'
import {
  describeSkillResources,
  getSkillResourceManifest,
  readSelectedSkillResource,
} from '../server/services/skillResourceRuntime.js'

const owner = 'skill-resource-owner'
const other = 'skill-resource-other'
const skillId = 'resource-runtime-fixture'
const unicodeText = 'A😀汉字\nB🧪終'
const files = {
  'skill.json': JSON.stringify({ id: skillId, name: 'Resource fixture', description: 'Read selected resources.', version: '1.0.0', icon: 'x', permissions: [] }),
  'prompts/system.md': 'Read references/rules.md before answering. Scripts are documentation, not automatic actions.',
  'references/rules.md': unicodeText,
  'scripts/check.js': 'throw new Error("THIS_SCRIPT_MUST_NEVER_EXECUTE")',
  'templates/template.pptx': 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,AAEC',
}
const installed = installValidatedSkillPack({ files, userId: owner })
assert.equal(installed.ok, true)
const scope = { userId: owner, skillIds: [skillId] }

test('resource manifests are stable, sorted, and explicit about unsupported binary templates', () => {
  const first = getSkillResourceManifest(skillId, { userId: owner })
  const reordered = describeSkillResources({ id: skillId, files: Object.fromEntries(Object.entries(files).reverse()) })
  assert.deepEqual(first, reordered)
  assert.equal(first.base, 'skill-resource:v1:' + skillId)
  assert.equal(first.access, 'host_read_only')
  assert.deepEqual(first.files.map((entry) => entry.path), [...Object.keys(files)].sort())
  const binary = first.files.find((entry) => entry.path.endsWith('.pptx'))
  assert.equal(binary.readable, false)
  assert.equal(binary.reason, 'binary_unsupported')
})

test('the resource reader requires the host user and current selected skill scope', () => {
  for (const context of [
    { userId: owner, skillIds: [] },
    { userId: other, skillIds: [skillId] },
    { userId: null, skillIds: [skillId] },
  ]) {
    const result = readSelectedSkillResource({ skill_id: skillId, path: 'references/rules.md', userId: owner }, context)
    assert.equal(result.code, 'SKILL_RESOURCE_NOT_AUTHORIZED')
    assert.equal(Object.hasOwn(result, 'content'), false)
  }
  assert.equal(readSelectedSkillResource({ skill_id: 'unselected-resource', path: 'references/rules.md' }, scope).code, 'SKILL_RESOURCE_NOT_AUTHORIZED')
})

test('Unicode text paging preserves whole characters and reports complete offsets and integrity', () => {
  let offset = 0
  let reconstructed = ''
  const hashes = new Set()
  while (true) {
    const page = readSelectedSkillResource({ skill_id: skillId, path: 'references/rules.md', offset, limit: 2 }, scope)
    assert.equal(page.ok, true)
    assert.equal(page.execution, 'not_executed')
    assert.ok(Array.from(page.content).length <= 2)
    hashes.add(page.sha256)
    reconstructed += page.content
    if (page.eof) { assert.equal(page.nextOffset, null); break }
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  }
  assert.equal(reconstructed, unicodeText)
  assert.equal(hashes.size, 1)
  assert.match([...hashes][0], /^[a-f0-9]{64}$/)
})

test('resources reject path escape, encoded traversal, missing files, and invalid page bounds', () => {
  for (const resourcePath of ['../rules.md', '/etc/passwd', 'C:\\outside.txt', '\\\\host\\share', 'references/../rules.md', 'references//rules.md', '%2e%2e/rules.md']) {
    assert.equal(readSelectedSkillResource({ skill_id: skillId, path: resourcePath }, scope).code, 'SKILL_RESOURCE_PATH_INVALID', resourcePath)
  }
  assert.equal(readSelectedSkillResource({ skill_id: skillId, path: 'references/missing.md' }, scope).code, 'SKILL_RESOURCE_NOT_FOUND')
  for (const paging of [{ offset: -1 }, { offset: 1.5 }, { offset: 1000 }, { limit: 0 }, { limit: 8193 }]) {
    assert.equal(readSelectedSkillResource({ skill_id: skillId, path: 'references/rules.md', ...paging }, scope).code, 'SKILL_RESOURCE_PAGE_INVALID')
  }
})

test('scripts are readable text without execution and binary resources do not masquerade as mounted text', () => {
  const script = readSelectedSkillResource({ skill_id: skillId, path: 'scripts/check.js' }, scope)
  assert.equal(script.ok, true)
  assert.match(script.content, /THIS_SCRIPT_MUST_NEVER_EXECUTE/)
  assert.equal(script.execution, 'not_executed')
  const binary = readSelectedSkillResource({ skill_id: skillId, path: 'templates/template.pptx' }, scope)
  assert.equal(binary.ok, false)
  assert.equal(binary.reason, 'binary_unsupported')
  assert.equal(Object.hasOwn(binary, 'content'), false)
  assert.equal(validateSkillPack({ ...files, 'references/link': { type: 'symlink', target: '../outside.md' } }).ok, false)
})

test('selected resource listing is bounded and cancellation prevents resource reads', () => {
  const listed = readSelectedSkillResource({ skill_id: skillId }, scope)
  assert.equal(listed.ok, true)
  assert.equal(listed.manifest.files.length, Object.keys(files).length)
  const controller = new AbortController()
  const stopped = new Error('host cancelled resource read')
  controller.abort(stopped)
  assert.throws(() => readSelectedSkillResource({ skill_id: skillId, path: 'references/rules.md' }, { ...scope, signal: controller.signal }), (error) => error === stopped)
})
