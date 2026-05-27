import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  getArtifactPreviewRendererStatus,
  handleArtifactDownload,
  renderArtifactPreviewPng,
} from '../services/artifactGen.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

export async function handleArtifactRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'POST' && url.pathname === '/api/artifacts/render-preview') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)

    const status = await getArtifactPreviewRendererStatus()
    if (!status.available) {
      return sendJson(res, 503, {
        error: 'LibreOffice is not installed; render-preview is unavailable',
        libreOfficePath: '',
      })
    }

    try {
      const body = await readJson(req, { maxBytes: 64 * 1024 })
      const preview = await renderArtifactPreviewPng({
        artifactPath: body.artifactPath,
        page: body.page || 1,
        userId,
      })
      return sendJson(res, 200, preview)
    } catch (err) {
      return sendJson(res, err.statusCode || 500, {
        error: err.message || 'render-preview failed',
      })
    }
  }

  return handleArtifactDownload(req, res)
}
