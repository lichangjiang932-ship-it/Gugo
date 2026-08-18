import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-server-tool-capabilities', String(process.pid))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-server-tool-workspace-'))
fs.writeFileSync(path.join(workspace, 'visible.txt'), 'visible', 'utf8')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { SERVER_TURN_TOOL_TOGGLE_NAMES } = await import('../src/lib/serverToolConfig.js')
const { WORKSPACE_TOOL_SPECS } = await import('../src/lib/tools/workspaceToolSpecs.js')
const { FS_SHELL_TOOL_SPECS } = await import('../server/adapters/fsShellTools.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { createUser, setUserToolPermission } = await import('../server/db.js')
const { getBuiltinSpec, getToolMetadata, listBuiltinSpecs } = await import('../server/services/toolRegistry.js')
const { CONNECTOR_TOOL_NAMES } = await import('../server/services/connectorTools.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')

const CLIENT_ONLY_PREVIEW_TOOLS = [
  'create_react_component',
  'create_mermaid',
  'create_chart',
  'create_svg',
]

function namesOf(specs) {
  return specs.map((spec) => spec?.function?.name).filter(Boolean)
}

test.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

test('every server turn switch maps to an executable server tool spec', () => {
  const serverNames = new Set(namesOf(SERVER_TOOL_SPECS))
  for (const name of SERVER_TURN_TOOL_TOGGLE_NAMES) {
    assert.ok(serverNames.has(name), `${name} is configurable but missing from SERVER_TOOL_SPECS`)
  }
})

test('TurnEngine static schemas come from the canonical server registry', () => {
  const connectorNames = new Set(CONNECTOR_TOOL_NAMES)
  const runtimeBuiltinNames = namesOf(SERVER_TOOL_SPECS)
    .filter((name) => !connectorNames.has(name))
    .sort()
  const registryNames = namesOf(listBuiltinSpecs()).sort()
  assert.deepEqual(runtimeBuiltinNames, registryNames)
})

test('retired client-only preview tools are not advertised as server capabilities', () => {
  const serverNames = new Set(namesOf(SERVER_TOOL_SPECS))
  for (const name of CLIENT_ONLY_PREVIEW_TOOLS) {
    assert.equal(serverNames.has(name), false, `${name} must not be exposed by SERVER_TOOL_SPECS`)
    assert.equal(getBuiltinSpec(name), null, `${name} must not be exposed by the server registry`)
  }
})

test('HTML artifact generation is an executable server capability', () => {
  const serverNames = new Set(namesOf(SERVER_TOOL_SPECS))
  assert.equal(serverNames.has('create_html_app'), true)
})

test('run_command and bash_exec share command-aware concurrency metadata', () => {
  for (const name of ['bash_exec', 'run_command']) {
    const readOnly = getToolMetadata(name, { args: { command: 'git status --short' } })
    assert.equal(readOnly.isReadOnly, true, `${name} read-only command classification`)
    assert.equal(readOnly.isConcurrencySafe, true, `${name} read-only command concurrency`)

    const mutating = getToolMetadata(name, { args: { command: 'node -e "require(\'fs\').writeFileSync(\'out.txt\', \'x\')"' } })
    assert.equal(mutating.isReadOnly, false, `${name} mutating command classification`)
    assert.equal(mutating.isConcurrencySafe, false, `${name} mutating command concurrency`)
  }

  const cmdAlias = getToolMetadata('run_command', { args: { cmd: 'git diff --stat' } })
  assert.equal(cmdAlias.isReadOnly, true)
  assert.equal(cmdAlias.isConcurrencySafe, true)
})

test('core execution tools survive the canonical turn catalog when enabled', async () => {
  const required = [
    'write_file',
    'apply_patch',
    'patch_file',
    'bash_exec',
    'run_command',
    'run_test',
    'docker_exec',
    'file_download',
    'git_commit',
    'git_push',
    'git_rollback',
    'git_write',
    'pdf_transform',
    'create_pdf',
  ]
  const serverNames = new Set(namesOf(SERVER_TOOL_SPECS))
  const toggleNames = new Set(SERVER_TURN_TOOL_TOGGLE_NAMES)
  for (const name of required) {
    assert.ok(serverNames.has(name), `${name} is missing from TurnEngine specs`)
    assert.ok(getBuiltinSpec(name), `${name} is missing from the canonical registry`)
    assert.ok(toggleNames.has(name), `${name} cannot be enabled from the tool catalog`)
  }

  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: { enabled: required, disabled: [] },
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const resolvedNames = new Set(namesOf(resolved))
  for (const name of required) {
    assert.ok(resolvedNames.has(name), `${name} was dropped before the model turn`)
  }
})

test('resolveTurnToolSpecs keeps explicitly disabled builtins discoverable after merging tools', async () => {
  const resolved = await resolveTurnToolSpecs({
    userId: 'server-tool-capability-test',
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: {
      enabled: ['read_file', 'web_search'],
      disabled: ['list_directory', 'read_file', 'bash_exec'],
    },
    webSearchReady: true,
  })
  const names = namesOf(resolved)
  assert.equal(names.includes('list_directory'), true)
  assert.equal(names.includes('read_file'), true)
  assert.equal(names.includes('bash_exec'), true)
  assert.equal(names.includes('web_search'), true)
  assert.equal(names.includes('set_deliverables'), true)
})

test('model-visible schemas remain stable when the authoritative server permission gate disables execution', async () => {
  const userId = 'server-tool-schema-permission-user'
  createUser({ id: userId, email: 'server-tool-schema-permission@example.com' })
  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: false })
  const resolved = await resolveTurnToolSpecs({
    userId,
    permissionMode: 'normal',
    baseSpecs: SERVER_TOOL_SPECS,
    prompt: '运行项目检查',
    messages: [{ role: 'user', content: '运行项目检查' }],
    enabledConnectorTools: [],
    webSearchReady: false,
  })

  assert.equal(namesOf(resolved).includes('bash_exec'), true)
  assert.equal(namesOf(resolved).includes('run_project_check'), true)
  assert.equal(namesOf(resolved).includes('set_deliverables'), true)
})

test('writable turns retain read-only verification tools despite legacy client defaults', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: {
      enabled: ['bash_exec', 'write_file'],
      disabled: ['edit_file', 'list_directory', 'read_file'],
    },
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const names = specs.map((spec) => spec?.function?.name)

  assert.ok(names.includes('write_file'))
  assert.ok(names.includes('read_file'))
  assert.ok(names.includes('list_directory'))
  assert.ok(names.includes('edit_file'), 'an explicitly disabled write tool stays discoverable')
  assert.ok(names.includes('set_deliverables'))
})

test('Git mutation turns retain status and diff for preflight and verification', async () => {
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: {
      enabled: ['git_commit'],
      disabled: ['git_status', 'git_diff'],
    },
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  const names = namesOf(specs)
  for (const name of ['git_commit', 'git_status', 'git_diff']) assert.ok(names.includes(name), name)
})

test('every bash_exec spec tells models to quote Windows absolute paths', () => {
  const fsShellSpec = FS_SHELL_TOOL_SPECS.find((spec) => spec?.function?.name === 'bash_exec')
  const descriptions = [
    fsShellSpec?.function?.description,
    getBuiltinSpec('bash_exec')?.function?.description,
    WORKSPACE_TOOL_SPECS.bash_exec?.function?.description,
  ]

  for (const description of descriptions) {
    assert.match(description || '', /Windows/i)
    assert.match(description || '', /(?:double quotes|双引号)/i)
    assert.match(description || '', /(?:every absolute path|每个绝对路径)/i)
  }
})

test('resolveTurnToolSpecs keeps web search discoverable before dedicated configuration is ready', async () => {
  const baseSpecs = [getBuiltinSpec('web_search'), getBuiltinSpec('fetch_url')]
  const hidden = await resolveTurnToolSpecs({ userId: 'search-unconfigured', baseSpecs, webSearchReady: false })
  const visible = await resolveTurnToolSpecs({ userId: 'search-configured', baseSpecs, webSearchReady: true })
  assert.deepEqual(namesOf(hidden), ['fetch_url', 'set_deliverables', 'web_search'])
  assert.deepEqual(namesOf(visible), ['fetch_url', 'set_deliverables', 'web_search'])
})

test('resolveTurnToolSpecs advertises only connector tools backed by enabled integrations', async () => {
  const readFile = getBuiltinSpec('read_file')
  const github = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'github_search_repositories')
  const dropbox = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'dropbox_list_files')
  const resolved = await resolveTurnToolSpecs({
    userId: 'connector-filter-test',
    baseSpecs: [readFile, github, dropbox],
    enabledConnectorTools: ['github_search_repositories'],
    webSearchReady: false,
  })
  assert.deepEqual(namesOf(resolved), ['github_search_repositories', 'read_file', 'set_deliverables'])
})

test('resolveTurnToolSpecs canonicalizes equivalent schema object order for prompt caching', async () => {
  const schemaA = {
    type: 'function',
    function: {
      name: 'stable_schema_tool',
      description: 'Stable schema',
      parameters: {
        type: 'object',
        properties: {
          beta: { description: 'second', type: 'string' },
          alpha: { type: 'integer', description: 'first' },
        },
        required: ['alpha', 'beta'],
      },
    },
  }
  const schemaB = {
    function: {
      parameters: {
        required: ['alpha', 'beta'],
        properties: {
          alpha: { description: 'first', type: 'integer' },
          beta: { type: 'string', description: 'second' },
        },
        type: 'object',
      },
      description: 'Stable schema',
      name: 'stable_schema_tool',
    },
    type: 'function',
  }
  const resolve = (spec) => resolveTurnToolSpecs({
    userId: 'stable-schema-user',
    baseSpecs: [spec],
    enabledConnectorTools: [],
    webSearchReady: false,
  })

  const [first, second] = await Promise.all([resolve(schemaA), resolve(schemaB)])
  const firstSpec = first.find((spec) => spec.function.name === 'stable_schema_tool')
  const secondSpec = second.find((spec) => spec.function.name === 'stable_schema_tool')
  assert.equal(JSON.stringify(firstSpec), JSON.stringify(secondSpec))
})

test('list_directory advertised by the server has a real executor', async () => {
  const spec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  let toolResult = null
  const result = await runToolsLoop({
    job: { id: 'list-directory-job', userId: null, prompt: 'list files' },
    step: { id: 'list-directory-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'list files' }],
    toolSpecs: [spec],
    maxIters: 2,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      const toolMessage = messages.find((message) => message.role === 'tool' && message.name === 'list_directory')
      if (toolMessage) {
        toolResult = JSON.parse(toolMessage.content)
        return { content: 'directory listed', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'list-directory-call',
          type: 'function',
          function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
        }],
      }
    },
  })

  assert.equal(result.text, 'directory listed')
  assert.equal(toolResult?.ok, true)
  assert.ok(toolResult.entries.some((item) => item.name === 'visible.txt'))
})
