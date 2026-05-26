/**
 * P3: PPTX → PNG 真实版式渲染（LibreOffice headless + pdftoppm）。
 *
 * 链路: .pptx → LibreOffice --convert-to pdf → pdftoppm -r 96 -png → /tmp/sliceN.png
 *
 * 设计:
 *   - probeRenderer() 探测系统是否装了 libreoffice 与 pdftoppm; 缺一就不走这条路, 由调用方 fallback.
 *   - renderPptxPage({ srcPath, page, dpi }) 命中缓存直接返 Buffer; 未命中跑全文 PDF + pdftoppm 一次切到所有页, 入缓存.
 *   - 缓存 key: sha256(srcPath + mtime + dpi). 一次切多页一次入. LRU 上限 200 MB.
 *   - 超时 LIBRE_TIMEOUT_MS = 45000, kill 子进程, 抛 timeout 错; 不让单次坏文件挂住进程.
 *   - 同源并发: 同一 (srcPath, mtime) 转换只跑一次, 后到的 await 同一个 promise.
 *   - 暴露 _testReset() 给单测重置缓存与 inflight.
 *
 * 不在这里做的: 鉴权 / ownership / path traversal / 下载 → handleArtifactDownload 已有, render 路由复用.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const LIBRE_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 45000
const CACHE_MAX_BYTES = Number(process.env.RENDER_CACHE_MAX_BYTES) || 200 * 1024 * 1024
const DEFAULT_DPI = 110

const CACHE_DIR =
  process.env.RENDER_CACHE_DIR && path.isAbsolute(process.env.RENDER_CACHE_DIR)
    ? process.env.RENDER_CACHE_DIR
    : path.resolve(process.cwd(), '.cache/artifact-renders')

/* ────────────── probe ────────────── */

let _probeCache = null

export async function probeRenderer() {
  if (_probeCache) return _probeCache
  const [libre, pdftoppm] = await Promise.all([
    findBin(['libreoffice', 'soffice']),
    findBin(['pdftoppm']),
  ])
  _probeCache = {
    libreoffice: libre,
    pdftoppm,
    available: !!(libre && pdftoppm),
  }
  return _probeCache
}

async function findBin(candidates) {
  for (const name of candidates) {
    const found = await new Promise((resolve) => {
      const p = spawn('which', [name])
      let out = ''
      p.stdout.on('data', (b) => (out += String(b)))
      p.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null))
      p.on('error', () => resolve(null))
    })
    if (found) return found
  }
  return null
}

/* ────────────── cache ────────────── */

const inflight = new Map() // key -> Promise<Map<page, Buffer>>
const cacheIndex = new Map() // key -> { size, mtime, dir, pages: Map<page, filePath> }
let cacheBytes = 0

function cacheKey(srcPath, mtimeMs, dpi) {
  const h = crypto.createHash('sha256')
  h.update(`${srcPath}\0${mtimeMs}\0${dpi}`)
  return h.digest('hex')
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
}

function evictUntilFits(needBytes) {
  if (cacheBytes + needBytes <= CACHE_MAX_BYTES) return
  // LRU: Map 保留插入顺序, 最旧的在头
  for (const [k, entry] of cacheIndex) {
    if (cacheBytes + needBytes <= CACHE_MAX_BYTES) break
    try { fs.rmSync(entry.dir, { recursive: true, force: true }) } catch { /* noop */ }
    cacheBytes -= entry.size
    cacheIndex.delete(k)
  }
}

function touchEntry(key) {
  const entry = cacheIndex.get(key)
  if (!entry) return null
  // LRU 更新: 删除再插入 → 移到尾部
  cacheIndex.delete(key)
  cacheIndex.set(key, entry)
  return entry
}

/* ────────────── render ────────────── */

/**
 * 渲染指定页 (1-based) 为 PNG Buffer.
 *
 * @param {object} opts
 * @param {string} opts.srcPath  .pptx 绝对路径
 * @param {number} opts.page     1-based 页码
 * @param {number} [opts.dpi]    分辨率 (默认 110)
 * @returns {Promise<Buffer>}
 * @throws  Error('renderer unavailable')  / Error('libreoffice timeout')
 *         / Error('libreoffice failed: ...') / Error('page out of range')
 */
export async function renderPptxPage({ srcPath, page, dpi = DEFAULT_DPI }) {
  if (!Number.isInteger(page) || page < 1) throw new Error('invalid page')
  const probe = await probeRenderer()
  if (!probe.available) {
    throw new Error('renderer unavailable')
  }

  const stat = fs.statSync(srcPath) // throws if missing
  const key = cacheKey(srcPath, stat.mtimeMs, dpi)

  // 命中缓存
  const hit = touchEntry(key)
  if (hit) {
    const pagePath = hit.pages.get(page)
    if (!pagePath) throw new Error('page out of range')
    return fs.readFileSync(pagePath)
  }

  // 同源去重
  if (inflight.has(key)) {
    const pages = await inflight.get(key)
    const pagePath = pages.get(page)
    if (!pagePath) throw new Error('page out of range')
    return fs.readFileSync(pagePath)
  }

  const job = doRender({ srcPath, dpi, key, mtimeMs: stat.mtimeMs }).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, job)
  const pages = await job
  const pagePath = pages.get(page)
  if (!pagePath) throw new Error('page out of range')
  return fs.readFileSync(pagePath)
}

async function doRender({ srcPath, dpi, key, mtimeMs }) {
  ensureCacheDir()
  const workDir = path.join(CACHE_DIR, key)
  fs.mkdirSync(workDir, { recursive: true })

  // 1) pptx → pdf  (LibreOffice 用单独 USER profile 避免并发 lock)
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'))
  const probe = await probeRenderer()
  const libreArgs = [
    `-env:UserInstallation=file://${profileDir}`,
    '--headless',
    '--norestore',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to', 'pdf',
    '--outdir', workDir,
    srcPath,
  ]
  try {
    await runWithTimeout(probe.libreoffice, libreArgs, LIBRE_TIMEOUT_MS, 'libreoffice')
  } finally {
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* noop */ }
  }

  // LibreOffice 输出 <basename>.pdf
  const base = path.basename(srcPath, path.extname(srcPath))
  const pdfPath = path.join(workDir, `${base}.pdf`)
  if (!fs.existsSync(pdfPath)) {
    throw new Error('libreoffice produced no pdf')
  }

  // 2) pdf → png (按页拆)
  const prefix = path.join(workDir, 'p')
  await runWithTimeout(probe.pdftoppm, ['-r', String(dpi), '-png', pdfPath, prefix], LIBRE_TIMEOUT_MS, 'pdftoppm')

  // pdftoppm 输出 p-1.png / p-2.png ... 或 p-01.png 当 >9 页 (zero-padded). 全扫一遍.
  const entries = fs.readdirSync(workDir).filter((n) => /^p-\d+\.png$/.test(n)).sort()
  if (entries.length === 0) throw new Error('pdftoppm produced no png')
  const pages = new Map()
  let totalBytes = 0
  for (const name of entries) {
    const m = name.match(/^p-(\d+)\.png$/)
    const num = Number(m[1])
    const full = path.join(workDir, name)
    pages.set(num, full)
    totalBytes += fs.statSync(full).size
  }

  // 清理 pdf (节省缓存空间; 不再需要)
  try { fs.unlinkSync(pdfPath) } catch { /* noop */ }

  evictUntilFits(totalBytes)
  cacheIndex.set(key, { size: totalBytes, mtime: mtimeMs, dir: workDir, pages })
  cacheBytes += totalBytes

  return pages
}

function runWithTimeout(bin, args, timeoutMs, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (b) => (stdout += String(b)))
    child.stderr.on('data', (b) => (stderr += String(b)))

    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* noop */ }
      reject(new Error(`${name} timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('error', (err) => { clearTimeout(t); reject(err) })
    child.on('close', (code) => {
      clearTimeout(t)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${name} failed (code ${code}): ${stderr.slice(-200) || stdout.slice(-200)}`))
    })
  })
}

/* ────────────── 测试 hook ────────────── */

export function _testReset() {
  for (const entry of cacheIndex.values()) {
    try { fs.rmSync(entry.dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
  cacheIndex.clear()
  cacheBytes = 0
  inflight.clear()
  _probeCache = null
}

export function _testStats() {
  return { cacheBytes, entries: cacheIndex.size, inflight: inflight.size, CACHE_DIR, CACHE_MAX_BYTES }
}
