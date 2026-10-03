import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-skill-bundle-boundaries-'))
process.env.APP_DATA_DIR = path.join(dataRoot, 'data')
const { closeDb } = await import('../server/db.js')
const { initPlugins, getPlugin, _resetForTests } = await import('../server/plugins/pluginRegistry.js')
const { getImportedSkill } = await import('../server/services/skillStore.js')
const { installPluginAsSkill } = await import('../server/services/pluginToSkill.js')
let sequence = 0

function fixture(t) {
  const id = 'boundary-bundle-' + (++sequence)
  const root = fs.mkdtempSync(path.join(dataRoot, 'fixture-'))
  const pluginRoot = path.join(root, 'plugins', id)
  const prompts = path.join(pluginRoot, 'prompts')
  const outside = path.join(root, 'outside-plugin')
  fs.mkdirSync(prompts, { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', type: 'skill-bundle', entry: 'skill.json',
  }))
  fs.writeFileSync(path.join(pluginRoot, 'skill.json'), JSON.stringify({
    id, name: 'Fixture Skill', description: 'isolated fixture', version: '1.0.0', icon: 'x', permissions: [],
  }))
  fs.writeFileSync(path.join(prompts, 'system.md'), 'INSIDE_PLUGIN_BODY')
  fs.writeFileSync(path.join(outside, 'system.md'), 'OUTSIDE_PLUGIN_BODY')
  _resetForTests()
  initPlugins({ rootDir: path.join(root, 'plugins'), silent: true })
  assert.ok(getPlugin(id), 'the real loader must accept the initial valid package')
  t.after(() => _resetForTests())
  return { id, root, pluginRoot, prompts, outside, userId: 'skill-boundary-user' }
}

async function assertRejected(input) {
  const result = await installPluginAsSkill({ pluginId: input.id, userId: input.userId })
  assert.equal(result.ok, false)
  assert.equal(getImportedSkill(input.id, { userId: input.userId }), null, 'no partial skill may be persisted')
  return result
}

function linkOrSkip(t, source, target, type) {
  try { fs.symlinkSync(source, target, type); return true }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error
    t.skip('filesystem links are unavailable: ' + error.code)
    return false
  }
}

test.after(() => {
  closeDb()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('skill-bundle import retains ordinary nested prompt files through the real store', async (t) => {
  const input = fixture(t)
  fs.mkdirSync(path.join(input.prompts, 'nested'))
  fs.writeFileSync(path.join(input.prompts, 'nested', 'rules.md'), 'INSIDE_RULES')
  const result = await installPluginAsSkill({ pluginId: input.id, userId: input.userId })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.skill.files['prompts/system.md'], 'INSIDE_PLUGIN_BODY')
  assert.equal(result.skill.files['prompts/nested/rules.md'], 'INSIDE_RULES')
  assert.equal(Object.keys(result.skill.files).length, 3)
})

test('skill-bundle import rejects a prompts-root junction outside the plugin', async (t) => {
  const input = fixture(t)
  fs.renameSync(input.prompts, path.join(input.pluginRoot, 'original-prompts'))
  if (!linkOrSkip(t, input.outside, input.prompts, process.platform === 'win32' ? 'junction' : 'dir')) return
  await assertRejected(input)
})

test('skill-bundle import rejects nested external directory links', async (t) => {
  const input = fixture(t)
  if (!linkOrSkip(t, input.outside, path.join(input.prompts, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')) return
  await assertRejected(input)
})

test('skill-bundle import rejects an external prompt-file symlink', async (t) => {
  const input = fixture(t)
  const target = path.join(input.prompts, 'system.md')
  fs.renameSync(target, path.join(input.prompts, 'original.md'))
  if (!linkOrSkip(t, path.join(input.outside, 'system.md'), target, 'file')) return
  await assertRejected(input)
})

test('skill-bundle import rejects replacement of its loader-owned root', async (t) => {
  const input = fixture(t)
  const relocated = path.join(input.root, 'relocated-plugin')
  fs.renameSync(input.pluginRoot, relocated)
  if (!linkOrSkip(t, relocated, input.pluginRoot, process.platform === 'win32' ? 'junction' : 'dir')) return
  await assertRejected(input)
})

test('skill-bundle import rejects an external skill.json substituted after discovery', async (t) => {
  const input = fixture(t)
  const target = path.join(input.pluginRoot, 'skill.json')
  const externalManifest = path.join(input.outside, 'skill.json')
  fs.renameSync(target, externalManifest)
  if (!linkOrSkip(t, externalManifest, target, 'file')) return
  await assertRejected(input)
})

test('skill-bundle import inherits handle-bound rejection of same-size source drift', async (t) => {
  const input = fixture(t)
  const manifestPath = path.join(input.pluginRoot, 'skill.json')
  const handle = await fsp.open(manifestPath, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const originalRead = prototype.read
  let changed = false
  prototype.read = async function (...args) {
    const result = await originalRead.apply(this, args)
    if (!changed && result.bytesRead > 0) {
      changed = true
      const original = await fsp.readFile(manifestPath, 'utf8')
      const replacement = original.replace('Fixture Skill', 'Changed Skill')
      assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement))
      await fsp.writeFile(manifestPath, replacement)
      const later = new Date(Date.now() + 5000)
      await fsp.utimes(manifestPath, later, later)
    }
    return result
  }
  try {
    const result = await assertRejected(input)
    assert.equal(changed, true)
    assert.equal(result.code, 'PLUGIN_ENTRY_CHANGED')
  } finally { prototype.read = originalRead }
})
