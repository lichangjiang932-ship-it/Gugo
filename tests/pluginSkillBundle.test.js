import assert from 'node:assert/strict'
import test from 'node:test'

import { validateManifest, PLUGIN_TYPES } from '../server/plugins/pluginManifest.js'
import { initPlugins, listPlugins, getPlugin, _resetForTests } from '../server/plugins/pluginRegistry.js'
import { installPluginAsSkill } from '../server/services/pluginToSkill.js'
import { getDb } from '../server/db.js'

// 一次性 init 真实 plugins/ 目录
test.before(() => {
  _resetForTests()
  initPlugins({ rootDir: './plugins', silent: true })
})

test('PLUGIN_TYPES 包含 skill-bundle', () => {
  assert.ok(PLUGIN_TYPES.includes('skill-bundle'))
})

test('validateManifest: type=skill-bundle 合法', () => {
  const r = validateManifest({
    id: 'sb-x',
    name: 'SB X',
    version: '0.1.0',
    type: 'skill-bundle',
    entry: 'skill.json',
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.manifest.type, 'skill-bundle')
})

test('loadPlugins 扫到 example-skill-bundle 且 type 正确', () => {
  const list = listPlugins({ type: 'skill-bundle' })
  const hit = list.find((p) => p.id === 'example-skill-bundle')
  assert.ok(hit, 'example-skill-bundle 未被扫到')
  assert.equal(hit.type, 'skill-bundle')
  assert.ok(hit.rootDir, '插件应带 rootDir')
})

test('installPluginAsSkill: 成功路径', () => {
  const userId = `test-skill-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const res = installPluginAsSkill({
      pluginId: 'example-skill-bundle',
      userId,
      existingIds: [],
    })
    assert.equal(res.ok, true, `install 失败: ${res.ok ? '' : res.reason}`)
    assert.ok(res.skill, '返回应含 skill')
    assert.equal(res.skill.id, 'example-bundled')
    assert.equal(res.skill.userId, userId)
    assert.ok(res.skill.files && res.skill.files['prompts/system.md'], 'files 应包含 system.md')
    assert.ok(res.skill.files['skill.json'], 'files 应包含 skill.json')
  } finally {
    try {
      getDb().prepare('DELETE FROM skill_assets WHERE skill_id IN (SELECT id FROM skills WHERE user_id = ?)').run(userId)
      getDb().prepare('DELETE FROM skills WHERE user_id = ?').run(userId)
    } catch {
      /* ignore teardown errors */
    }
  }
})

test('installPluginAsSkill: pluginId 不存在 → ok:false', () => {
  const res = installPluginAsSkill({
    pluginId: 'does-not-exist-xyz',
    userId: 'test-u-nope',
    existingIds: [],
  })
  assert.equal(res.ok, false)
  assert.match(res.reason, /not found/i)
})

test('installPluginAsSkill: 非 skill-bundle 类型 → ok:false', () => {
  // example-agent-coach 是 agent-template 类型
  assert.ok(getPlugin('example-agent-coach'), '前置：example-agent-coach 应存在')
  const res = installPluginAsSkill({
    pluginId: 'example-agent-coach',
    userId: 'test-u-wrongtype',
    existingIds: [],
  })
  assert.equal(res.ok, false)
  assert.match(res.reason, /skill-bundle/)
})

test('installPluginAsSkill: 缺 userId → ok:false', () => {
  const res = installPluginAsSkill({ pluginId: 'example-skill-bundle' })
  assert.equal(res.ok, false)
  assert.match(res.reason, /userId/)
})
