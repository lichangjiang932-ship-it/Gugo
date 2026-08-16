import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * dev(vite.config.js)和 prod(server/appServer.js)必须路由同一组 /api 前缀。
 *
 * ★ 这个测试来自一次真实事故:
 *
 * `/api/tools/code/` 只注册在 appServer.js,没注册到 vite 的 fallbackApiPlugin。
 * 后果是 npm run dev 下模型每次调 grep_code / find_symbol / apply_patch
 * 都拿到 HTTP 404 —— **既搜不到代码,也改不了文件**。
 * 模型被逼到只能生成 PPT/文档来"交差",用户看到的是
 * 「执行 33 步、1 步失败、产出一个莫名其妙的 PPT」,
 * 根本想不到根因在构建配置里。这种 bug 靠人眼 review 是发现不了的。
 *
 * 同时漏的还有 /api/tools/agent/、/api/approvals、/api/tool-permissions、/api/desk。
 * 其中 /api/approvals 漏掉会让所有需要审批的工具(写文件/执行命令)直接失败。
 */

/**
 * dev 侧除了 fallbackApiPlugin,还有几个专用插件也在处理路由:
 *   - modelProxyPlugin  → /api/model/*
 *   - authAccountPlugin → /api/auth/*、/api/account/*
 * 这些前缀在 fallbackApiPlugin 里看不到字面量，但确实被处理了，不算漏。
 *
 * ⚠ 注意这里**故意不包含** '/api/tools'。toolProxyPlugin 只兜住
 * search/fetch 这类通用网络工具，不会处理 /api/tools/code、/api/tools/agent。
 * 早期版本把 '/api/tools' 整个加进白名单，结果这个测试对
 * 「/api/tools/code 漏注册」完全免疫 —— 正是它本该拦住的那个事故。
 */
const DEV_HANDLED_BY_PLUGIN = [
  '/api/model',
  '/api/auth',
  '/api/account',
  '/api/health',
  // toolProxy 处理的通用网络工具，逐个点名，不用通配
  '/api/tools/search',
  '/api/tools/fetch',
]

/**
 * 只按**精确字符串**放行的前缀，绝不吞并子路径。
 *
 * '/api/tools' 是 appServer.js 里给 toolProxy 兜底用的裸前缀，
 * dev 侧由 toolProxyPlugin 承担。但它绝不能覆盖 /api/tools/code、
 * /api/tools/agent 这些需要各自 handler 的具体路由 —— 那正是事故本身。
 */
const DEV_EXACT_PLUGIN_ROUTES = new Set([
  '/api/tools',
])

function apiPrefixes(relativePath) {
  const source = readFileSync(join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
  // 抓 '/api/xxx' 或 '/api/xxx/yyy' 形式的字符串字面量,去掉结尾的 /
  const found = source.match(/'\/api\/[a-z0-9/-]+/g) || []
  return new Set(found.map((item) => item.slice(1).replace(/\/$/, '')))
}

/**
 * dev 侧是否覆盖了这个前缀。
 *
 * ★ 规则刻意做得很严：**只认精确匹配**（或专用插件白名单）。
 *
 * 早期版本写过两种"聪明"的宽松匹配，两次都让这个测试对它本该拦住的
 * 事故完全免疫：
 *   1. 把 '/api/tools' 整个加进插件白名单 → /api/tools/code 漏注册也算过。
 *   2. "dev 注册了更长的路径就算覆盖" → dev 里任意一条 /api/tools/xxx
 *      都能替 /api/tools/code 顶包。
 * 宁可偶尔要求手动往白名单加一条，也不要一个永远绿的假测试。
 */
function devCovers(devPrefixes, prefix) {
  if (devPrefixes.has(prefix)) return true
  // 精确白名单：只有列出的这一条本身算覆盖，不吞并它的子路径
  if (DEV_EXACT_PLUGIN_ROUTES.has(prefix)) return true
  return DEV_HANDLED_BY_PLUGIN.some((p) => prefix === p || prefix.startsWith(`${p}/`))
}

test('★ vite dev server 必须覆盖 appServer 的每一个 /api 前缀', () => {
  const prod = apiPrefixes('server/appServer.js')
  const dev = apiPrefixes('vite.config.js')

  const missing = [...prod].filter((prefix) => !devCovers(dev, prefix)).sort()

  assert.deepEqual(
    missing,
    [],
    `以下前缀只在 appServer.js 注册了,dev 模式会 404:\n  ${missing.join('\n  ')}\n`
    + '把它们加到 vite.config.js 的 fallbackApiPlugin 里。',
  )
})

test('几个关键前缀必须在两边都存在(回归哨兵)', () => {
  const prod = apiPrefixes('server/appServer.js')
  const dev = apiPrefixes('vite.config.js')

  // 这些是事故当事人,单独点名守住
  for (const prefix of [
    '/api/tools/code',      // grep_code / find_symbol / list_imports / apply_patch
    '/api/tools/agent',     // reflect / request_clarification
    '/api/approvals',       // 工具审批闸口
    '/api/tool-permissions',
    '/api/tools/fs',
    '/api/tools/shell',
  ]) {
    assert.ok(prod.has(prefix), `appServer.js 应注册 ${prefix}`)
    assert.ok(dev.has(prefix), `vite.config.js 应注册 ${prefix}（否则 dev 模式 404）`)
  }
})

test('vite dev server mounts the production realtime turn WebSocket', () => {
  const source = readFileSync(join(ROOT, 'vite.config.js'), 'utf8')
  assert.match(source, /import\s*\{\s*attachTurnWebSocketServer\s*\}\s*from\s*['"]\.\/server\/services\/turnWebSocket\.js['"]/)
  assert.match(source, /function turnRealtimePlugin\(\)[\s\S]*?configureServer\(server\)[\s\S]*?attachTurnWebSocketServer\(server\.httpServer\)/)
  assert.match(source, /plugins:\s*\[[^\]]*turnRealtimePlugin\(\)/)
})

test('vite.config.js 真的 import 了这些 handler(不能只写 if 不导入)', () => {
  const source = readFileSync(join(ROOT, 'vite.config.js'), 'utf8')
  for (const name of [
    'handleCodeSearchRequest',
    'handleAgenticToolRequest',
    'handleApprovalRequest',
    'handleToolPermissionsRequest',
    'handleDeskRequest',
  ]) {
    assert.match(source, new RegExp(`import\\s*\\{[^}]*\\b${name}\\b`), `缺少 ${name} 的 import`)
  }
})

test('vite dev watcher ignores electron-builder release directories', () => {
  const source = readFileSync(join(ROOT, 'vite.config.js'), 'utf8')
  const ignoredBlock = source.match(/watch:\s*\{\s*ignored:\s*\[([\s\S]*?)\]/)?.[1]

  assert.ok(ignoredBlock, 'vite.config.js 应配置 server.watch.ignored')
  const ignoredPatterns = [...ignoredBlock.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])

  assert.ok(
    ignoredPatterns.includes('**/release/**'),
    'Vite 应忽略 release/**，避免占用 electron-builder 的 win-unpacked.tmp',
  )
  assert.ok(
    ignoredPatterns.includes('**/release-*/**'),
    'Vite 应忽略 release-*/** 版本化发布目录',
  )
})
