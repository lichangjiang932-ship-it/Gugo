import fs from 'node:fs'
import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getDbStatus } from './db.js'
import { logger, newTraceId, withLogContext } from './utils/logger.js'
import {
  corsMiddleware,
  securityHeaders,
  errorBoundary,
  requestLogger,
  requireAuth,
  createApiRateLimitMiddleware,
} from './middleware.js'
import { bootstrap, gracefulShutdown } from './core/lifecycle.js'

import {
  getRuntimeEnv,
  handleModelProxyRequest,
  handleModelStatusRequest,
  handleSystemDiagnosticsRequest,
  getModelStatus,
} from './adapters/modelProxy.js'
import { handleAuthAccountRequest, resolveAuthMode } from './adapters/authAccount.js'
import { handleToolProxyRequest } from './adapters/toolProxy.js'
import { handleFsShellRequest } from './adapters/fsShellTools.js'
import { handleGitWorkbenchRequest } from './adapters/gitWorkbench.js'
import { handleCodeSearchRequest } from './utils/codeSearchRoutes.js'
import { handleAgenticToolRequest } from './utils/agenticToolsRoutes.js'
import { handleArtifactRequest } from './routes/artifacts.js'
import { getJobRuntime } from './services/jobRuntime.js'
import { getCronScheduler } from './services/cronScheduler.js'
import { handleJobRequest } from './routes/jobRoutes.js'
import { handleCronRequest } from './routes/cronRoutes.js'
import { handleSkillRequest } from './routes/skillRoutes.js'
import { handlePluginRequest } from './routes/pluginRoutes.js'
import { handleAgentRequest } from './routes/agentRoutes.js'
import { handleAgentTemplateRequest } from './routes/agentTemplateRoutes.js'
import { handleToolSpecsRequest } from './services/toolRegistry.js'
import { handleMemoryRequest } from './routes/memoryRoutes.js'
import { handleHooksRequest } from './routes/hooksRoutes.js'
import { handleMcpRequest } from './routes/mcpRoutes.js'
import { handleSubagentRequest } from './routes/subagentRoutes.js'
import { handleCompactionRequest } from './routes/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from './routes/knowledgeGraphRoutes.js'
import { handleReasonixRequest } from './routes/reasonixRoutes.js'
import { handleNotificationRequest } from './routes/notificationRoutes.js'
import { handleApprovalRequest } from './routes/approvalRoutes.js'
import { handleSessionRequest } from './routes/sessionRoutes.js'
import { handleChannelRequest } from './routes/channelRoutes.js'
import { handleIntegrationsRequest } from './routes/integrationsRoutes.js'
import { handleBridgeRequest } from './routes/bridgeRoutes.js'
import { handleDeskRequest } from './routes/deskRoutes.js'
import { handleMobileRequest } from './routes/mobileRoutes.js'
import { handleToolPermissionsRequest } from './routes/toolPermissionRoutes.js'
import { handleModelProviderRequest } from './routes/modelProviderRoutes.js'
import { handleBrowserRequest } from './routes/browserRoutes.js'
import { handleConnectorRequest } from './routes/connectorRoutes.js'
import { handleLocalFileAccessRequest } from './routes/localFileAccessRoutes.js'
import { isLocalHtmlPreviewTicketActive } from './services/localHtmlPreviewService.js'
import { handleFileSnapshotRequest } from './routes/fileSnapshotRoutes.js'
import { handleTurnEventRequest } from './routes/turnEventRoutes.js'
import { handleAuditRequest } from './routes/auditRoutes.js'
import { handleEvolutionRequest } from './routes/evolutionRoutes.js'
import { handleMediaRequest } from './routes/mediaRoutes.js'
import { handleAttachmentRequest } from './routes/attachmentRoutes.js'
import { handleWebSearchRequest } from './routes/webSearchRoutes.js'
import { handleRuntimeConfigRequest } from './routes/runtimeConfigRoutes.js'
import { handleMcpServerRequest } from './mcp/mcpServer.js'
import { attachTurnWebSocketServer } from './services/turnWebSocket.js'
import { RUNTIME_CAPABILITIES, RUNTIME_KERNEL_REVISION } from '../shared/runtimeCapabilities.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
export { RUNTIME_KERNEL_REVISION }

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

function serveStatic(req, res, staticDir = distDir) {
  const url = new URL(req.url, 'http://localhost')
  const decodedPath = decodeURIComponent(url.pathname)
  const requested = decodedPath === '/' ? '/index.html' : decodedPath
  const filePath = path.normalize(path.join(staticDir, requested))

  if (!filePath.startsWith(staticDir)) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' })
    return
  }

  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(staticDir, 'index.html')
  const ext = path.extname(finalPath)
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
  }

  if (ext === '.html') {
    const nonce = res.locals?.cspNonce
    const html = fs.readFileSync(finalPath, 'utf8')
      .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    send(res, 200, html, {
      ...headers,
      'Cache-Control': 'no-store, must-revalidate',
    })
    return
  }

  send(res, 200, fs.readFileSync(finalPath), {
    ...headers,
    'Cache-Control': 'public, max-age=3600',
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

export function healthCheckFull(req, res, getEnv = getRuntimeEnv) {
  // 鉴权版保留完整子系统细节,供运维排障使用.
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
    kernelRevision: RUNTIME_KERNEL_REVISION,
    capabilities: RUNTIME_CAPABILITIES,
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

export function healthCheck(req, res) {
  const db = getDbStatus()
  // This is a liveness check. A fresh local install must stay healthy while
  // the user opens Settings and configures the first model provider.
  const overallOk = db.ok
  const status = overallOk ? 200 : 503
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    ok: overallOk,
    time: Date.now(),
    version: readVersion(),
    kernelRevision: RUNTIME_KERNEL_REVISION,
    capabilities: RUNTIME_CAPABILITIES,
  }))
}

export function isLoopbackBindAddress(value) {
  let address = String(value || '').trim().toLowerCase()
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  if (address === 'localhost' || address === 'localhost.') return true
  if (isIP(address) === 4) return Number(address.split('.')[0]) === 127
  if (isIP(address) !== 6) return false
  try {
    return new URL(`http://[${address}]/`).hostname === '[::1]'
  } catch {
    return false
  }
}

export function resolveEffectiveExposureAddress(env = process.env, listenerHost) {
  // The application must listen on 0.0.0.0 inside a container, while Docker's
  // published host address is the real network boundary. The marker is set by
  // docker-compose.yml so a stray DOCKER_BIND_ADDRESS cannot weaken direct runs.
  if (String(env.GUGO_DOCKER || '').trim() === '1') {
    return String(env.DOCKER_BIND_ADDRESS || '127.0.0.1').trim()
  }
  return String(listenerHost || env.SERVER_HOST || '127.0.0.1').trim()
}

export function getLocalAuthExposurePolicy(env = process.env, { listenerHost } = {}) {
  const authMode = resolveAuthMode(env)
  const bindAddress = resolveEffectiveExposureAddress(env, listenerHost)
  const exposed = authMode === 'local' && !isLoopbackBindAddress(bindAddress)
  const override = String(env.ALLOW_INSECURE_LOCAL_AUTH || '').trim() === '1'
  return {
    authMode,
    bindAddress,
    exposed,
    override,
    allowed: !exposed || override,
  }
}

export function enforceLocalAuthExposurePolicy(
  env = process.env,
  { listenerHost, surface = 'application server', warn = (message) => logger.warn(message) } = {},
) {
  const policy = getLocalAuthExposurePolicy(env, { listenerHost })
  if (!policy.exposed) return policy

  if (policy.override) {
    warn(`[SECURITY][auth] HIGH RISK: ${surface} is running AUTH_MODE=local on non-loopback address ${policy.bindAddress}. Every network client can obtain the local owner session because ALLOW_INSECURE_LOCAL_AUTH=1 is set.`)
    return policy
  }

  const error = new Error(
    `[auth] Refusing to start ${surface}: AUTH_MODE=local cannot bind to non-loopback address ${policy.bindAddress}. `
    + 'Use AUTH_MODE=multi_user for LAN/public access. Set ALLOW_INSECURE_LOCAL_AUTH=1 only if you explicitly accept unauthenticated remote access.',
  )
  error.code = 'INSECURE_LOCAL_AUTH_BIND'
  throw error
}

function applyMiddlewares(handler, apiRateLimitMiddleware) {
  return (req, res) => {
    // 请求级关联 ID：客户端可透传 x-request-id，否则生成一个，
    // 让这一整条请求链上的结构化日志都能按 requestId 串起来。
    const requestId = String(req.headers['x-request-id'] || '').trim().slice(0, 128) || newTraceId()
    req.requestId = requestId
    res.setHeader('X-Request-Id', requestId)
    // 顺序：CORS → 安全头 → 日志 → 错误边界 → 业务逻辑
    corsMiddleware(req, res, () => {
      securityHeaders(req, res, () => {
        requestLogger(req, res, () => {
          apiRateLimitMiddleware(req, res, () => {
            errorBoundary(req, res, () => withLogContext({ requestId }, () => handler(req, res)))
          })
        })
      })
    })
  }
}

function createRouter(getEnv = getRuntimeEnv, staticDir = distDir) {
  const jobRuntime = getJobRuntime()
  const cronScheduler = getCronScheduler()
  cronScheduler.start()
  return function router(req, res) {
  if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
    return handleMcpServerRequest(req, res)
  }

  // 健康检查
  if (req.url === '/api/health') {
    healthCheck(req, res, getEnv)
    return
  }

  if (req.url === '/api/health/full') {
    requireAuth(req, res, () => healthCheckFull(req, res, getEnv))
    return
  }

  // 认证与账户
  if (
    req.url?.startsWith('/api/auth/') ||
    req.url?.startsWith('/api/account/')
  ) {
    return handleAuthAccountRequest(req, res, getEnv())
  }

  // 模型状态
  if (req.url?.startsWith('/api/model/providers')) {
    return handleModelProviderRequest(req, res)
  }

  if (req.url?.startsWith('/api/model/status')) {
    return handleModelStatusRequest(req, res)
  }

  // 系统诊断
  if (req.url?.startsWith('/api/system/runtime-config')) {
    return handleRuntimeConfigRequest(req, res, { env: getEnv() })
  }

  if (req.url?.startsWith('/api/system/diagnostics')) {
    return handleSystemDiagnosticsRequest(req, res)
  }

  // 模型代理（chat / test）
  if (req.url?.startsWith('/api/model/test') || req.url?.startsWith('/api/model/chat')) {
    return handleModelProxyRequest(req, res)
  }

  // 工具代理(web 搜索 / URL 抓取)
  if (req.url?.startsWith('/api/browser/')) {
    return handleBrowserRequest(req, res)
  }

  if (req.url?.startsWith('/api/connectors/')) {
    return handleConnectorRequest(req, res, { env: getEnv() })
  }

  if (req.url?.startsWith('/api/local-files')) {
    return handleLocalFileAccessRequest(req, res)
  }

  if (req.url?.startsWith('/api/snapshots')) {
    return handleFileSnapshotRequest(req, res)
  }

  if (req.url?.startsWith('/api/media/')) {
    return handleMediaRequest(req, res)
  }

  if (req.url?.startsWith('/api/attachments')) {
    return handleAttachmentRequest(req, res)
  }

  if (req.url?.startsWith('/api/web-search')) {
    return handleWebSearchRequest(req, res)
  }

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
    return handleArtifactRequest(req, res)
  }

  // 后台任务中心
  if (req.url?.startsWith('/api/jobs')) {
    return handleJobRequest(req, res, jobRuntime)
  }

  if (req.url?.startsWith('/api/cron-jobs')) {
    return handleCronRequest(req, res)
  }

  if (req.url?.startsWith('/api/notifications')) {
    return handleNotificationRequest(req, res)
  }

  if (req.url?.startsWith('/api/approvals')) {
    return handleApprovalRequest(req, res)
  }

  if (req.url?.startsWith('/api/channels')) {
    return handleChannelRequest(req, res)
  }

  if (req.url?.startsWith('/api/bridge')) {
    return handleBridgeRequest(req, res)
  }

  if (req.url?.startsWith('/api/integrations')) {
    return handleIntegrationsRequest(req, res, { env: getEnv() })
  }

  // Desk Notes (Hanako 平行：书桌便笺)
  if (req.url?.startsWith('/api/desk/')) {
    return handleDeskRequest(req, res)
  }

  // Mobile / LAN access keys (Hanako 平行)
  if (req.url?.startsWith('/api/mobile/')) {
    return handleMobileRequest(req, res)
  }

  if (req.url?.startsWith('/api/sessions')) {
    return handleSessionRequest(req, res)
  }

  // 知识图谱（feature 8 — 借鉴 Reasonix memory_* 设计）
  if (req.url?.startsWith('/api/knowledge/')) {
    return handleKnowledgeGraphRequest(req, res)
  }

  // 技能包
  if (req.url?.startsWith('/api/skills')) {
    return handleSkillRequest(req, res)
  }

  // Plugin SDK (stage-2.2) — 静态只读
  if (req.url?.startsWith('/api/plugins')) {
    return handlePluginRequest(req, res, { env: getEnv() })
  }

  if (req.url?.startsWith('/api/agent-templates')) {
    return handleAgentTemplateRequest(req, res)
  }

  if (req.url?.startsWith('/api/agents')) {
    return handleAgentRequest(req, res)
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

  // Per-user 工具权限 gate(PermissionsDashboard 真 gate)
  if (req.url?.startsWith('/api/tool-permissions')) {
    return handleToolPermissionsRequest(req, res)
  }

  // Reasonix-inspired: 钉记忆 / TODO / effort / session meter
  if (req.url?.startsWith('/api/reasonix/')) {
    return handleReasonixRequest(req, res)
  }

  if (req.url?.startsWith('/api/turns')) {
    return handleTurnEventRequest(req, res, undefined, { env: getEnv() })
  }

  if (req.url?.startsWith('/api/audit')) {
    return handleAuditRequest(req, res)
  }

  if (req.url?.startsWith('/api/evolution/')) {
    return handleEvolutionRequest(req, res)
  }

  // 静态文件
  serveStatic(req, res, staticDir)
  }
}

export function createAppServer({ getEnv = getRuntimeEnv, staticDir = distDir } = {}) {
  const env = { ...process.env, ...(getEnv() || {}) }
  const apiRateLimitMiddleware = createApiRateLimitMiddleware({
    env,
    isActiveLocalHtmlPreviewTicket: isLocalHtmlPreviewTicketActive,
  })
  const server = http.createServer(applyMiddlewares(createRouter(getEnv, staticDir), apiRateLimitMiddleware))
  attachTurnWebSocketServer(server)
  server.once('close', () => apiRateLimitMiddleware.close())
  return server
}

// 旧 gracefulShutdown 已下沉到 server/core/lifecycle.js
// 这里仅做兼容代理：旧调用点 → 新统一入口
function gracefulShutdownProxy(server) {
  gracefulShutdown(server)
}

export function startAppServer() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html 不存在，请先运行 npm run build。')
    process.exitCode = 1
    return null
  }

  const env = getRuntimeEnv()
  const host = env.SERVER_HOST || '127.0.0.1'
  const port = Number(env.SERVER_PORT || 5173)

  enforceLocalAuthExposurePolicy(env, { listenerHost: host })

  // ★ 启动时由 lifecycle.bootstrap 统一编排 (包含 seedSystemSkills 等)
  bootstrap()

  const server = createAppServer().listen(port, host, () => {
    if (process.env.NODE_ENV !== 'production') logger.info(`Gugo running at http://${host}:${port}/`)
  })

  // ★ #34: 进程级兜底 — 一个未捕获的异常不应该让服务静默退出
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err?.stack || err)
    // 不立即 exit:让 SIGTERM/SIGINT 走优雅路径;运维侧应靠日志告警
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason?.stack || reason)
  })

  process.on('SIGTERM', () => gracefulShutdownProxy(server))
  process.on('SIGINT', () => gracefulShutdownProxy(server))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAppServer()
}
