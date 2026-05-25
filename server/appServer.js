import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, getDbStatus } from './db.js'
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
  getModelStatus,
} from './adapters/modelProxy.js'
import { handleAuthBillingRequest } from './adapters/billingAuth.js'
import { handleToolProxyRequest } from './adapters/toolProxy.js'
import { handleFsShellRequest } from './adapters/fsShellTools.js'
import { handleGitWorkbenchRequest } from './adapters/gitWorkbench.js'
import { handleCodeSearchRequest } from './utils/codeSearchRoutes.js'
import { handleAgenticToolRequest } from './utils/agenticToolsRoutes.js'
import { handleArtifactDownload } from './services/artifactGen.js'
import { closeJobRuntime, getJobRuntime } from './services/jobRuntime.js'
import { handleJobRequest } from './routes/jobRoutes.js'
import { handleSkillRequest } from './routes/skillRoutes.js'
import { handleToolSpecsRequest } from './services/toolRegistry.js'
import { handleMemoryRequest } from './routes/memoryRoutes.js'
import { handleHooksRequest } from './routes/hooksRoutes.js'
import { handleMcpRequest } from './routes/mcpRoutes.js'
import { handleSubagentRequest } from './routes/subagentRoutes.js'
import { handleCompactionRequest } from './routes/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from './routes/knowledgeGraphRoutes.js'
import { shutdownAll as shutdownMcpAll } from './mcp/mcpManager.js'
import { handleReasonixRequest } from './routes/reasonixRoutes.js'
import { seedSystemSkills } from './services/seedSystemSkills.js'

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

// 启动时一次性算出 version,后续 health 直接复用,避免每次 health 都读 fs
let cachedVersion = null
function readVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const pkgPath = path.join(rootDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    cachedVersion = pkg.version || '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

export function healthCheck(req, res, getEnv = getRuntimeEnv) {
  // G6: /api/health 必须返回结构化 JSON,带 db + model 子状态.
  // 任何子系统未就绪 → 503,但响应体仍是 JSON,方便运维和探针解析.
  const env = (() => { try { return getEnv() } catch { return process.env } })()
  const db = getDbStatus()
  const model = getModelStatus(env)
  const overallOk = db.ok && model.configured
  const status = overallOk ? 200 : 503
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    ok: overallOk,
    version: readVersion(),
    uptimeSec: Math.round(process.uptime()),
    time: Date.now(),
    db,
    model: {
      configured: !!model.configured,
      missing: Array.isArray(model.missing) ? model.missing : [],
      modelName: model.modelName || null,
      toolMaxRounds: model.toolMaxRounds,
    },
  }))
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

function createRouter(getEnv = getRuntimeEnv) {
  const jobRuntime = getJobRuntime()
  return function router(req, res) {
  // 健康检查
  if (req.url === '/api/health') {
    healthCheck(req, res, getEnv)
    return
  }

  // 认证与计费
  if (
    req.url?.startsWith('/api/auth/') ||
    req.url?.startsWith('/api/account/') ||
    req.url?.startsWith('/api/billing/')
  ) {
    return handleAuthBillingRequest(req, res, getEnv())
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
  // 工具 spec 列表(底座 A) — 在更具体的 /api/tools/* 路由之前匹配,GET 公共端点
  if (req.url?.startsWith('/api/tools/specs')) {
    return handleToolSpecsRequest(req, res)
  }

  // Workspace fs/shell tools use the stricter fsShell handler before generic web tools.
  if (req.url?.startsWith('/api/tools/fs/') || req.url?.startsWith('/api/tools/shell/')) {
    return handleFsShellRequest(req, res)
  }

  // ★ M1: 代码搜索(只读, 比 fs/shell 风险低)
  if (req.url?.startsWith('/api/tools/code/')) {
    return handleCodeSearchRequest(req, res)
  }

  // ★ M3: 思维型工具(reflect / request_clarification)
  if (req.url?.startsWith('/api/tools/agent/')) {
    return handleAgenticToolRequest(req, res)
  }

  // Git workbench/check routes are stricter than generic web tools and must be handled first.
  if (req.url?.startsWith('/api/tools/git/') || req.url?.startsWith('/api/tools/check/') || req.url?.startsWith('/api/workbench/')) {
    return handleGitWorkbenchRequest(req, res)
  }

  if (req.url?.startsWith('/api/tools/')) {
    return handleToolProxyRequest(req, res)
  }

  // 产物下载
  if (req.url?.startsWith('/api/artifacts/')) {
    return handleArtifactDownload(req, res)
  }

  // 后台任务中心
  if (req.url?.startsWith('/api/jobs')) {
    return handleJobRequest(req, res, jobRuntime)
  }

  // 知识图谱（feature 8 — 借鉴 Reasonix memory_* 设计）
  if (req.url?.startsWith('/api/knowledge/')) {
    return handleKnowledgeGraphRequest(req, res)
  }

  // 技能包
  if (req.url?.startsWith('/api/skills')) {
    return handleSkillRequest(req, res)
  }

  // 记忆中心（feature 3）
  if (req.url?.startsWith('/api/memory/')) {
    return handleMemoryRequest(req, res)
  }

  // Hooks（feature 7）
  if (req.url?.startsWith('/api/hooks')) {
    return handleHooksRequest(req, res)
  }

  // MCP (feature 1) — /api/mcp/* + /api/tools/mcp/call
  if (req.url?.startsWith('/api/mcp/') || req.url?.startsWith('/api/tools/mcp/')) {
    return handleMcpRequest(req, res)
  }

  // Subagents (feature 2)
  if (req.url?.startsWith('/api/subagent/')) {
    return handleSubagentRequest(req, res)
  }

  // Context compaction (feature 6)
  if (req.url?.startsWith('/api/compaction/')) {
    return handleCompactionRequest(req, res)
  }

  // Reasonix-inspired: 钉记忆 / TODO / effort / session meter
  if (req.url?.startsWith('/api/reasonix/')) {
    return handleReasonixRequest(req, res)
  }

  // 静态文件
  serveStatic(req, res)
  }
}

export function createAppServer({ getEnv = getRuntimeEnv } = {}) {
  return http.createServer(applyMiddlewares(createRouter(getEnv)))
}

function gracefulShutdown(server) {
  if (process.env.NODE_ENV !== 'production') console.log('\n[server] 收到关闭信号，正在优雅退出...')
  server.close(() => {
    if (process.env.NODE_ENV !== 'production') console.log('[server] HTTP server 已关闭')
    closeJobRuntime()
    try { shutdownMcpAll() } catch { /* ignore */ }
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

  // ★ 启动时播种系统级技能 (seed/skills/<id>/ → SQLite)
  // 失败时只记 log 不阻塞启动
  try {
    seedSystemSkills()
  } catch (err) {
    console.error('[server] seedSystemSkills failed:', err.message)
  }

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
