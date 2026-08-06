import assert from 'node:assert/strict'
import test from 'node:test'

import { buildServerToolsConfig, buildServerTurnMessageIds, collectLocalPathEvidence } from '../src/pages/ChatSplit/serverTurnFlow.js'

test('buildServerToolsConfig converts boolean switches into stable explicit lists', () => {
  assert.deepEqual(buildServerToolsConfig({
    write_file: false,
    read_file: true,
    bash_exec: false,
    web_search: true,
    create_react_component: true,
    create_mermaid: false,
    create_chart: true,
    create_svg: true,
    create_html_app: true,
    ignored: 'true',
    empty: null,
  }), {
    enabled: ['read_file', 'web_search'],
    disabled: ['bash_exec', 'write_file'],
  })
})

test('buildServerToolsConfig tolerates missing and malformed state', () => {
  assert.deepEqual(buildServerToolsConfig(), { enabled: [], disabled: [] })
  assert.deepEqual(buildServerToolsConfig(null), { enabled: [], disabled: [] })
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
  }), {
    enabled: ['list_directory', 'read_file'],
    disabled: ['edit_file', 'write_file'],
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
