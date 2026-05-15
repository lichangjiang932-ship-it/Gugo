import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from './db.js'
import {
  corsMiddleware,
  securityHeaders,
  errorBoundary,
  requestLogger,
} from './middleware.js'

import {
  getRuntimeEnv,
  handleModelProxyRequest,
  handleModelStatusRequest,
  handleSystemDiagnosticsRequest,
} from './modelProxy.js'
import { handleAuthBillingRequest } from './billingAuth.js'
import { handleToolProxyRequest } from './toolProxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers)
  res.end(body)
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const decodedPath = decodeURIComponent(url.pathname)
  const requested = decodedPath === '/' ? '/index.html' : decodedPath
  const filePath = path.normalize(path.join(distDir, requested))

  if (!filePath.startsWith(distDir)) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' })
    return
  }

  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(distDir, 'index.html')
  const ext = path.extname(finalPath)
  send(res, 200, fs.readFileSync(finalPath), {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
  })
}

function healthCheck(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, time: Date.now() }))
}

function applyMiddlewares(handler) {
  return (req, res) => {
    // 顺序：CORS → 安全头 → 日志 → 错误边界 → 业务逻辑
    corsMiddleware(req, res, () => {
      securityHeaders(req, res, () => {
        requestLogger(req, res, () => {
          errorBoundary(req, res, () => handler(req, res))
        })
      })
    })
  }
}

function router(req, res) {
  // 健康检查
  if (req.url === '/api/health') {
    healthCheck(req, res)
    return
  }

  // 认证与计费
  if (
    req.url?.startsWith('/api/auth/') ||
    req.url?.startsWith('/api/account/') ||
    req.url?.startsWith('/api/billing/')
  ) {
    return handleAuthBillingRequest(req, res, getRuntimeEnv())
  }

  // 模型状态
  if (req.url?.startsWith('/api/model/status')) {
    return handleModelStatusRequest(req, res)
  }

  // 系统诊断
  if (req.url?.startsWith('/api/system/diagnostics')) {
    return handleSystemDiagnosticsRequest(req, res)
  }

  // 模型代理（chat / test）
  if (req.url?.startsWith('/api/model/test') || req.url?.startsWith('/api/model/chat')) {
    return handleModelProxyRequest(req, res)
  }

  // 工具代理(web 搜索 / URL 抓取)
  if (req.url?.startsWith('/api/tools/')) {
    return handleToolProxyRequest(req, res)
  }

  // 静态文件
  serveStatic(req, res)
}

export function createAppServer() {
  return http.createServer(applyMiddlewares(router))
}

function gracefulShutdown(server) {
  if (process.env.NODE_ENV !== 'production') console.log('\n[server] 收到关闭信号，正在优雅退出...')
  server.close(() => {
    if (process.env.NODE_ENV !== 'production') console.log('[server] HTTP server 已关闭')
    closeDb()
    if (process.env.NODE_ENV !== 'production') console.log('[server] 数据库连接已关闭')
    process.exit(0)
  })

  // 10 秒后强制退出
  setTimeout(() => {
    console.error('[server] 强制退出')
    process.exit(1)
  }, 10000)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html 不存在，请先运行 npm run build。')
    process.exit(1)
  }

  const env = getRuntimeEnv()
  const host = env.SERVER_HOST || '127.0.0.1'
  const port = Number(env.SERVER_PORT || 5173)
  const server = createAppServer().listen(port, host, () => {
    if (process.env.NODE_ENV !== 'production') console.log(`Your Model Atelier running at http://${host}:${port}/`)
  })

  // ★ #34: 进程级兜底 — 一个未捕获的异常不应该让服务静默退出
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err?.stack || err)
    // 不立即 exit:让 SIGTERM/SIGINT 走优雅路径;运维侧应靠日志告警
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason?.stack || reason)
  })

  process.on('SIGTERM', () => gracefulShutdown(server))
  process.on('SIGINT', () => gracefulShutdown(server))
}
