import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildServerToolsConfig,
  buildServerTurnMessageIds,
  collectLocalPathEvidence,
} from '../src/pages/ChatSplit/serverTurnFlow.js'
import { createInitialState } from '../src/store/appStateBootstrap.js'

test('code execution and project checks are enabled by default but explicit switch-offs are preserved', () => {
  const defaults = createInitialState().toolsConfig
  assert.equal(defaults.bash_exec, true)
  assert.equal(defaults.run_project_check, true)
  assert.deepEqual(buildServerToolsConfig(defaults), {
    enabled: [
      'Agent',
      'archive_create',
      'archive_extract',
      'archive_list',
      'bash_exec',
      'batch_rename',
      'create_docx',
      'create_pptx',
      'create_xlsx',
      'file_hash_manifest',
      'image_info',
      'image_transform',
      'manage_todos',
      'media_probe',
      'media_transform',
      'pdf_info',
      'pdf_text',
      'pdf_transform',
      'run_project_check',
    ],
    disabled: [
      'edit_file',
      'fetch_url',
      'git_diff',
      'git_status',
      'list_directory',
      'read_file',
      'write_file',
    ],
  })
  assert.ok(buildServerToolsConfig({ bash_exec: false }).disabled.includes('bash_exec'))
  assert.ok(buildServerToolsConfig({ run_project_check: false }).disabled.includes('run_project_check'))
})

test('buildServerToolsConfig converts boolean switches into stable explicit lists', () => {
  assert.deepEqual(buildServerToolsConfig({
    write_file: false,
    read_file: true,
    bash_exec: false,
    web_search: false,
    create_react_component: true,
    create_mermaid: false,
    create_chart: true,
    create_svg: true,
    create_html_app: true,
    ignored: 'true',
    empty: null,
  }), {
    enabled: ['read_file'],
    disabled: ['bash_exec', 'write_file'],
  })
})

test('web search is controlled only by its dedicated settings page', () => {
  assert.deepEqual(buildServerToolsConfig({ web_search: false }), { enabled: [], disabled: [] })
})

test('buildServerToolsConfig tolerates missing and malformed state', () => {
  assert.deepEqual(buildServerToolsConfig(), { enabled: [], disabled: [] })
  assert.deepEqual(buildServerToolsConfig(null), { enabled: [], disabled: [] })
})

test('successful code tools remain available to an execution follow-up', () => {
  const history = [
    { role: 'tool', name: 'write_file', content: JSON.stringify({ ok: true, path: 'script.py' }) },
    { role: 'tool', name: 'edit_file', content: JSON.stringify({ ok: false, error: 'failed' }) },
  ]
  assert.deepEqual(buildServerToolsConfig({
    bash_exec: true,
    write_file: false,
    edit_file: false,
  }, {}, history), {
    enabled: ['bash_exec', 'list_directory', 'read_file', 'write_file'],
    disabled: ['edit_file'],
  })

  assert.deepEqual(buildServerToolsConfig({
    bash_exec: false,
    write_file: false,
  }, {}, history), {
    enabled: [],
    disabled: ['bash_exec', 'write_file'],
  })
})

test('a writable execution turn always retains readback and directory verification tools', () => {
  assert.deepEqual(buildServerToolsConfig({
    bash_exec: true,
    write_file: true,
    list_directory: false,
    read_file: false,
  }), {
    enabled: ['bash_exec', 'list_directory', 'read_file', 'write_file'],
    disabled: [],
  })
})

test('authorized local paths override disabled filesystem switches with least privilege', () => {
  assert.deepEqual(buildServerToolsConfig({
    list_directory: false,
    read_file: false,
    write_file: false,
    edit_file: false,
  }, {
    paths: ['D:\\destok\\project\\README.md'],
    accessMode: 'read_only',
    resources: [{ path: 'D:\\destok\\project\\README.md', resourceType: 'file' }],
  }), {
    enabled: ['read_file'],
    disabled: ['edit_file', 'list_directory', 'write_file'],
  })
})

test('directory grants retain directory discovery while exact files do not', () => {
  assert.deepEqual(buildServerToolsConfig({ list_directory: false, read_file: false }, {
    paths: ['D:\\destok\\project'],
    accessMode: 'read_only',
    resources: [{ path: 'D:\\destok\\project', resourceType: 'directory' }],
  }), {
    enabled: ['list_directory', 'read_file'],
    disabled: [],
  })
})

test('server turn message ids share the durable turn id and reject missing ids', () => {
  assert.deepEqual(buildServerTurnMessageIds('turn-1'), {
    userId: 'turn-1:user',
    assistantId: 'turn-1:assistant',
  })
  assert.throws(() => buildServerTurnMessageIds('  '), /turnId is required/)
})

test('local path probe failures become evidence instead of blocking the server turn', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  const evidence = await collectLocalPathEvidence({
    localPathAccess: { paths: ['D:\\demo'], accessMode: 'read_only' },
    probeLocalPathAccess: async (_access, options) => {
      receivedSignal = options.signal
      throw new Error('probe transport failed')
    },
    signal: controller.signal,
  })

  assert.equal(receivedSignal, controller.signal)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].ok, false)
  assert.deepEqual(JSON.parse(evidence[0].content), {
    code: 'LOCAL_PATH_PROBE_FAILED',
    error: 'probe transport failed',
  })
})

test('local path evidence still propagates an explicit user abort', async () => {
  await assert.rejects(collectLocalPathEvidence({
    localPathAccess: { paths: ['D:\\demo'], accessMode: 'read_only' },
    probeLocalPathAccess: async () => {
      throw Object.assign(new Error('stopped'), { name: 'AbortError' })
    },
    signal: new AbortController().signal,
  }), { name: 'AbortError' })
})
