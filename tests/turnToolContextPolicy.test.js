import assert from 'node:assert/strict'
import test from 'node:test'

import { registerBrowserTools } from '../server/services/browserTools.js'
import { CONNECTOR_TOOL_NAMES } from '../server/services/connectorTools.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import { resolveTurnToolPolicy, resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'

function namesOf(specs) {
  return specs.map((spec) => spec?.function?.name).filter(Boolean)
}

const allConnectorsEnabled = [...CONNECTOR_TOOL_NAMES]

test('website and file turns expose a compact local execution catalog', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '请生成一个响应式网站，写入项目文件并运行检查',
    messages: [{ role: 'user', content: '生成网站' }],
    enabledConnectorTools: allConnectorsEnabled,
    webSearchReady: true,
  })
  const names = namesOf(specs)

  for (const name of ['create_html_app', 'list_directory', 'read_file', 'read_artifact_source', 'write_file', 'bash_exec', 'run_project_check']) {
    assert.ok(names.includes(name), `${name} missing from compact website catalog`)
  }
  for (const name of ['web_search', 'fetch_url', 'github_search_repositories', 'dropbox_list_files', 'notion_search']) {
    assert.equal(names.includes(name), false, `${name} should require explicit remote intent`)
  }
  assert.ok(names.length < 60, `website catalog unexpectedly contains ${names.length} tools`)
})

test('ordinary and refreshed terse turns keep local execution while omitting unrequested remote schemas', async () => {
  for (const prompt of ['解释一下这个概念', '你来操作', '为什么还是没有写入工具']) {
    const specs = await resolveTurnToolSpecs({
      userId: null,
      baseSpecs: SERVER_TOOL_SPECS,
      prompt,
      messages: [
        { role: 'user', content: '上一轮内容' },
        { role: 'assistant', content: '上一轮回答' },
        { role: 'user', content: prompt },
      ],
      enabledConnectorTools: allConnectorsEnabled,
      webSearchReady: true,
    })
    const names = namesOf(specs)

    for (const name of ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command', 'run_project_check', 'run_test']) {
      assert.ok(names.includes(name), `${prompt}: ${name}`)
    }
    assert.ok(names.includes('request_clarification'))
    assert.equal(names.includes('web_search'), false)
    assert.equal(names.includes('github_search_repositories'), false)
    assert.equal(names.some((name) => name.startsWith('mcp__')), false)
  }
})

test('plan permission mode keeps local execution tools model-visible', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    permissionMode: 'plan',
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '检查项目并说明如何修改，但不要执行。',
    messages: [{ role: 'user', content: '检查项目并说明如何修改，但不要执行。' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const names = namesOf(specs)

  for (const name of ['list_directory', 'read_file', 'grep_code']) {
    assert.ok(names.includes(name), name)
  }
  for (const name of ['git_status', 'git_diff']) {
    assert.equal(names.includes(name), false, `${name} still requires explicit Git intent`)
  }
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command', 'run_project_check', 'run_test']) {
    assert.equal(names.includes(name), true, name)
  }
})

test('Chinese web-search intent survives local-task routing and reports readiness', async () => {
  const prompt = '联网搜索资料并修改 D:\\work\\site.html'
  const readySpecs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt,
    messages: [{ role: 'user', content: prompt }],
    enabledConnectorTools: [],
    webSearchReady: true,
  })
  let unavailableDecision = null
  const unavailableSpecs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt,
    messages: [{ role: 'user', content: prompt }],
    enabledConnectorTools: [],
    webSearchReady: false,
    onDecision: (decision) => { unavailableDecision = decision },
  })

  for (const name of ['web_search', 'fetch_url', 'read_file', 'write_file']) {
    assert.ok(namesOf(readySpecs).includes(name), `${name} should be mounted when ready`)
  }
  assert.equal(namesOf(unavailableSpecs).includes('web_search'), false)
  assert.ok(namesOf(unavailableSpecs).includes('fetch_url'))
  assert.ok(unavailableDecision?.excludedTools.some((entry) => (
    entry.name === 'web_search' && entry.reason === 'web_search_not_ready'
  )))
})

test('ambiguous brand words do not activate remote connectors without provider intent', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: 'Explain linear algebra and the notion of vector spaces.',
    messages: [{ role: 'user', content: 'linear algebra' }],
    enabledConnectorTools: allConnectorsEnabled,
    webSearchReady: false,
  })
  const names = namesOf(specs)

  assert.equal(names.includes('linear_search_issues'), false)
  assert.equal(names.includes('notion_search'), false)
})

test('explicit connector provider intent exposes only that enabled provider', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '请在 GitHub 搜索与 prompt cache 有关的仓库',
    messages: [{ role: 'user', content: 'GitHub search' }],
    enabledConnectorTools: allConnectorsEnabled,
    webSearchReady: true,
  })
  const names = namesOf(specs)

  assert.ok(names.includes('github_search_repositories'))
  assert.ok(names.includes('github_get_file'))
  assert.equal(names.includes('dropbox_list_files'), false)
  assert.equal(names.includes('notion_search'), false)
})

test('recent connector calls keep the same provider available for terse follow-ups', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '继续，再读取上一个结果',
    messages: [{ role: 'tool', name: 'github_search_repositories', content: '{"ok":true}' }],
    enabledConnectorTools: allConnectorsEnabled,
    webSearchReady: false,
  })
  const names = namesOf(specs)

  assert.ok(names.includes('github_get_file'))
  assert.equal(names.includes('dropbox_list_files'), false)
})

test('explicit browser intent loads browser schemas while website generation alone does not', async () => {
  registerBrowserTools()
  const generated = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '创建一个 HTML 网页',
    messages: [{ role: 'user', content: '创建网页' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const inspected = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '在浏览器打开网站并点击登录按钮',
    messages: [{ role: 'user', content: '浏览器验收' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })

  assert.equal(namesOf(generated).some((name) => name.startsWith('browser_')), false)
  assert.ok(namesOf(inspected).includes('browser_navigate'))
  assert.ok(namesOf(inspected).includes('browser_click'))
})

test('MCP continuation exposes sibling tools from the previously used server only', async () => {
  const mcpSpecs = ['mcp__jira_server__search', 'mcp__jira_server__create', 'mcp__docs_server__read'].map((name) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  }))
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: mcpSpecs,
    prompt: '继续处理上一个结果',
    messages: [{ role: 'tool', name: 'mcp__jira_server__search', content: '{}' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })

  assert.deepEqual(namesOf(specs), ['mcp__jira_server__create', 'mcp__jira_server__search'])
})

test('policy keeps legacy catalog behavior only when no turn intent context is provided', () => {
  assert.equal(resolveTurnToolPolicy().legacyFullCatalog, true)
  assert.equal(resolveTurnToolPolicy({ prompt: '你好' }).legacyFullCatalog, false)
})

test('bypass permission mode removes the redundant directory authorization tool', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    permissionMode: 'bypass',
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '修改 D:\\work\\site.html 并验证',
    messages: [{ role: 'user', content: '直接修改文件' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const names = namesOf(specs)

  assert.equal(names.includes('request_directory'), false)
  for (const name of ['read_file', 'write_file', 'edit_file', 'bash_exec']) {
    assert.ok(names.includes(name), `${name} must remain executable in bypass mode`)
  }
})

test('bypass permission mode still honors explicitly disabled execution tools', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    permissionMode: 'bypass',
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: {
      enabled: ['read_file'],
      disabled: ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command'],
    },
    prompt: '修改 D:\\work\\site.html 并验证',
    messages: [{ role: 'user', content: '直接修改文件' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const names = namesOf(specs)

  assert.ok(names.includes('read_file'))
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']) {
    assert.equal(names.includes(name), false, `${name} must remain disabled in bypass mode`)
  }
})
