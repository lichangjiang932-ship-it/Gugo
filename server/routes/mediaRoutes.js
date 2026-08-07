import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { generateImage, transcribeAudio } from '../services/mediaModelService.js'

async function readBinary(req, maxBytes = 25 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function handleMediaRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'POST' && url.pathname === '/api/media/transcribe') {
      const result = await transcribeAudio({
        userId,
        providerKey: url.searchParams.get('provider') || undefined,
        model: url.searchParams.get('model') || 'whisper-1',
        language: url.searchParams.get('language') || undefined,
        mimeType: req.headers['content-type'] || 'audio/webm',
        audio: await readBinary(req),
      })
      return sendJson(res, 200, result)
    }
    if (req.method === 'POST' && url.pathname === '/api/media/image') {
      const body = await readJson(req)
      const result = await generateImage({ userId, ...body })
      return sendJson(res, 200, {
        image: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
        revisedPrompt: result.revisedPrompt,
        provider: result.provider,
      })
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
  } catch (error) {
    return sendJson(res, error?.statusCode || 502, { error: { code: 'MEDIA_REQUEST_FAILED', message: error?.message || String(error) } })
  }
}
