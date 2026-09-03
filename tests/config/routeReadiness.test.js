// T7 守门：route readiness map 形状 / 完整性 / 纯函数行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTE_READINESS,
  READINESS_LABEL,
  READINESS_LEVELS,
  getBannerKindForPath,
  getBadgeLabelForPath,
} from '../../src/config/routeReadiness.js'

test('ROUTE_READINESS 是 frozen 对象', () => {
  assert.ok(Object.isFrozen(ROUTE_READINESS))
  assert.ok(Object.isFrozen(READINESS_LABEL))
})

test('READINESS_LEVELS 包含且仅包含 stable/preview/wip', () => {
  assert.deepEqual([...READINESS_LEVELS].sort(), ['preview', 'stable', 'wip'])
})

test('ROUTE_READINESS 中每个 path 的等级必须是 stable / preview / wip 之一', () => {
  for (const [path, level] of Object.entries(ROUTE_READINESS)) {
    assert.ok(
      READINESS_LEVELS.includes(level),
      `路由 ${path} 等级 "${level}" 不在白名单中（必须是 stable/preview/wip 之一）`,
    )
    assert.ok(path.startsWith('/'), `路由 ${path} 必须以 '/' 开头`)
  }
})

test('READINESS_LABEL.stable 必须为 null（stable 不渲染角标）', () => {
  assert.equal(READINESS_LABEL.stable, null)
  assert.equal(READINESS_LABEL.preview, 'Preview')
  assert.equal(READINESS_LABEL.wip, 'WIP')
})

test('App.jsx 中声明的主要业务路由全部已登记 readiness', () => {
  // 这些是 src/App.jsx 中注册的真实业务路由（排除 /login 和通配符）
  const expected = [
    '/',
    '/chat',
    '/skills',
    '/permissions',
    '/task',
    '/history',
    '/settings',
    '/memory',
    '/desk',
    '/agents',
    '/channels',
    '/access',
    '/mcp',
    '/mobile-keys',
    '/reasonix',
  ]
  for (const p of expected) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ROUTE_READINESS, p),
      `路由 ${p} 必须在 ROUTE_READINESS 中登记`,
    )
  }
})

test('getBannerKindForPath：preview / wip 返回级别，stable / 未知 返回 null', () => {
  // preview
  assert.equal(getBannerKindForPath('/reasonix'), 'preview')
  // stable
  assert.equal(getBannerKindForPath('/chat'), null)
  assert.equal(getBannerKindForPath('/settings'), null)
  // 未注册路由
  assert.equal(getBannerKindForPath('/totally-unknown'), null)
  // 空 / 非字符串
  assert.equal(getBannerKindForPath(''), null)
  assert.equal(getBannerKindForPath(null), null)
  assert.equal(getBannerKindForPath(undefined), null)
  assert.equal(getBannerKindForPath(42), null)
})

test('getBadgeLabelForPath：返回与等级对应的文案 / null', () => {
  assert.equal(getBadgeLabelForPath('/chat'), null)        // stable
  assert.equal(getBadgeLabelForPath('/reasonix'), 'Preview')  // preview
  assert.equal(getBadgeLabelForPath('/nowhere'), null)     // 未注册
})

test('至少有一条 stable 路由（保证产品有可用入口）', () => {
  const stableCount = Object.values(ROUTE_READINESS).filter((l) => l === 'stable').length
  assert.ok(stableCount >= 5, `期望至少 5 条 stable 路由，实际 ${stableCount}`)
})
