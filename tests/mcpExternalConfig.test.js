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

test('external MCP connection panel has complete five-language copy', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    for (const key of ['title', 'createKey', 'keyLabel', 'keyPrivacy', 'invalidKey', 'copy', 'copyError']) {
      assert.ok(lookup(translations[lang], `mcpExternal.${key}`), `${lang} is missing ${key}`)
    }
    for (const key of ['title', 'subtitle', 'addServer', 'confirmDelete', 'testConnection', 'transportHint']) {
      assert.ok(lookup(translations[lang], `mcp.${key}`), `${lang} is missing MCP ${key}`)
    }
  }
})

test('MCP server cards keep selection and actions as sibling buttons', () => {
  const source = fs.readFileSync(new URL('../src/pages/McpServersView.jsx', import.meta.url), 'utf8')
  assert.match(source, /selectServer\(s\); test\(s\.id\)/)
  let depth = 0
  let maxDepth = 0
  for (const match of source.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1
    maxDepth = Math.max(maxDepth, depth)
  }
  assert.equal(maxDepth, 1)
  assert.doesNotMatch(source, /href="\/mobile-keys"/)
})
