import test from 'node:test'
import assert from 'node:assert'

test('agent-template plugin: 注册成功，listPlugins({type:"agent-template"}) 能找到 example-agent-coach', async () => {
  const reg = await import(`../server/plugins/pluginRegistry.js?pat=${Date.now()}`)
  reg._resetForTests()
  const { errors } = reg.initPlugins({ rootDir: './plugins', silent: true })
  // 不能有 manifest 解析错误（说明 agent-template 类型被接受）
  const coachErr = errors.find((e) => e.dir?.includes('agent-coach'))
  assert.equal(coachErr, undefined, `coach plugin 不应有错误: ${JSON.stringify(coachErr)}`)

  const list = reg.listPlugins({ type: 'agent-template' })
  const coach = list.find((p) => p.id === 'example-agent-coach')
  assert.ok(coach, 'coach plugin 应被注册')
  assert.equal(coach.type, 'agent-template')
  assert.equal(coach.name, 'Coach Agent Template')

  // 确认总数没漏旧 plugin
  const all = reg.listPlugins().map((p) => p.type)
  assert.ok(all.includes('prompt-template'))
  assert.ok(all.includes('ppt-theme'))
  assert.ok(all.includes('agent-template'))
})

test('agent-template entry: agent.md frontmatter + ## SOUL/IDENTITY 可被 parseAgentMarkdown 还原', async () => {
  const reg = await import(`../server/plugins/pluginRegistry.js?pat2=${Date.now()}`)
  reg._resetForTests()
  reg.initPlugins({ rootDir: './plugins', silent: true })
  const coach = reg.getPlugin('example-agent-coach')
  assert.ok(coach)

  // 读 entry 内容并解析
  const fs = await import('node:fs')
  const path = await import('node:path')
  const entryAbs = path.resolve(coach.rootDir, coach.entry)
  const text = fs.readFileSync(entryAbs, 'utf8')

  const ag = await import(`../server/services/agentStore.js?pat2=${Date.now()}`)
  const parsed = ag.parseAgentMarkdown(text)
  assert.equal(parsed.name, 'Coach')
  assert.match(parsed.identityMd, /Role:.*教练型工作伙伴/)
  assert.match(parsed.soulMd, /克制的教练/)
})
