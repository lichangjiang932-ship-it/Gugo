import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-server-tool-capabilities', String(process.pid))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-server-tool-workspace-'))
fs.writeFileSync(path.join(workspace, 'visible.txt'), 'visible', 'utf8')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { SERVER_TURN_TOOL_TOGGLE_NAMES } = await import('../src/lib/serverToolConfig.js')
const { FS_SHELL_TOOL_SPECS } = await import('../server/adapters/fsShellTools.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')
const { createUser, setUserToolPermission } = await import('../server/db.js')
const {
  getBuiltinSpec,
  getToolMetadata,
  handleToolSpecsRequest,
  listBuiltinSpecs,
  registerDynamicTool,
  resolveSpecsForMode,
  unregisterDynamicTool,
} = await import('../server/services/toolRegistry.js')
const { BUILTIN_TOOL_SCHEMA_CATALOG } = await import('../server/utils/toolSchemaCatalog.js')
const { normalizeToolCalls, validateToolCall } = await import('../server/utils/toolCallHarness.js')
const { CONNECTOR_TOOL_NAMES } = await import('../server/services/connectorTools.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { closeLspRuntime, startLspRuntime } = await import('../server/services/lspRuntime.js')
const { executeServerTool } = await import('../server/services/toolLoopHeuristics.js')

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

test('only bash_exec receives command-aware concurrency metadata', () => {
  const readOnly = getToolMetadata('bash_exec', { args: { command: 'git status --short' } })
  assert.equal(readOnly.isReadOnly, true)
  assert.equal(readOnly.isConcurrencySafe, true)

  const mutating = getToolMetadata('bash_exec', { args: { command: 'node -e "require(\'fs\').writeFileSync(\'out.txt\', \'x\')"' } })
  assert.equal(mutating.isReadOnly, false)
  assert.equal(mutating.isConcurrencySafe, false)

  const runner = getToolMetadata('run_command', { args: { command: 'git diff --stat' } })
  assert.equal(runner.riskClass, 'exec')
  assert.equal(runner.requiresApproval, true)
  assert.equal(runner.isReadOnly, false)
  assert.equal(runner.isConcurrencySafe, false)
})

test('core execution tools survive the canonical turn catalog when enabled', async () => {
  const required = [
    'write_file',
    'apply_patch',
    'patch_file',
    'bash_exec',
    'run_code',
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

test('resolveTurnToolSpecs removes explicitly disabled builtins from model-visible schemas', async () => {
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
  assert.equal(names.includes('list_directory'), false)
  assert.equal(names.includes('read_file'), false)
  assert.equal(names.includes('bash_exec'), false)
  assert.equal(names.includes('web_search'), true)
  assert.equal(names.includes('set_deliverables'), true)
})

test('registry, API resolution, and TurnEngine retain the canonical schema object references', () => {
  const apiEntries = resolveSpecsForMode('chat')
  for (const spec of listBuiltinSpecs()) {
    const name = spec.function.name
    assert.equal(spec, BUILTIN_TOOL_SCHEMA_CATALOG[name], `${name} catalog identity`)
    assert.equal(getBuiltinSpec(name), spec, `${name} registry identity`)
    if (name === 'lsp' || name === 'codex_models') {
      assert.equal(
        apiEntries.find((entry) => entry.name === name),
        undefined,
        'optional runtime capability stays hidden until its provider is ready',
      )
    } else {
      assert.equal(
        apiEntries.find((entry) => entry.name === name)?.tool,
        spec,
        `${name} API identity`,
      )
    }
    assert.equal(
      SERVER_TOOL_SPECS.find((candidate) => candidate?.function?.name === name),
      spec,
      `${name} TurnEngine identity`,
    )
  }
})

test('a server-only dynamic tool reaches the API and validator with one schema definition', (t) => {
  const name = 'server_only_schema_regression_tool'
  const spec = {
    type: 'function',
    function: {
      name,
      description: 'Regression schema registered only on the server.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'integer', minimum: 1 } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }
  registerDynamicTool({ name, origin: 'test', spec })
  t.after(() => unregisterDynamicTool(name))

  const resolved = resolveSpecsForMode('chat').find((entry) => entry.name === name)
  assert.deepEqual(resolved?.tool, spec)
  assert.notEqual(resolved?.tool, spec)

  const [invalid] = normalizeToolCalls([{ name, arguments: '{"value":0}' }])
  const validation = validateToolCall(invalid, [resolved.tool])
  assert.equal(validation.code, 'tool_arguments_validation_failed')
  assert.match(validation.issues.join('\n'), /不能小于 1/)

  let status = 0
  let body = ''
  handleToolSpecsRequest(
    { method: 'GET', url: '/api/tools/specs?mode=chat', headers: {} },
    {
      writeHead(nextStatus) { status = nextStatus },
      end(chunk) { body += String(chunk || '') },
    },
  )
  assert.equal(status, 200)
  const apiSpec = JSON.parse(body).specs.find((entry) => entry.name === name)?.tool
  assert.deepEqual(apiSpec, spec)

  status = 0
  body = ''
  handleToolSpecsRequest(
    { method: 'GET', url: '/api/tools/specs?mode=plan', headers: {} },
    {
      writeHead(nextStatus) { status = nextStatus },
      end(chunk) { body += String(chunk || '') },
    },
  )
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).specs.some((entry) => entry.name === name), false)
})

test('user-disabled tools are removed from model-visible schemas', async () => {
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

  assert.equal(namesOf(resolved).includes('bash_exec'), false)
  assert.equal(namesOf(resolved).includes('run_project_check'), true)
  assert.equal(namesOf(resolved).includes('set_deliverables'), true)
})

test('explicit turn switches remove disabled read and write schemas', async () => {
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
  assert.equal(names.includes('read_file'), false)
  assert.equal(names.includes('list_directory'), false)
  assert.equal(names.includes('edit_file'), false)
  assert.ok(names.includes('set_deliverables'))
})

test('explicit turn switches remove disabled Git schemas', async () => {
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
  assert.ok(names.includes('git_commit'))
  assert.equal(names.includes('git_status'), false)
  assert.equal(names.includes('git_diff'), false)
})

test('every bash_exec spec tells models to quote Windows absolute paths', () => {
  const fsShellSpec = FS_SHELL_TOOL_SPECS.find((spec) => spec?.function?.name === 'bash_exec')
  const registrySpec = getBuiltinSpec('bash_exec')
  assert.equal(registrySpec, fsShellSpec)
  const descriptions = [
    fsShellSpec?.function?.description,
    registrySpec?.function?.description,
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
    approvalPrincipal: trustedInternalLoopPrincipal(),
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

test('lsp advertised by the server has a real executor that forwards user authorization and AbortSignal', async () => {
  const lspWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-server-lsp-executor-'))
  const sourceFile = path.join(lspWorkspace, 'source.js')
  const userId = `server-lsp-executor-${process.pid}-${Date.now()}`
  const ungrantedUserId = `${userId}-ungranted`
  const controller = new AbortController()
  const calls = []
  fs.writeFileSync(sourceFile, 'const value = 1\n', 'utf8')
  createUser({ id: userId, email: `${userId}@example.com` })
  createUser({ id: ungrantedUserId, email: `${ungrantedUserId}@example.com` })
  grantLocalPath({ userId, rootPath: lspWorkspace, accessMode: 'read_only' })

  const command = fs.realpathSync.native(process.execPath)
  await closeLspRuntime()
  try {
    const status = await startLspRuntime({
      env: {
        LSP_STDIO_COMMAND_ALLOWLIST: JSON.stringify([command]),
        LSP_STDIO_PROVIDERS: JSON.stringify([{
          id: 'server-executor-test',
          command,
          extensionToLanguage: { '.js': 'javascript' },
        }]),
      },
      createProvider: async (config) => ({
        id: config.id,
        extensionToLanguage: config.extensionToLanguage,
        async query(request, signal) {
          calls.push({ request, signal })
          return {
            kind: 'locations',
            resolvedWorkspaceUri: pathToFileURL(lspWorkspace).href,
            locations: [{
              uri: pathToFileURL(sourceFile).href,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            }],
          }
        },
        async close() {},
      }),
    })
    assert.equal(status.enabled, true)

    const args = {
      operation: 'goToDefinition',
      file: sourceFile,
      line: 1,
      character: 1,
      workspace_root: lspWorkspace,
    }
    const denied = await executeServerTool({
      name: 'lsp',
      args,
      job: { userId: ungrantedUserId },
      signal: controller.signal,
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'PATH_NOT_AUTHORIZED')
    assert.equal(calls.length, 0)

    const result = await executeServerTool({
      name: 'lsp',
      args,
      job: { userId },
      signal: controller.signal,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal, controller.signal)
    assert.equal(calls[0].request.filePath, fs.realpathSync(sourceFile))
    assert.equal(calls[0].request.workspaceRoot, fs.realpathSync(lspWorkspace))
    assert.deepEqual(calls[0].request.position, { line: 0, character: 0 })

    const spec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'lsp')
    let loopToolResult = null
    const loopResult = await runToolsLoop({
      job: { id: 'lsp-tool-loop-job', userId, prompt: 'find the definition' },
      step: { id: 'lsp-tool-loop-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'find the definition' }],
      signal: controller.signal,
      toolSpecs: [spec],
      maxIters: 2,
      enableToolHooks: false,
      approvalPrincipal: trustedInternalLoopPrincipal(),
      runModel: async ({ messages }) => {
        const toolMessage = messages.find((message) => (
          message.role === 'tool' && message.name === 'lsp'
        ))
        if (toolMessage) {
          loopToolResult = JSON.parse(toolMessage.content)
          return { content: 'definition resolved', toolCalls: [] }
        }
        return {
          content: '',
          toolCalls: [{
            id: 'lsp-loop-call',
            type: 'function',
            function: { name: 'lsp', arguments: JSON.stringify(args) },
          }],
        }
      },
    })

    assert.equal(loopResult.text, 'definition resolved')
    assert.equal(loopToolResult?.ok, true)
    assert.ok(Array.isArray(loopToolResult?.locations))
    assert.equal(loopToolResult.locations.length, 1)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].signal, controller.signal)
  } finally {
    await closeLspRuntime()
    fs.rmSync(lspWorkspace, { recursive: true, force: true })
  }
})
