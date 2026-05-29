// T7 守门：PreviewBanner 的纯函数 helper 行为
//
// 真正的渲染分支（pickClasses）依赖 React，不在这里测；
// 重点保证 getBannerKindForPath 的契约与 ROUTE_READINESS 的对应。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTE_READINESS,
  getBannerKindForPath,
} from '../../src/config/routeReadiness.js'

test('stable 路由全部返回 null（不渲染 banner）', () => {
  for (const [path, level] of Object.entries(ROUTE_READINESS)) {
    if (level !== 'stable') continue
    assert.equal(
      getBannerKindForPath(path),
      null,
      `stable 路由 ${path} 不应该返回 banner kind`,
    )
  }
})

test('preview 路由全部返回 "preview"', () => {
  for (const [path, level] of Object.entries(ROUTE_READINESS)) {
    if (level !== 'preview') continue
    assert.equal(getBannerKindForPath(path), 'preview', `${path} → preview`)
  }
})

test('wip 路由全部返回 "wip"', () => {
  for (const [path, level] of Object.entries(ROUTE_READINESS)) {
    if (level !== 'wip') continue
    assert.equal(getBannerKindForPath(path), 'wip', `${path} → wip`)
  }
})

test('hash / query 不会被剥离 —— 调用方必须传 pathname', () => {
  // 当前实现就是按字面 lookup；保证不会"友好"地剥参数（避免 false negative）
  assert.equal(getBannerKindForPath('/hooks?foo=1'), null)
  assert.equal(getBannerKindForPath('/hooks#x'), null)
})
