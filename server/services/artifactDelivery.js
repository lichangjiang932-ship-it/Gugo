import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { applyHtmlArtifactDocumentPolicy, HTML_ARTIFACT_RESPONSE_CSP } from '../../shared/htmlArtifactPolicy.js'
import { authenticateRequest } from '../middleware.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { expandHtmlArtifactAssets, getHtmlArtifactAsset } from './htmlArtifactAssets.js'
import { getArtifactByFilename } from './jobStore.js'
import { ARTIFACT_DIR, ensureArtifactDir, isSafeArtifactFilename } from './artifactStorage.js'
import { getTurnArtifactByFilename } from './turnArtifactStore.js'

const execFileAsync = promisify(execFile)

const ARTIFACT_CONTENT_TYPES = Object.freeze({
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  ogv: 'video/ogg',
})

function artifactContentType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return ARTIFACT_CONTENT_TYPES[ext] || 'application/octet-stream'
}

function artifactContentDisposition(kind, filename) {
  const ext = path.extname(filename)
  const asciiStem = path.basename(filename, ext)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]+/g, '-')
    .replace(/["\\;]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'artifact'
  const ascii = `${asciiStem}${ext.replace(/[^.a-z0-9]/gi, '')}`
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function parseArtifactRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null && end != null) {
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    start = start ?? 0
    end = end == null ? size - 1 : Math.min(end, size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end }
}

function withStatus(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

async function findExecutable(names) {
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync('which', [name], {
        env: sanitizeChildEnv(),
        timeout: 3000,
      })
      const bin = stdout.trim().split(/\n+/)[0]
      if (bin) return bin
    } catch {
      // try next executable name
    }
  }
  return ''
}

function filenameFromArtifactPath(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://localhost')
    if (url.pathname.startsWith('/api/artifacts/')) {
      return decodeURIComponent(path.basename(url.pathname))
    }
  } catch {
    // fall through to filename/path handling
  }
  if (isSafeArtifactFilename(raw) && path.extname(raw).toLowerCase() === '.pptx') return raw
  return ''
}

function resolvePreviewArtifactPath(input, userId) {
  const raw = String(input || '').trim()
  if (!raw) throw withStatus(400, 'artifactPath is required')

  const filename = filenameFromArtifactPath(raw)
  let full = filename ? path.join(ensureArtifactDir(), filename) : raw
  if (!path.isAbsolute(full)) throw withStatus(400, 'artifactPath must be a pptx artifact path or filename')
  if (path.extname(full).toLowerCase() !== '.pptx') throw withStatus(400, 'render-preview only supports pptx artifacts')

  const artifactDirReal = fs.realpathSync(ensureArtifactDir())
  try {
    full = fs.realpathSync(full)
  } catch {
    throw withStatus(404, 'artifact not found')
  }
  if (full !== artifactDirReal && !full.startsWith(artifactDirReal + path.sep)) {
    throw withStatus(400, 'artifactPath must be inside the artifact directory')
  }

  const artifact = getArtifactByFilename(path.basename(full)) || getTurnArtifactByFilename(path.basename(full))
  if (artifact?.userId && artifact.userId !== userId) {
    throw withStatus(404, 'artifact not found')
  }
  return full
}

export async function getArtifactPreviewRendererStatus() {
  const libreOfficePath = await findExecutable(['libreoffice', 'soffice'])
  const pdftoppmPath = await findExecutable(['pdftoppm'])
  return {
    available: !!libreOfficePath,
    libreOfficePath,
    pdftoppmPath,
  }
}

export async function renderArtifactPreviewPng({ artifactPath, page = 1, userId = '' } = {}) {
  const status = await getArtifactPreviewRendererStatus()
  if (!status.libreOfficePath) {
    throw withStatus(503, 'LibreOffice is not installed; render-preview is unavailable')
  }
  if (!status.pdftoppmPath) {
    throw withStatus(503, 'pdftoppm is not installed; render-preview cannot extract a specific page')
  }

  const pageNo = Math.max(1, Math.floor(Number(page) || 1))
  const input = resolvePreviewArtifactPath(artifactPath, userId)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-preview-'))
  try {
    const profileDir = path.join(tmp, 'lo-profile')
    fs.mkdirSync(profileDir, { recursive: true })
    await execFileAsync(status.libreOfficePath, [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      tmp,
      input,
    ], { env: sanitizeChildEnv(), timeout: 60000, maxBuffer: 4 * 1024 * 1024 })

    let pdfPath = path.join(tmp, `${path.basename(input, path.extname(input))}.pdf`)
    if (!fs.existsSync(pdfPath)) {
      const pdf = fs.readdirSync(tmp).find((name) => name.toLowerCase().endsWith('.pdf'))
      if (pdf) pdfPath = path.join(tmp, pdf)
    }
    if (!fs.existsSync(pdfPath)) throw withStatus(500, 'LibreOffice did not produce a PDF preview source')

    const outPrefix = path.join(tmp, 'page')
    await execFileAsync(status.pdftoppmPath, [
      '-f', String(pageNo),
      '-l', String(pageNo),
      '-singlefile',
      '-png',
      '-r', '144',
      pdfPath,
      outPrefix,
    ], { env: sanitizeChildEnv(), timeout: 30000, maxBuffer: 4 * 1024 * 1024 })

    const pngPath = `${outPrefix}.png`
    if (!fs.existsSync(pngPath)) throw withStatus(404, `page ${pageNo} was not rendered`)
    const png = fs.readFileSync(pngPath)
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      page: pageNo,
      byteLength: png.length,
      renderer: 'libreoffice',
      libreOfficePath: status.libreOfficePath,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function handleArtifactDownload(req, res) {
  if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('method not allowed'); return
  }
  const requestUrl = new URL(req.url || '', 'http://localhost')
  const route = requestUrl.pathname.match(/^\/api\/artifacts\/([^/]+)(?:\/assets\/([^/]+))?$/)
  if (!route) { res.statusCode = 404; res.end('not found'); return }
  let filename = ''
  let assetId = ''
  try {
    filename = decodeURIComponent(route[1])
    assetId = route[2] ? decodeURIComponent(route[2]) : ''
  } catch { /* rejected below */ }
  if (!isSafeArtifactFilename(filename)) { res.statusCode = 400; res.end('bad filename'); return }

  let userId = authenticateRequest(req)
  if (!userId) {
    const queryToken = requestUrl.searchParams.get('token')
    if (queryToken) {
      req.headers.authorization = `Bearer ${queryToken}`
      userId = authenticateRequest(req)
    }
  }
  if (!userId) { res.statusCode = 401; res.end('Unauthorized'); return }

  const artifact = getArtifactByFilename(filename) || getTurnArtifactByFilename(filename)
  if (!artifact) { res.statusCode = 404; res.end('not found'); return }
  if (artifact.userId !== userId) {
    res.statusCode = 404; res.end('not found'); return
  }

  if (assetId) {
    if (String(artifact.type || '').toLowerCase() !== 'html') {
      res.statusCode = 404; res.end('not found'); return
    }
    let asset
    try {
      asset = getHtmlArtifactAsset({ artifactDirectory: ensureArtifactDir(), artifactId: artifact.id, assetId })
    } catch {
      res.statusCode = 404; res.end('not found'); return
    }
    if (!asset) { res.statusCode = 404; res.end('not found'); return }
    const requestedRange = req.headers.range
    const range = requestedRange ? parseArtifactRange(requestedRange, asset.size) : null
    if (requestedRange && !range) {
      res.writeHead(416, { 'Content-Range': `bytes */${asset.size}`, 'Accept-Ranges': 'bytes' })
      res.end()
      return
    }
    const headers = {
      'Content-Type': asset.mimeType,
      'Content-Disposition': artifactContentDisposition('inline', asset.filename),
      'Content-Length': range ? range.end - range.start + 1 : asset.size,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${asset.size}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    const stream = fs.createReadStream(asset.fullPath, range || undefined)
    stream.on('error', (error) => {
      console.error('[artifactGen] asset read stream error:', error?.message)
      if (!res.headersSent) { res.statusCode = 500; res.end('read error') }
    })
    stream.pipe(res)
    return
  }

  ensureArtifactDir()
  let full = path.join(ARTIFACT_DIR, filename)
  try {
    full = fs.realpathSync(full)
  } catch {
    res.statusCode = 404; res.end('not found'); return
  }
  if (!full.startsWith(fs.realpathSync(ARTIFACT_DIR) + path.sep)) { res.statusCode = 400; res.end('bad filename'); return }
  if (!fs.existsSync(full)) { res.statusCode = 404; res.end('not found'); return }
  const preview = requestUrl.searchParams.get('preview') === '1'
  const contentType = artifactContentType(filename)
  let downloadBuffer = null
  if (!preview && /^text\/html/i.test(contentType)) {
    try {
      downloadBuffer = Buffer.from(applyHtmlArtifactDocumentPolicy(
        expandHtmlArtifactAssets({
          artifactDirectory: ensureArtifactDir(),
          artifactId: artifact.id,
          html: fs.readFileSync(full, 'utf8'),
        }),
      ), 'utf8')
    } catch (error) {
      console.error('[artifactGen] offline HTML expansion failed:', error?.message)
      const assetError = String(error?.code || '').startsWith('HTML_ASSET_')
      const tooLarge = error?.code === 'HTML_ASSET_OFFLINE_TOO_LARGE'
      const status = tooLarge ? 413 : assetError ? 409 : 500
      const code = assetError ? error.code : 'HTML_ARTIFACT_DOWNLOAD_FAILED'
      const message = tooLarge
        ? 'This HTML artifact is available in the managed preview, but its bundled media is too large for a single offline HTML download. Reduce or compress the media and regenerate the file.'
        : assetError
          ? 'This HTML artifact cannot be downloaded because its bundled media is unavailable or invalid. Open the managed preview or regenerate the file.'
          : 'The offline HTML download could not be prepared. Open the managed preview or try again.'
      const payload = Buffer.from(JSON.stringify({
        error: { code, message, previewAvailable: true },
      }))
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Gugo-Error-Code': code,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(payload)
      return
    }
  }
  const size = downloadBuffer ? downloadBuffer.length : fs.statSync(full).size
  const requestedRange = req.headers.range
  const range = requestedRange ? parseArtifactRange(requestedRange, size) : null
  if (requestedRange && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    res.end()
    return
  }
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': artifactContentDisposition(preview ? 'inline' : 'attachment', filename),
    'Content-Length': range ? range.end - range.start + 1 : size,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  if (preview && contentType === 'application/pdf') headers['X-Frame-Options'] = 'SAMEORIGIN'
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
  if (preview && /^text\/html/i.test(contentType)) {
    headers['Content-Security-Policy'] = HTML_ARTIFACT_RESPONSE_CSP
  } else if (preview && /^image\/svg\+xml/i.test(contentType)) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
  }
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  if (downloadBuffer) {
    res.end(range ? downloadBuffer.subarray(range.start, range.end + 1) : downloadBuffer)
    return
  }
  const stream = fs.createReadStream(full, range || undefined)
  stream.on('error', (error) => {
    console.error('[artifactGen] read stream error:', error?.message)
    if (!res.headersSent) {
      res.statusCode = 500; res.end('read error')
    }
  })
  stream.pipe(res)
}
