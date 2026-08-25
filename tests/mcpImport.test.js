import assert from 'node:assert/strict'
import test from 'node:test'

import { parseMcpImportJson } from '../src/lib/mcpImport.js'

test('parses the Claude Desktop mcpServers wrapper', () => {
  const { servers, warnings } = parseMcpImportJson(JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
      postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    },
  }))
  assert.equal(warnings.length, 0)
  assert.equal(servers.length, 2)
  assert.deepEqual(servers[0], {
    name: 'github',
    transport: 'stdio',
    enabled: true,
    autoApprove: [],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'x' },
    cwd: '',
    url: '',
    headers: {},
  })
})

test('parses VS Code style wrappers and bare name maps', () => {
  for (const wrapper of [
    { servers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } },
    { mcp: { servers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } } },
    { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } },
  ]) {
    const { servers, warnings } = parseMcpImportJson(JSON.stringify(wrapper))
    assert.equal(warnings.length, 0)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].name, 'fetch')
    assert.equal(servers[0].command, 'uvx')
  }
})

test('remote servers are detected from url or type and keep headers', () => {
  const { servers } = parseMcpImportJson(JSON.stringify({
    mcpServers: {
      hosted: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t', retries: 3 } },
      legacy: { url: 'https://old.example.com/sse' },
      sseOnly: { type: 'sse', url: 'https://old.example.com/sse' },
    },
  }))
  assert.equal(servers[0].transport, 'http')
  assert.equal(servers[0].url, 'https://mcp.example.com/mcp')
  assert.deepEqual(servers[0].headers, { Authorization: 'Bearer t', retries: '3' })
  assert.equal(servers[1].transport, 'http')
  assert.equal(servers[2].transport, 'sse')
  for (const server of servers) {
    assert.equal(server.command, '')
    assert.deepEqual(server.env, {})
  }
})

test('accepts a single server object and arrays of servers', () => {
  const single = parseMcpImportJson(JSON.stringify({ name: 'memory', command: 'npx', args: '-y @modelcontextprotocol/server-memory' }))
  assert.equal(single.servers.length, 1)
  assert.equal(single.servers[0].name, 'memory')
  assert.deepEqual(single.servers[0].args, ['-y', '@modelcontextprotocol/server-memory'])

  const list = parseMcpImportJson(JSON.stringify([
    { name: 'a', command: 'node', args: ['x.js'] },
    { name: 'b', url: 'https://b.example.com/mcp' },
  ]))
  assert.equal(list.servers.length, 2)
  assert.equal(list.servers[1].transport, 'http')
})

test('throws descriptive errors for unusable input', () => {
  assert.throws(() => parseMcpImportJson('{not json'), /invalid JSON/)
  assert.throws(() => parseMcpImportJson('{"foo": "bar"}'), /no recognizable MCP server entries/)
  // empty mcpServers map yields an empty result, not a throw
  const empty = parseMcpImportJson('{"mcpServers": {}}')
  assert.deepEqual(empty.servers, [])
})
