import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpServerFromPreset, findInstalledMcpPreset, getMcpServerPreset, MCP_SERVER_PRESETS } from '../src/lib/mcpPresets.js'
import { lookup, translations } from '../src/i18n/translations.js'

test('Chrome DevTools MCP preset uses the official stdio package', () => {
  const preset = createMcpServerFromPreset('chrome-devtools')
  assert.equal(MCP_SERVER_PRESETS.length, 11)
  assert.equal(preset.name, 'chrome_devtools')
  assert.equal(preset.transport, 'stdio')
  assert.equal(preset.command, 'npx')
  assert.deepEqual(preset.args, ['-y', 'chrome-devtools-mcp@latest'])
  assert.equal(preset.enabled, true)
  assert.equal(getMcpServerPreset('chrome-devtools')?.publisher, 'Google')
  assert.equal(getMcpServerPreset('chrome-devtools')?.official, true)
})

test('New official one-click presets (fetch / sequential-thinking / memory / playwright) are well-formed', () => {
  const expectations = [
    ['fetch', 'fetch', ['-y', '@modelcontextprotocol/server-fetch']],
    ['sequential-thinking', 'sequential_thinking', ['-y', '@modelcontextprotocol/server-sequential-thinking']],
    ['memory', 'memory', ['-y', '@modelcontextprotocol/server-memory']],
    ['playwright', 'playwright', ['-y', '@playwright/mcp@latest']],
  ]
  for (const [id, name, args] of expectations) {
    const preset = createMcpServerFromPreset(id)
    assert.ok(preset, `${id} preset resolves`)
    assert.equal(preset.name, name)
    assert.equal(preset.transport, 'stdio')
    assert.equal(preset.command, 'npx')
    assert.deepEqual(preset.args, args)
    assert.equal(preset.enabled, true)
    assert.equal(getMcpServerPreset(id)?.official, true)
    assert.notEqual(getMcpServerPreset(id)?.showInAccess, false, `${id} should appear in Access`)
  }
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

test('Chrome DevTools MCP preset and Access installer have complete bilingual copy', () => {
  for (const lang of ['zh', 'en']) {
    assert.ok(lookup(translations[lang], 'mcp.chromeDevtoolsPreset'))
    for (const key of ['access.filterMcp', 'access.mcpTitle', 'access.capabilityMcp', 'access.chromeDevtoolsMcpDesc', 'access.installMcp', 'access.mcpReady']) {
      assert.ok(lookup(translations[lang], key), `${lang} missing ${key}`)
    }
  }
})

test('New MCP presets ship bilingual descriptions', () => {
  for (const lang of ['zh', 'en']) {
    for (const key of ['access.fetchMcpDesc', 'access.fetchMcpHint', 'access.sequentialThinkingMcpDesc', 'access.sequentialThinkingMcpHint', 'access.memoryMcpDesc', 'access.memoryMcpHint', 'access.playwrightMcpDesc', 'access.playwrightMcpHint']) {
      assert.ok(lookup(translations[lang], key), `${lang} missing ${key}`)
    }
  }
})

test('Credential-backed official presets (github / brave-search / slack / postgres) are well-formed', () => {
  const expectations = [
    ['github', 'github', ['-y', '@modelcontextprotocol/server-github'], ['GITHUB_PERSONAL_ACCESS_TOKEN']],
    ['brave-search', 'brave_search', ['-y', '@modelcontextprotocol/server-brave-search'], ['BRAVE_API_KEY']],
    ['slack', 'slack', ['-y', '@modelcontextprotocol/server-slack'], ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID']],
    ['postgres', 'postgres', ['-y', '@modelcontextprotocol/server-postgres'], ['POSTGRES_DSN']],
  ]
  for (const [id, name, args, envKeys] of expectations) {
    const preset = createMcpServerFromPreset(id)
    assert.ok(preset, `${id} preset resolves`)
    assert.equal(preset.name, name)
    assert.equal(preset.transport, 'stdio')
    assert.equal(preset.command, 'npx')
    assert.deepEqual(preset.args, args)
    assert.deepEqual(Object.keys(preset.env).sort(), [...envKeys].sort(), `${id} exposes credential env slots`)
    assert.equal(getMcpServerPreset(id)?.official, true)
    // env placeholders must be empty strings so the editor prompts the user to fill them
    for (const key of envKeys) assert.equal(preset.env[key], '', `${id}.${key} starts empty`)
  }
})

test('Puppeteer preset is a zero-credential browser automation option', () => {
  const preset = createMcpServerFromPreset('puppeteer')
  assert.equal(preset.name, 'puppeteer')
  assert.deepEqual(preset.args, ['-y', '@modelcontextprotocol/server-puppeteer'])
  assert.deepEqual(preset.env, {})
})

test('New credential-backed MCP presets ship bilingual copy', () => {
  const keys = [
    'access.githubMcpDesc', 'access.githubMcpHint',
    'access.braveSearchMcpDesc', 'access.braveSearchMcpHint',
    'access.slackMcpDesc', 'access.slackMcpHint',
    'access.postgresMcpDesc', 'access.postgresMcpHint',
    'access.puppeteerMcpDesc', 'access.puppeteerMcpHint',
  ]
  for (const lang of ['zh', 'en']) {
    for (const key of keys) {
      assert.ok(lookup(translations[lang], key), `${lang} missing ${key}`)
    }
  }
})
