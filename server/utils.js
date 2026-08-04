/**
 * 服务端通用工具函数
 * 统一 readJson / sendJson / authToken，避免每个路由文件重复定义。
 */

/**
 * 从请求体读取 JSON，带大小限制。
 * @param {import('node:http').IncomingMessage} req
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=4*1024*1024] 默认 4MB
 * @returns {Promise<object>}
 */
export async function readJsonWithRaw(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`)
      err.statusCode = 413
      throw err
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { body: raw.trim() ? JSON.parse(raw) : {}, raw }
}

export async function readJson(req, options) {
  const parsed = await readJsonWithRaw(req, options)
  return parsed.body
}

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 从 Authorization 头提取 Bearer token。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} token 或空字符串
 */
export function authToken(req) {
  const header = req.headers?.authorization || ''
  if (!header.startsWith('Bearer ')) return ''
  return header.slice(7).trim()
}
