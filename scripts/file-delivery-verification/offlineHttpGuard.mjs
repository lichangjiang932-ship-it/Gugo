// Verification host only. Ordinary application hosts keep their existing HTTP
// authorization. Install before the backend registry; never inspect request bodies.
const LOCAL_READS = new Set([
  '/api/health', '/api/account/me', '/api/llm/providers', '/api/llm/catalog',
  '/api/model/status', '/api/model/providers', '/api/system/runtime-config',
  '/api/system/network-policy', '/api/tool-permissions',
])

function deny(res) {
  res.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify({ ok: false, error: {
    code: 'FILE_DELIVERY_OFFLINE_HTTP_DENIED',
    message: 'Offline verification permits local UI reads and local authentication only.',
  } }))
}

function localCatalogRead(url) {
  if (url.pathname === '/api/model/catalog') {
    const seen = new Set()
    for (const [key, value] of url.searchParams) {
      if (seen.has(key) || !['providers', 'q'].includes(key)) return false
      if (key === 'providers' && !['1', 'true'].includes(value)) return false
      seen.add(key)
    }
    return true
  }
  return !url.search && /^\/api\/model\/catalog\/[a-zA-Z0-9._-]+$/u.test(url.pathname)
    && url.pathname !== '/api/model/catalog/refresh'
}

/** Fail closed for all API calls except the small local settings/auth read surface. */
export function offlineVerificationHttpGuard(req, res, next) {
  const target = req.url
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')
    || /[\u0000- \u007f\\#]/u.test(target)) return deny(res)
  const rawPath = target.split('?')[0]
  // No alternate encoded/normalized API spelling may reach a later router with
  // different decoding rules. Static assets in this host need no encoded paths.
  if (rawPath.includes('%') || rawPath.includes('//')) return deny(res)
  let url
  try { url = new URL(target, 'http://localhost') } catch { return deny(res) }
  if (url.pathname !== rawPath) return deny(res)
  const read = req.method === 'GET' || req.method === 'HEAD'
  if (!/^\/api(?:\/|$)/iu.test(rawPath)) return read ? next() : deny(res)
  if (req.method === 'POST' && rawPath === '/api/auth/bootstrap' && !url.search) return next()
  if (read && ((!url.search && LOCAL_READS.has(rawPath)) || localCatalogRead(url))) return next()
  return deny(res)
}

/** Verification has no realtime mutation surface; HMR is disabled by this host. */
export function offlineVerificationTransportPlugin() {
  return {
    name: 'file-delivery-offline-http-guard', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(offlineVerificationHttpGuard)
      const rejectUpgrade = (_req, socket) => {
        socket.on('error', () => {})
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      }
      server.httpServer?.on('upgrade', rejectUpgrade)
      server.httpServer?.once('close', () => server.httpServer.removeListener('upgrade', rejectUpgrade))
    },
  }
}
