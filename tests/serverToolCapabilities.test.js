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
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { getBuiltinSpec } = await import('../server/services/toolRegistry.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')

const CLIENT_ONLY_PREVIEW_TOOLS = [
  'create_react_component',
  'create_mermaid',
  'create_chart',
  'create_svg',
  'create_html_app',
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

test('retired client-only preview tools are not advertised as server capabilities', () => {
  const serverNames = new Set(namesOf(SERVER_TOOL_SPECS))
  for (const name of CLIENT_ONLY_PREVIEW_TOOLS) {
    assert.equal(serverNames.has(name), false, `${name} must not be exposed by SERVER_TOOL_SPECS`)
    assert.equal(getBuiltinSpec(name), null, `${name} must not be exposed by the server registry`)
  }
})

test('resolveTurnToolSpecs removes explicitly disabled builtins after merging tools', async () => {
  const resolved = await resolveTurnToolSpecs({
    userId: 'server-tool-capability-test',
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: {
      enabled: ['read_file', 'web_search'],
      disabled: ['list_directory', 'read_file', 'bash_exec'],
    },
  })
  const names = namesOf(resolved)
  assert.equal(names.includes('list_directory'), false)
  assert.equal(names.includes('read_file'), false, 'disabled must win over enabled')
  assert.equal(names.includes('bash_exec'), false)
  assert.equal(names.includes('web_search'), true)
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
