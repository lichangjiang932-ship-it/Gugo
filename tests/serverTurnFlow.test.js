import assert from 'node:assert/strict'
import test from 'node:test'

import { buildServerToolsConfig } from '../src/pages/ChatSplit/serverTurnFlow.js'

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
