import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpServerFromPreset, findInstalledMcpPreset, getMcpServerPreset, MCP_SERVER_PRESETS } from '../src/lib/mcpPresets.js'
import { lookup, translations } from '../src/i18n/translations.js'

test('Chrome DevTools MCP preset uses the official stdio package', () => {
  const preset = createMcpServerFromPreset('chrome-devtools')
  assert.equal(MCP_SERVER_PRESETS.length, 2)
  assert.equal(preset.name, 'chrome_devtools')
  assert.equal(preset.transport, 'stdio')
  assert.equal(preset.command, 'npx')
  assert.deepEqual(preset.args, ['-y', 'chrome-devtools-mcp@latest'])
  assert.equal(preset.enabled, true)
  assert.equal(getMcpServerPreset('chrome-devtools')?.publisher, 'Google')
  assert.equal(getMcpServerPreset('chrome-devtools')?.official, true)
})

test('Filesystem preset stays available in advanced MCP setup without duplicating Access', () => {
  const preset = createMcpServerFromPreset('filesystem')
  assert.equal(preset.name, 'filesystem')
  assert.deepEqual(preset.args, ['-y', '@modelcontextprotocol/server-filesystem', '.'])
  assert.equal(getMcpServerPreset('filesystem')?.showInAccess, false)
})

test('MCP preset returns independent mutable editor values', () => {
  const first = createMcpServerFromPreset('chrome-devtools')
  const second = createMcpServerFromPreset('chrome-devtools')
  first.args.push('--headless')
  first.headers.Authorization = 'Bearer test'
  assert.deepEqual(second.args, ['-y', 'chrome-devtools-mcp@latest'])
  assert.deepEqual(second.headers, {})
  assert.equal(createMcpServerFromPreset('missing'), null)
  assert.equal(findInstalledMcpPreset([{ id: 'server-1', name: 'chrome_devtools' }], 'chrome-devtools')?.id, 'server-1')
  assert.equal(findInstalledMcpPreset([], 'chrome-devtools'), null)
})

test('Chrome DevTools MCP preset and Access installer have complete five-language copy', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(lookup(translations[lang], 'mcp.chromeDevtoolsPreset'))
    for (const key of ['access.filterMcp', 'access.mcpTitle', 'access.capabilityMcp', 'access.chromeDevtoolsMcpDesc', 'access.installMcp', 'access.mcpReady']) {
      assert.ok(lookup(translations[lang], key), `${lang} missing ${key}`)
    }
  }
})
