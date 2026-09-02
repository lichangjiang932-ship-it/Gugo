import { isIP } from 'node:net'

import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
import { sendJson } from '../utils.js'

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').trim().toLowerCase()
  if (isIP(address) === 4) return Number(address.split('.')[0]) === 127
  if (isIP(address) !== 6) return false
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    if (normalized === '::1') return true
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    return mapped ? (Number.parseInt(mapped[1], 16) >> 8) === 127 : false
  } catch {
    return false
  }
}

export function authorizeRuntimeControl(req, res, env) {
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
    return null
  }
  if (!isLoopbackRequest(req) || !isLocalOwnerUser(userId, env)) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'LOCAL_OWNER_ONLY',
        message: '插件源码预览和运行时控制仅限服务宿主机的本地所有者',
      },
    })
    return null
  }
  return userId
}
