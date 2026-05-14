import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getRuntimeEnv,
  handleModelProxyRequest,
  handleModelStatusRequest,
  handleSystemDiagnosticsRequest,
} from './modelProxy.js'
import { handleAuthBillingRequest } from './billingAuth.js'

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

export function createAppServer() {
  return http.createServer((req, res) => {
    if (
      req.url?.startsWith('/api/auth/') ||
      req.url?.startsWith('/api/account/') ||
      req.url?.startsWith('/api/billing/')
    ) {
      handleAuthBillingRequest(req, res, getRuntimeEnv())
      return
    }
    if (req.url?.startsWith('/api/model/status')) {
      handleModelStatusRequest(req, res)
      return
    }
    if (req.url?.startsWith('/api/system/diagnostics')) {
      handleSystemDiagnosticsRequest(req, res)
      return
    }
    if (req.url?.startsWith('/api/model/test') || req.url?.startsWith('/api/model/chat')) {
      handleModelProxyRequest(req, res)
      return
    }
    serveStatic(req, res)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html 不存在，请先运行 npm run build。')
    process.exit(1)
  }

  const env = getRuntimeEnv()
  const host = env.SERVER_HOST || '127.0.0.1'
  const port = Number(env.SERVER_PORT || 5173)
  createAppServer().listen(port, host, () => {
    console.log(`Your Model Atelier running at http://${host}:${port}/`)
  })
}
