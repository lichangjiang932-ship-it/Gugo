import test from 'node:test'
import assert from 'node:assert/strict'

import { createSlashCommandRegistry } from '../src/lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../src/lib/slashCoreCommands.js'
import { translateKey } from '../src/i18n/translations.js'

function createRegistry() {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  return registry
}

test('core slash commands contain only actions with independent chat value', () => {
  const registry = createRegistry()
  assert.deepEqual(CORE_SLASH_COMMANDS, [
    'clear', 'context', 'help', 'model', 'permissions', 'status',
  ])
  assert.deepEqual(
    registry.listCommands().filter((entry) => entry.source === 'core').map((entry) => entry.name).sort(),
    [...CORE_SLASH_COMMANDS].sort(),
  )
  for (const name of CORE_SLASH_COMMANDS) {
    const entry = registry.getCommand(name)
    assert.equal(typeof entry.handler, 'function')
    assert.ok(entry.description && !entry.description.startsWith('slash.'))
  }
})

test('/clear dispatches CLEAR_CURRENT_SESSION after confirmation', async () => {
  const registry = createRegistry()
  const actions = []
  const result = await registry.getCommand('clear').handler('', {
    confirm: () => true,
    dispatch: (action) => actions.push(action),
  })

  assert.equal(result, 'Current session cleared.')
  assert.deepEqual(actions, [{ type: 'CLEAR_CURRENT_SESSION' }])
})

test('/model opens the picker without an argument and switches an exact available model', async () => {
  const registry = createRegistry()
  let opened = 0
  let selected = null
  const ctx = {
    modelOptions: [{ name: 'alpha' }, { name: 'beta' }],
    openModelPicker: () => { opened += 1 },
    setModel: (name) => { selected = name },
  }

  assert.equal(await registry.getCommand('model').handler('', ctx), '')
  assert.equal(opened, 1)
  assert.equal(await registry.getCommand('model').handler('BETA', ctx), 'Switched model to: beta')
  assert.equal(selected, 'beta')
  assert.equal(await registry.getCommand('model').handler('missing', ctx), 'Model not found: missing')
})

test('/context controls the complete context usage bar', async () => {
  const registry = createRegistry()
  const values = []
  const command = registry.getCommand('context')

  assert.equal(await command.handler('show', {
    contextUsageVisible: false,
    setContextUsage: (visible) => values.push(visible),
  }), 'Context usage bar shown.')
  assert.equal(await command.handler('hide', {
    contextUsageVisible: true,
    setContextUsage: (visible) => values.push(visible),
  }), 'Context usage bar hidden.')
  assert.equal(await command.handler('', {
    contextUsageVisible: false,
    setContextUsage: (visible) => values.push(visible),
  }), 'Context usage bar shown.')
  assert.equal(await command.handler('invalid', {}), 'Usage: /context show|hide|toggle')
  assert.deepEqual(values, [true, false, true])
})

test('/permissions navigates and /status reports current session state', async () => {
  const registry = createRegistry()
  let route = null
  const permissionsResult = await registry.getCommand('permissions').handler('', {
    navigate: (path) => { route = path },
  })
  const statusResult = await registry.getCommand('status').handler('', {
    selectedModel: 'beta',
    getState: () => ({
      activeSessionId: 's1',
      sessions: [{ id: 's1', messages: [{ role: 'user' }, { role: 'assistant' }] }],
      tasks: [{ status: 'running' }, { status: 'done' }],
    }),
  })

  assert.equal(route, '/permissions')
  assert.equal(permissionsResult, 'Opened permissions.')
  assert.equal(statusResult, 'Model: beta · Messages: 2 · Running tasks: 1')
})
