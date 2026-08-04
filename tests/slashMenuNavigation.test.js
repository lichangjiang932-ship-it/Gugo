import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSlashMenuKey } from '../src/lib/slashMenuNavigation.js'

test('slash menu arrows wrap through available actions', () => {
  assert.deepEqual(resolveSlashMenuKey('ArrowDown', 0, 3), { handled: true, selectedIndex: 1 })
  assert.deepEqual(resolveSlashMenuKey('ArrowDown', 2, 3), { handled: true, selectedIndex: 0 })
  assert.deepEqual(resolveSlashMenuKey('ArrowUp', 0, 3), { handled: true, selectedIndex: 2 })
})

test('slash menu Enter and Tab select while Escape only dismisses', () => {
  assert.deepEqual(resolveSlashMenuKey('Enter', 1, 3), {
    handled: true,
    selectIndex: 1,
    dismiss: true,
  })
  assert.deepEqual(resolveSlashMenuKey('Tab', 0, 2), {
    handled: true,
    selectIndex: 0,
    dismiss: true,
  })
  assert.deepEqual(resolveSlashMenuKey('Escape', 0, 0), {
    handled: true,
    dismiss: true,
  })
  assert.deepEqual(resolveSlashMenuKey('a', 0, 3), { handled: false })
})
