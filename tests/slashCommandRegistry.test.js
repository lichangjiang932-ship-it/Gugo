import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSlashCommandRegistry,
  normalizeSlashCommandName,
  parseSlashCommandInput,
} from '../src/lib/slashCommandRegistry.js'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

function command(name, description = name) {
  return { name, description, handler: async () => '' }
}

test('register/list/getCommand normalizes and sorts core before plugin by name', () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registry.register(command('/search'), 'core')
  registry.register(command('archive'), 'core')
  registry.register(command('template-z'), 'plugin')
  registry.register(command('template-a'), 'plugin')

  assert.equal(registry.getCommand('/SEARCH').name, 'search')
  assert.deepEqual(
    registry.listCommands().map((item) => item.name),
    ['archive', 'search', 'template-a', 'template-z'],
  )
})

test('recent usage floats commands to the top and keeps the newest first', () => {
  let now = 1_000
  const registry = createSlashCommandRegistry({ storage: memoryStorage(), now: () => now })
  registry.register(command('archive'), 'core')
  registry.register(command('clear'), 'core')
  registry.register(command('template'), 'plugin')

  registry.recordRecent('template')
  now += 1
  registry.recordRecent('clear')

  assert.deepEqual(
    registry.listCommands().map((item) => item.name),
    ['clear', 'template', 'archive'],
  )
})

test('recent usage drops expired items after 24h ttl', () => {
  const now = 24 * 60 * 60 * 1000 + 10
  const storage = memoryStorage({
    'yma:slash:recent': JSON.stringify([
      { name: 'template', usedAt: 1 },
      { name: 'clear', usedAt: now - 100 },
    ]),
  })
  const registry = createSlashCommandRegistry({ storage, now: () => now })
  registry.register(command('clear'), 'core')
  registry.register(command('template'), 'plugin')

  assert.deepEqual(registry.readRecent().map((item) => item.name), ['clear'])
  assert.deepEqual(registry.listCommands().map((item) => item.name), ['clear', 'template'])
})

test('recent usage keeps at most five commands', () => {
  const registry = createSlashCommandRegistry({ storage: memoryStorage(), now: () => Date.now() })
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) registry.register(command(name), 'core')
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) registry.recordRecent(name)
  assert.deepEqual(registry.readRecent().map((item) => item.name), ['f', 'e', 'd', 'c', 'b'])
})

test('parseSlashCommandInput and normalize helpers handle slash command text', () => {
  assert.equal(normalizeSlashCommandName('/Hello World'), 'hello-world')
  assert.deepEqual(parseSlashCommandInput('/title New name'), {
    name: 'title',
    args: 'New name',
    raw: '/title New name',
  })
  assert.equal(parseSlashCommandInput('plain text'), null)
})

