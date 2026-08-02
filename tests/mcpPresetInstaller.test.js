import assert from 'node:assert/strict'
import test from 'node:test'
import { installMcpPreset } from '../src/lib/mcpPresetInstaller.js'

test('MCP preset installer stages disabled, probes, enables, and connects', async () => {
  const calls = []
  const api = {
    upsert: async (payload) => {
      calls.push(['upsert', payload.enabled])
      return { server: { ...payload, id: payload.id || 'server-1' } }
    },
    test: async (id) => {
      calls.push(['test', id])
      return { capabilities: { tools: [{ name: 'inspect_page' }], resources: [], prompts: [] } }
    },
    connect: async (id) => {
      calls.push(['connect', id])
      return { connected: true, toolCount: 1 }
    },
  }

  const installed = await installMcpPreset({ presetId: 'chrome-devtools', api })
  assert.deepEqual(calls, [
    ['upsert', false],
    ['test', 'server-1'],
    ['upsert', true],
    ['connect', 'server-1'],
  ])
  assert.equal(installed.server.enabled, true)
  assert.equal(installed.runtime.connected, true)
  assert.equal(installed.runtime.tools[0].name, 'inspect_page')
})

test('MCP preset installer leaves a failed installation disabled', async () => {
  const enabledStates = []
  const api = {
    upsert: async (payload) => {
      enabledStates.push(payload.enabled)
      return { server: { ...payload, id: 'server-2' } }
    },
    test: async () => { throw new Error('probe failed') },
    connect: async () => { throw new Error('must not connect') },
  }

  await assert.rejects(
    installMcpPreset({ presetId: 'chrome-devtools', api }),
    (error) => error.message === 'probe failed' && error.disabledServer?.enabled === false,
  )
  assert.deepEqual(enabledStates, [false, false])
})
