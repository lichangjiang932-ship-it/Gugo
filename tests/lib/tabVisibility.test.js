import test from 'node:test'
import assert from 'node:assert/strict'

import { visibleTabs } from '../../src/lib/tabVisibility.js'

test('archived=0 且 all===active → 只显示 [active]', () => {
  assert.deepEqual(
    visibleTabs({ active: 5, archived: 0, all: 5 }),
    ['active'],
  )
  // 用数组也得行
  assert.deepEqual(
    visibleTabs({ active: ['a', 'b'], archived: [], all: ['a', 'b'] }),
    ['active'],
  )
  // 全空也只显示 active（避免一上来三个 tab 全是 0）
  assert.deepEqual(
    visibleTabs({ active: 0, archived: 0, all: 0 }),
    ['active'],
  )
})

test('archived=0 且 all!==active → 显示 [active, all]', () => {
  assert.deepEqual(
    visibleTabs({ active: 3, archived: 0, all: 7 }),
    ['active', 'all'],
  )
  assert.deepEqual(
    visibleTabs({ active: ['a'], archived: [], all: ['a', 'b', 'c'] }),
    ['active', 'all'],
  )
})

test('archived>0 → 显示 [active, archived, all]', () => {
  assert.deepEqual(
    visibleTabs({ active: 2, archived: 1, all: 3 }),
    ['active', 'archived', 'all'],
  )
  assert.deepEqual(
    visibleTabs({ active: [], archived: ['x'], all: ['x'] }),
    ['active', 'archived', 'all'],
  )
})

test('健壮性：缺参/非法值视为 0', () => {
  assert.deepEqual(visibleTabs(), ['active'])
  assert.deepEqual(visibleTabs({}), ['active'])
  assert.deepEqual(
    visibleTabs({ active: null, archived: undefined, all: NaN }),
    ['active'],
  )
  // 负数被规范到 0
  assert.deepEqual(
    visibleTabs({ active: -3, archived: -1, all: -5 }),
    ['active'],
  )
})
