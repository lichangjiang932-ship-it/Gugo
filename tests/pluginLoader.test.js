import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateManifest, PLUGIN_TYPES } from '../server/plugins/pluginManifest.js'
import { loadPlugins } from '../server/plugins/pluginLoader.js'
import { initPlugins, listPlugins, getPlugin, _resetForTests } from '../server/plugins/pluginRegistry.js'

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yma-plugin-loader-'))
}

function writePlugin(rootDir, dirName, manifest, entryFiles = {}) {
  const dir = path.join(rootDir, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
  for (const [name, content] of Object.entries(entryFiles)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const VALID = {
  id: 'sample-x',
  name: 'Sample X',
  version: '1.2.3',
  type: 'ppt-theme',
  entry: 'theme.json',
}

test('validateManifest: 合法 manifest 通过', () => {
  const r = validateManifest({ ...VALID, description: 'hi', tags: ['a', 'b'] })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.manifest.id, 'sample-x')
  assert.deepEqual(r.manifest.tags, ['a', 'b'])
  assert.deepEqual(r.manifest.capabilities, [])
})

test('validateManifest: 缺字段 / 非法 id / 非法 type / 非法 semver / 非法 entry', () => {
  // 缺字段
  let r = validateManifest({ id: 'x' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('name:')))
  assert.ok(r.errors.some((e) => e.startsWith('version:')))
  assert.ok(r.errors.some((e) => e.startsWith('type:')))
  assert.ok(r.errors.some((e) => e.startsWith('entry:')))

  // 非法 id
  r = validateManifest({ ...VALID, id: 'BadID!' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('id:')))

  // 非法 type
  r = validateManifest({ ...VALID, type: 'not-a-type' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('type:')))

  // 版本号非 semver
  r = validateManifest({ ...VALID, version: '1.2' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('version:')))

  // entry 含 ..
  r = validateManifest({ ...VALID, entry: '../etc/passwd' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('entry:')))

  // entry 绝对路径
  r = validateManifest({ ...VALID, entry: '/abs/path.json' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('entry:')))
})

test('validateManifest: 非对象输入被拒', () => {
  assert.equal(validateManifest(null).ok, false)
  assert.equal(validateManifest('str').ok, false)
  assert.equal(validateManifest([1, 2]).ok, false)
})

test('validateManifest: PLUGIN_TYPES 覆盖所有类型', () => {
  for (const t of PLUGIN_TYPES) {
    const r = validateManifest({ ...VALID, type: t, entry: t === 'transformer' ? 'entry.js' : VALID.entry })
    assert.equal(r.ok, true, `${t} should be ok`)
  }
})

test('validateManifest: capabilities 仅允许白名单且最多 16 项', () => {
  let r = validateManifest({ ...VALID, capabilities: ['log'] })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.manifest.capabilities, ['log'])

  r = validateManifest({ ...VALID, capabilities: 'log' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('capabilities:')))

  r = validateManifest({ ...VALID, capabilities: ['fetch'] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('capabilities:')))

  r = validateManifest({ ...VALID, capabilities: Array(17).fill('log') })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('capabilities:')))
})

test('validateManifest: transformer entry 必须是 .js', () => {
  let r = validateManifest({ ...VALID, type: 'transformer', entry: 'entry.js' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))

  r = validateManifest({ ...VALID, type: 'transformer', entry: 'theme.json' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('entry:')))
})

test('loadPlugins: 空目录返回空（不存在亦不报错）', () => {
  // 不存在的目录
  const r1 = loadPlugins({ rootDir: path.join(os.tmpdir(), 'yma-plugin-not-exist-' + Date.now()) })
  assert.deepEqual(r1.plugins, [])
  assert.deepEqual(r1.errors, [])

  // 存在但空目录
  const empty = mkdtemp()
  try {
    const r2 = loadPlugins({ rootDir: empty })
    assert.deepEqual(r2.plugins, [])
    assert.deepEqual(r2.errors, [])
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('loadPlugins: 跳过坏 manifest 但 errors 收集', () => {
  const root = mkdtemp()
  try {
    // 缺 plugin.json
    fs.mkdirSync(path.join(root, 'no-manifest'))
    // 非法 JSON
    const bad = path.join(root, 'bad-json')
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, 'plugin.json'), '{ this is not json')
    // schema 不合法
    writePlugin(root, 'bad-schema', { id: '!!!', name: '', version: 'x', type: 'no', entry: 'a' })
    // entry 文件不存在
    writePlugin(root, 'missing-entry', { ...VALID, id: 'missing-entry', entry: 'gone.json' })
    // 合法的一个
    writePlugin(root, 'good', { ...VALID, id: 'good-plugin' }, { 'theme.json': '{}' })

    const r = loadPlugins({ rootDir: root })
    assert.equal(r.plugins.length, 1)
    assert.equal(r.plugins[0].id, 'good-plugin')
    assert.ok(r.errors.length >= 4, `expected ≥4 errors, got ${r.errors.length}: ${JSON.stringify(r.errors)}`)
    const dirs = r.errors.map((e) => e.dir)
    assert.ok(dirs.includes('no-manifest'))
    assert.ok(dirs.includes('bad-json'))
    assert.ok(dirs.includes('bad-schema'))
    assert.ok(dirs.includes('missing-entry'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('loadPlugins: 读到 2 个示例 plugin', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const r = loadPlugins({ rootDir: path.join(repoRoot, 'plugins') })
  assert.ok(r.plugins.length >= 2, `expected ≥2, got ${r.plugins.length}`)
  const ids = r.plugins.map((p) => p.id)
  assert.ok(ids.includes('example-warm-ppt-theme'))
  assert.ok(ids.includes('example-greeting-prompt'))
  assert.ok(ids.includes('example-transformer-upper'))
})

test('loadPlugins: 重复 id 被拒', () => {
  const root = mkdtemp()
  try {
    writePlugin(root, 'a', { ...VALID, id: 'dup' }, { 'theme.json': '{}' })
    writePlugin(root, 'b', { ...VALID, id: 'dup' }, { 'theme.json': '{}' })
    const r = loadPlugins({ rootDir: root })
    assert.equal(r.plugins.length, 1)
    assert.ok(r.errors.some((e) => /duplicate/.test(e.message)))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('registry: getPlugin / listPlugins / type 过滤', () => {
  _resetForTests()
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })

  assert.equal(getPlugin('not-exist'), null)
  const warm = getPlugin('example-warm-ppt-theme')
  assert.ok(warm)
  assert.equal(warm.type, 'ppt-theme')

  const all = listPlugins()
  assert.ok(all.length >= 2)

  const themes = listPlugins({ type: 'ppt-theme' })
  assert.ok(themes.every((p) => p.type === 'ppt-theme'))
  assert.ok(themes.length >= 1)

  const none = listPlugins({ type: 'not-a-type' })
  assert.equal(none.length, 0)
})
