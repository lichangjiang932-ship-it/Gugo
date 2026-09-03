import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildExternalMcpConfig,
  isValidMcpAccessKey,
  MCP_EXTERNAL_APPS,
} from '../src/lib/mcpExternalConfig.js'
import { lookup, translations } from '../src/i18n/translations.js'

test('external MCP catalog covers popular desktop clients', () => {
  assert.deepEqual(MCP_EXTERNAL_APPS.map((app) => app.id), [
    'claude', 'cursor', 'vscode', 'cline', 'windsurf', 'cherry', 'codex',
  ])
})

test('external MCP configs include endpoint and temporary access key', () => {
  const endpoint = 'https://atelier.example/mcp'
  for (const app of MCP_EXTERNAL_APPS) {
    const config = buildExternalMcpConfig(app.id, endpoint, 'ymak_real-key_123')
    assert.match(config, /https:\/\/atelier\.example\/mcp/)
    assert.match(config, /Bearer ymak_real-key_123/)
  }
  assert.match(buildExternalMcpConfig('vscode', endpoint), /"servers"/)
  assert.match(buildExternalMcpConfig('windsurf', endpoint), /"serverUrl"/)
  assert.match(buildExternalMcpConfig('codex', endpoint), /\[mcp_servers\.gugo\]/)
})

test('external MCP access key validation accepts only ymak keys or an empty placeholder', () => {
  assert.equal(isValidMcpAccessKey(''), true)
  assert.equal(isValidMcpAccessKey(' ymak_abc-123_X '), true)
  assert.equal(isValidMcpAccessKey('github_pat_123'), false)
  assert.throws(() => buildExternalMcpConfig('unknown', '/mcp'), /Unsupported MCP application/)
})

test('external MCP connection panel has complete bilingual copy', () => {
  for (const lang of ['zh', 'en']) {
    for (const key of ['title', 'createKey', 'keyLabel', 'keyPrivacy', 'invalidKey', 'copy', 'copyError']) {
      assert.ok(lookup(translations[lang], `mcpExternal.${key}`), `${lang} is missing ${key}`)
    }
    for (const key of ['title', 'subtitle', 'addServer', 'confirmDelete', 'testConnection', 'transportHint']) {
      assert.ok(lookup(translations[lang], `mcp.${key}`), `${lang} is missing MCP ${key}`)
    }
  }
})

test('MCP server manager exposes presets, live catalog, and key-value configuration', () => {
  const source = fs.readFileSync(new URL('../src/pages/McpServersView.jsx', import.meta.url), 'utf8')
  const controller = fs.readFileSync(new URL('../src/pages/mcp/useMcpServersController.js', import.meta.url), 'utf8')
  const editor = fs.readFileSync(new URL('../src/pages/mcp/McpServerEditor.jsx', import.meta.url), 'utf8')
  const serverList = fs.readFileSync(new URL('../src/pages/mcp/McpServerList.jsx', import.meta.url), 'utf8')
  const combined = `${source}\n${controller}\n${editor}\n${serverList}`
  assert.match(source, /MCP_SERVER_PRESETS/)
  assert.match(source, /choosePreset\(event\.target\.value\)/)
  assert.match(controller, /getMcpCatalogApi\(\)/)
  assert.match(controller, /parseKeyValueLines\(payload\.envText\)/)
  assert.match(controller, /parseKeyValueLines\(payload\.headersText\)/)
  assert.match(editor, /editing\.envText/)
  assert.match(editor, /editing\.headersText/)
  assert.match(serverList, /selectServer\(server\); controller\.test\(server\.id\)/)
  let depth = 0
  let maxDepth = 0
  for (const match of combined.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1
    maxDepth = Math.max(maxDepth, depth)
  }
  assert.equal(maxDepth, 1)
  assert.doesNotMatch(source, /href="\/mobile-keys"/)
})

test('MCP manager follows the quiet settings surface hierarchy', () => {
  const view = fs.readFileSync(new URL('../src/pages/McpServersView.jsx', import.meta.url), 'utf8')
  const editor = fs.readFileSync(new URL('../src/pages/mcp/McpServerEditor.jsx', import.meta.url), 'utf8')
  const serverList = fs.readFileSync(new URL('../src/pages/mcp/McpServerList.jsx', import.meta.url), 'utf8')
  const external = fs.readFileSync(new URL('../src/components/McpExternalConnectPanel.jsx', import.meta.url), 'utf8')
  const combined = `${view}\n${editor}\n${serverList}\n${external}`

  assert.match(view, /max-w-\[1180px\]/)
  assert.match(view, /lg:grid-cols-\[320px_minmax\(0,1fr\)\]/)
  assert.match(editor, /rounded-lg border border-ink\/10 bg-paper/)
  assert.match(serverList, /rounded-lg border border-ink\/10 bg-paper/)
  assert.match(external, /rounded-lg border border-ink\/10 bg-paper/)
  assert.match(combined, /border border-ink bg-ink/)
  assert.doesNotMatch(combined, /(?:bg|text|border)-accent/)
  assert.doesNotMatch(combined, /(?:rose|emerald|amber)-/)
})
