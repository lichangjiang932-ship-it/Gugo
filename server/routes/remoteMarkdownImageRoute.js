import { readJson, sendJson } from '../utils.js'
import { fetchRemoteMarkdownImage } from '../services/remoteMarkdownImage.js'

/** Called only after mediaRoutes has authenticated the request. */
export async function handleRemoteMarkdownImageRequest(req, res, {
  env = process.env,
  fetchImage = fetchRemoteMarkdownImage,
} = {}) {
  const controller = new AbortController()
  const abort = () => { if (!res.writableEnded) controller.abort() }
  req.once('aborted', abort)
  res.once('close', abort)
  try {
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const image = await fetchImage(body?.url, { env, signal: controller.signal })
    res.writeHead(200, {
      'Content-Type': image.mimeType,
      'Content-Length': image.buffer.length,
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(image.buffer)
  } catch (error) {
    if (res.destroyed || res.writableEnded) return
    const status = error?.statusCode || (error instanceof SyntaxError ? 400
      : String(error?.code || '').startsWith('OUTBOUND_') ? 403 : 502)
    sendJson(res, status, { error: {
      code: error?.code || 'REMOTE_IMAGE_FAILED',
      message: error?.message || 'Unable to load remote image',
    } })
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}
