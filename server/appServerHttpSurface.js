import fs from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDbStatus } from './db.js'
import { logger } from './utils/logger.js'
import { runtimeNotReadyMessage } from './core/runtimeReadiness.js'
import {
  getRuntimeEnv,
  getModelStatus,
  MODEL_CONFIG_MISSING_CODE,
} from './adapters/modelProxy.js'
import { resolveAuthMode } from './adapters/authAccount.js'
import { buildUserModelEnv } from './services/modelProviderStore.js'
import {
  describeModelReadinessFailure,
  resolveAgentModelRuntimeBinding,
} from './services/modelReadinessService.js'
import { RUNTIME_CAPABILITIES, RUNTIME_KERNEL_REVISION } from '../shared/runtimeCapabilities.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(currentDir, '..')

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

export function serveStatic(req, res, staticDir) {
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

export function healthCheckFull(
  req,
  res,
  getEnv = getRuntimeEnv,
  buildModelEnv = buildUserModelEnv,
  resolveModelBinding = resolveAgentModelRuntimeBinding,
  projectReadinessFailure = describeModelReadinessFailure,
) {
  // 鉴权版保留完整子系统细节,供运维排障使用.
  // 任何子系统未就绪 → 503,但响应体仍是 JSON,方便运维和探针解析.
  const env = (() => { try { return getEnv() } catch { return process.env } })()
  const db = getDbStatus()
  // /api/health/full is authenticated and therefore must diagnose the same
  // user-scoped Provider environment used by real model requests. Looking at
  // process env alone makes `gugo doctor` report an unusable model even when
  // the authenticated user has a ready BYOK Provider stored in SQLite.
  const userId = String(req?.userId || '').trim()
  const modelEnv = userId ? buildModelEnv({ userId, env }) : env
  const modelStatus = getModelStatus(modelEnv)
  let modelBinding = null
  let readinessFailure = null
  try {
    modelBinding = resolveModelBinding({ userId, env })
  } catch (error) {
    readinessFailure = projectReadinessFailure(error)?.error || null
  }

  const configured = !!modelStatus.configured
  const agentReady = !!modelBinding
  const readinessCode = agentReady
    ? null
    : configured
      ? readinessFailure?.code || 'MODEL_READINESS_FAILED'
      : MODEL_CONFIG_MISSING_CODE
  const action = agentReady
    ? null
    : configured
      ? readinessFailure?.action || 'configure_model'
      : 'configure_model'
  const overallOk = db.ok && agentReady
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
      configured,
      agentReady,
      readinessCode,
      code: readinessCode,
      action,
      modelName: modelBinding?.modelName
        || readinessFailure?.modelName
        || modelStatus.modelName
        || null,
      toolMaxRounds: modelStatus.toolMaxRounds,
    },
  }))
}

export function healthCheck(req, res, options = {}) {
  // During startup/failure this endpoint is process liveness only. Probing
  // SQLite would lazily create the database and run migrations before the
  // startup barrier has selected and recovered the runtime's persistence.
  const probeDatabase = options?.probeDatabase !== false
  const db = probeDatabase ? getDbStatus() : { ok: true }
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

export function sendRuntimeNotReady(res, runtimeReadiness) {
  const state = runtimeReadiness.getState()
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '1',
  })
  res.end(JSON.stringify({
    ok: false,
    error: {
      code: 'RUNTIME_NOT_READY',
      message: runtimeNotReadyMessage(state),
    },
  }))
}

export function isApiRequest(req) {
  try {
    const pathname = new URL(String(req?.url || '/'), 'http://localhost').pathname
    return pathname === '/api' || pathname.startsWith('/api/')
  } catch {
    const pathname = String(req?.url || '').split(/[?#]/, 1)[0]
    return pathname === '/api' || pathname.startsWith('/api/')
  }
}

export function sendApiNotFound(res) {
  send(res, 404, JSON.stringify({
    error: {
      code: 'API_NOT_FOUND',
      message: 'API endpoint not found',
    },
  }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
}
