import test from 'node:test'
import assert from 'node:assert/strict'
import { formatUnreadBadge, toastTypeForNotification } from '../../src/lib/notificationBellUtils.js'

test('formatUnreadBadge: 0 / 负数 / 非数字返回空串', () => {
  assert.equal(formatUnreadBadge(0), '')
  assert.equal(formatUnreadBadge(-3), '')
  assert.equal(formatUnreadBadge(null), '')
  assert.equal(formatUnreadBadge(undefined), '')
  assert.equal(formatUnreadBadge('abc'), '')
  assert.equal(formatUnreadBadge(NaN), '')
})

test('formatUnreadBadge: 1..99 显示具体数字', () => {
  assert.equal(formatUnreadBadge(1), '1')
  assert.equal(formatUnreadBadge(7), '7')
  assert.equal(formatUnreadBadge(42), '42')
  assert.equal(formatUnreadBadge(99), '99')
})

test('formatUnreadBadge: >99 显示 99+', () => {
  assert.equal(formatUnreadBadge(100), '99+')
  assert.equal(formatUnreadBadge(250), '99+')
  assert.equal(formatUnreadBadge(9999), '99+')
})

test('formatUnreadBadge: 字符串数字也接受', () => {
  assert.equal(formatUnreadBadge('5'), '5')
  assert.equal(formatUnreadBadge('150'), '99+')
})

test('formatUnreadBadge: 小数取 floor', () => {
  assert.equal(formatUnreadBadge(3.7), '3')
})

test('toastTypeForNotification: success / error / warn 三种 kind 直接透传', () => {
  assert.equal(toastTypeForNotification({ kind: 'success' }), 'success')
  assert.equal(toastTypeForNotification({ kind: 'error' }), 'error')
  assert.equal(toastTypeForNotification({ kind: 'warn' }), 'warn')
})

test('toastTypeForNotification: job kind 按 status 映射', () => {
  assert.equal(toastTypeForNotification({ kind: 'job', data: { status: 'completed' } }), 'success')
  assert.equal(toastTypeForNotification({ kind: 'job', data: { status: 'failed' } }), 'error')
  assert.equal(toastTypeForNotification({ kind: 'job', data: { status: 'cancelled' } }), 'warn')
  assert.equal(toastTypeForNotification({ kind: 'job', data: { status: 'running' } }), null)
  assert.equal(toastTypeForNotification({ kind: 'job' }), null)
})

test('toastTypeForNotification: 其他 kind / null / undefined 返回 null', () => {
  assert.equal(toastTypeForNotification({ kind: 'info' }), null)
  assert.equal(toastTypeForNotification({}), null)
  assert.equal(toastTypeForNotification(null), null)
  assert.equal(toastTypeForNotification(undefined), null)
})
