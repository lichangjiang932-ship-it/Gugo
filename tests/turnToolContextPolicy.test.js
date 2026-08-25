import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'

const spec = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})

const namesOf = (specs) => specs.map((item) => item.function.name)

const BASE_SPECS = [
  'list_directory',
  'read_file',
  'write_file',
  'apply_patch',
  'bash_exec',
  'git_status',
  'web_search',
  'fetch_url',
  'create_docx',
  'request_directory',
  'mcp__docs__read',
  'mcp__docs__write',
].map(spec)

test('ordinary questions, terse follow-ups, refresh and checkpoint resume keep one stable catalog', async () => {
  const turns = [
    { prompt: '解释 OAuth。', messages: [] },
    { prompt: '继续', messages: [{ role: 'user', content: '请修改文件。' }] },
    { prompt: '为什么没有写入工具？', messages: [{ role: 'assistant', content: '上一轮已结束。' }] },
    {
      prompt: '恢复任务',
      messages: [{
        role: 'assistant',
        tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }],
    },
  ]
  let expected = null
  for (const turn of turns) {
    const resolved = await resolveTurnToolSpecs({
      userId: null,
      baseSpecs: BASE_SPECS,
      enabledConnectorTools: [],
      ...turn,
    })
    const names = namesOf(resolved)
    expected ||= names
    assert.deepEqual(names, expected)
    for (const name of [...namesOf(BASE_SPECS), 'set_deliverables']) {
      assert.ok(names.includes(name), `${turn.prompt}: ${name}`)
    }
  }
})

test('plan mode projects the model schema to the execution policy read-only allowlist', async () => {
  const catalogs = new Map()
  const decisions = new Map()
  for (const permissionMode of ['plan', 'normal', 'acceptEdits', 'bypass']) {
    const resolved = await resolveTurnToolSpecs({
      userId: null,
      baseSpecs: BASE_SPECS,
      permissionMode,
      enabledConnectorTools: [],
      prompt: '只读分析这个项目。',
      onDecision: (decision) => decisions.set(permissionMode, decision),
    })
    catalogs.set(permissionMode, namesOf(resolved))
  }

  assert.deepEqual(catalogs.get('plan'), ['git_status', 'list_directory', 'read_file', 'request_directory'])
  for (const name of [
    'apply_patch', 'bash_exec', 'create_docx', 'fetch_url', 'mcp__docs__read',
    'mcp__docs__write', 'set_deliverables', 'web_search', 'write_file',
  ]) {
    assert.equal(catalogs.get('plan').includes(name), false, name)
    assert.ok(decisions.get('plan').excludedTools.some((entry) => (
      entry.name === name
      && entry.stage === 'permission'
      && entry.reason === 'permission_mode_plan'
    )), name)
  }

  assert.deepEqual(catalogs.get('acceptEdits'), catalogs.get('normal'))
  assert.deepEqual(catalogs.get('bypass'), catalogs.get('normal'))
  assert.ok(catalogs.get('normal').includes('write_file'))
  assert.ok(catalogs.get('normal').includes('bash_exec'))
})

test('unauthorized plan mode exposes only the directory authorization entry point', async () => {
  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: BASE_SPECS,
    permissionMode: 'plan',
    fileAccessStatus: { grants: [] },
    enabledConnectorTools: [],
    prompt: '只读分析这个项目。',
  })

  assert.deepEqual(namesOf(resolved), ['request_directory'])
})

test('normal mode keeps shell requestable after an exact file grant', async () => {
  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: BASE_SPECS,
    permissionMode: 'normal',
    fileAccessStatus: {
      grants: [{
        id: 'source-pdf',
        path: 'D:\\IELTS\\answer-sheet.pdf',
        resourceType: 'file',
        accessMode: 'read_write',
        available: true,
      }],
      runtime: { localCodeExecutionEnabled: true },
    },
    enabledConnectorTools: [],
    prompt: 'Use Python to fill the selected PDF and render PNG previews.',
  })

  const names = namesOf(resolved)
  assert.ok(names.includes('request_directory'))
  assert.ok(names.includes('bash_exec'))
  assert.ok(names.includes('write_file'))
})

test('exact file access never exposes shell when local execution is disabled', async () => {
  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: BASE_SPECS,
    permissionMode: 'normal',
    fileAccessStatus: {
      grants: [{
        id: 'source-pdf',
        path: 'D:\\IELTS\\answer-sheet.pdf',
        resourceType: 'file',
        accessMode: 'read_write',
        available: true,
      }],
      runtime: { localCodeExecutionEnabled: false },
    },
    enabledConnectorTools: [],
    prompt: 'Use Python to fill the selected PDF.',
  })

  assert.equal(namesOf(resolved).includes('bash_exec'), false)
})

test('execution switches delete disabled schemas from the model-visible catalog', async () => {
  let decision = null
  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: BASE_SPECS,
    enabledConnectorTools: [],
    toolsConfig: {
      enabled: [],
      disabled: ['write_file', 'bash_exec', 'web_search', 'set_deliverables'],
    },
    webSearchReady: false,
    prompt: '普通问答',
    onDecision: (value) => { decision = value },
  })
  const names = namesOf(resolved)
  for (const name of ['write_file', 'bash_exec', 'web_search', 'set_deliverables']) {
    assert.equal(names.includes(name), false, name)
    assert.ok(decision?.excludedTools.some((entry) => (
      entry.name === name
      && entry.stage === 'availability'
      && entry.reason === 'tool_disabled'
    )), name)
  }
})

test('all connected connector schemas remain visible independent of prompt intent', async () => {
  const connectorSpecs = [spec('slack_send_message'), spec('notion_search')]
  const prompts = ['解释本地文件。', '发送 Slack 消息。', '继续']
  for (const prompt of prompts) {
    const resolved = await resolveTurnToolSpecs({
      userId: null,
      baseSpecs: connectorSpecs,
      enabledConnectorTools: ['slack_send_message', 'notion_search'],
      prompt,
    })
    const names = namesOf(resolved)
    assert.ok(names.includes('slack_send_message'), prompt)
    assert.ok(names.includes('notion_search'), prompt)
  }
})

test('an integration that is not connected stays absent with a structured discovery reason', async () => {
  let decision = null
  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: [spec('slack_send_message'), spec('notion_search')],
    enabledConnectorTools: ['slack_send_message'],
    prompt: '继续',
    onDecision: (value) => { decision = value },
  })
  const names = namesOf(resolved)
  assert.ok(names.includes('slack_send_message'))
  assert.equal(names.includes('notion_search'), false)
  assert.deepEqual(
    decision?.excludedTools.find((entry) => entry.name === 'notion_search'),
    { name: 'notion_search', stage: 'availability', reason: 'integration_disabled' },
  )
})
