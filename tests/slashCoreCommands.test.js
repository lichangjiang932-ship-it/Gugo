import test from 'node:test'
import assert from 'node:assert/strict'

import { createSlashCommandRegistry } from '../src/lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../src/lib/slashCoreCommands.js'
import { translateKey } from '../src/i18n/translations.js'

test('core slash commands register clear/retry/title/search/archive/help as core entries', () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })

  for (const name of CORE_SLASH_COMMANDS) {
    const entry = registry.getCommand(name)
    assert.ok(entry, `/${name} should be registered`)
    assert.equal(entry.source, 'core')
    assert.equal(typeof entry.handler, 'function')
    assert.ok(entry.description && !entry.description.startsWith('slash.'))
  }
})

test('/clear dispatches CLEAR_CURRENT_SESSION after confirmation', async () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  const actions = []

  const result = await registry.getCommand('clear').handler('', {
    confirm: () => true,
    dispatch: (action) => actions.push(action),
  })

  assert.equal(result, 'Current session cleared.')
  assert.deepEqual(actions, [{ type: 'CLEAR_CURRENT_SESSION' }])
})

test('/title dispatches UPDATE_SESSION_TITLE with the provided title', async () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  const actions = []

  const result = await registry.getCommand('title').handler('Project notes', {
    dispatch: (action) => actions.push(action),
  })

  assert.equal(result, 'Renamed session to: Project notes')
  assert.deepEqual(actions, [{ type: 'UPDATE_SESSION_TITLE', payload: 'Project notes' }])
})

test('/search opens search with the provided query', async () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  let opened = null

  const result = await registry.getCommand('search').handler('billing', {
    openSessionSearch: (query) => { opened = query },
  })

  assert.equal(opened, 'billing')
  assert.equal(result, 'Opened search for: billing')
})

test('/archive dispatches ARCHIVE_SESSION for active session', async () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  const actions = []

  const result = await registry.getCommand('archive').handler('', {
    getState: () => ({ activeSessionId: 's1' }),
    dispatch: (action) => actions.push(action),
    archiveSessionRemote: async () => ({ ok: true }),
  })

  assert.equal(result, 'Current session archived.')
  assert.deepEqual(actions, [{ type: 'ARCHIVE_SESSION', payload: 's1' }])
})

test('/retry truncates to previous user message and starts resend flow', async () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { t: (key) => translateKey(key, 'en') })
  const actions = []
  let resent = null

  const result = await registry.getCommand('retry').handler('', {
    getState: () => ({
      activeSessionId: 's1',
      sessions: [{
        id: 's1',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'again' },
        ],
      }],
    }),
    dispatch: (action) => actions.push(action),
    triggerSendFlow: (content) => { resent = content },
  })

  assert.equal(result, 'Retrying the previous user message.')
  assert.equal(resent, 'again')
  assert.deepEqual(actions, [{ type: 'TRUNCATE_MESSAGES', payload: 2 }])
})

