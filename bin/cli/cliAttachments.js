/**
 * CLI attachments: `--file <path>` / `--image <path>` for `gugo run` and `gugo chat`.
 *
 * The CLI currently has no attachment path at all (`grep attachment bin/` finds nothing),
 * while the browser side has had one for a while. Rather than invent a second shape, this
 * module produces the *same* attachment objects the shared renderer already consumes
 * (`src/lib/attachments.js`): `{ kind, name, sizeKB, type, dataUrl?, text? }`.
 *
 * Split into a pure half and an IO half on purpose — argument parsing and classification
 * are testable without touching the disk, and only `loadAttachmentObject` reads files.
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { CliUsageError } from './errors.js'

/** Hard ceiling per attachment; a CLI flag must not let a stray file eat the context. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Per-invocation ceiling, matching the browser composer's practical limit. */
export const MAX_ATTACHMENTS = 8

const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
})

const TEXT_EXTENSIONS = Object.freeze(new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.css', '.js', '.mjs',
  '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bat', '.ps1', '.sql',
]))

const PDF_EXTENSION = '.pdf'

/** Classify a path by extension. Unknown types stay `file`: the prompt notes the name and
 *  size, and the model decides whether it can do anything with it. */
export function classifyAttachment(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase()
  if (IMAGE_MIME_BY_EXT[ext]) return { kind: 'image', mime: IMAGE_MIME_BY_EXT[ext] }
  if (ext === PDF_EXTENSION) return { kind: 'pdf', mime: 'application/pdf' }
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', mime: 'text/plain' }
  return { kind: 'file', mime: 'application/octet-stream' }
}

/**
 * Split `--file` / `--image` out of an argv slice.
 *
 * Both `--flag value` and `--flag=value` work; a repeated flag accumulates. Anything else
 * is returned untouched in `rest` so the caller's existing parser keeps working.
 */
export function parseAttachmentFlags(argv = []) {
  const files = []
  const images = []
  const rest = []
  const list = Array.isArray(argv) ? argv : []

  for (let index = 0; index < list.length; index += 1) {
    const raw = String(list[index])
    let target = null
    let value = null
    if (raw === '--file' || raw === '--image') {
      target = raw === '--file' ? files : images
      value = list[index + 1]
      index += 1
    } else if (raw.startsWith('--file=')) {
      target = files
      value = raw.slice('--file='.length)
    } else if (raw.startsWith('--image=')) {
      target = images
      value = raw.slice('--image='.length)
    }
    if (!target) {
      rest.push(raw)
      continue
    }
    const trimmed = String(value ?? '').trim()
    if (!trimmed) throw new CliUsageError('CLI_ATTACHMENT_PATH_REQUIRED', `${raw.split('=')[0]} requires a file path`)
    target.push(trimmed)
  }

  return { files, images, rest }
}

/** Merge both flag lists into ordered `{ path, kind }` requests, enforcing the count cap. */
export function collectAttachmentRequests({ files = [], images = [] } = {}) {
  const requests = [
    ...files.map((filePath) => ({ path: filePath, kind: 'auto' })),
    ...images.map((filePath) => ({ path: filePath, kind: 'image' })),
  ]
  if (requests.length > MAX_ATTACHMENTS) {
    throw new CliUsageError(
      'CLI_TOO_MANY_ATTACHMENTS',
      `at most ${MAX_ATTACHMENTS} attachments per invocation (got ${requests.length})`,
    )
  }
  return requests
}

/**
 * Read one attachment into the shape the shared prompt builder expects.
 *
 * `kind: 'auto'` classifies by extension; `kind: 'image'` (the `--image` flag) forces the
 * image path and rejects anything that is not a known image type, so a typo fails loudly
 * instead of silently degrading into a filename note.
 */
export function loadAttachmentObject(request, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const filePath = path.resolve(String(request?.path ?? ''))
  const requestedKind = request?.kind ?? 'auto'

  let stat
  try {
    stat = statSync(filePath)
  } catch {
    throw new CliUsageError('CLI_ATTACHMENT_NOT_FOUND', `attachment not found: ${filePath}`)
  }
  if (!stat.isFile()) {
    throw new CliUsageError('CLI_ATTACHMENT_NOT_A_FILE', `attachment is not a file: ${filePath}`)
  }
  if (stat.size > maxBytes) {
    throw new CliUsageError(
      'CLI_ATTACHMENT_TOO_LARGE',
      `${path.basename(filePath)} is ${Math.round(stat.size / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB`,
    )
  }

  const effective = classifyAttachment(filePath)
  if (requestedKind === 'image' && effective.kind !== 'image') {
    throw new CliUsageError(
      'CLI_ATTACHMENT_NOT_AN_IMAGE',
      `--image expects a png/jpg/jpeg/gif/webp/bmp file, got: ${path.basename(filePath)}`,
    )
  }

  const name = path.basename(filePath)
  const sizeKB = Math.max(1, Math.round(stat.size / 1024))
  const base = { name, sizeKB, type: effective.mime, path: filePath }

  if (effective.kind === 'image' || effective.kind === 'pdf') {
    const base64 = readFileSync(filePath).toString('base64')
    return { ...base, kind: effective.kind, dataUrl: `data:${effective.mime};base64,${base64}` }
  }
  if (effective.kind === 'text') {
    return { ...base, kind: 'text', text: readFileSync(filePath, 'utf8') }
  }
  return { ...base, kind: 'file' }
}

/** Load every request in order. The first failure aborts: a half-attached prompt is worse
 *  than a clear error before the turn starts. */
export function loadAttachments(requests, options) {
  return requests.map((request) => loadAttachmentObject(request, options))
}

/**
 * Flatten loaded attachments into the single string a headless run accepts.
 *
 * `gugo run` passes `prompt` as a plain string to the runtime, so multimodal parts have no
 * transport on this path — images and PDFs belong to `gugo chat` and the web composer,
 * which send a content array. Refusing is deliberate: a run that silently ignored
 * `--image` would look like the model failed to read the picture.
 *
 * Text and generic files keep the same `[附件: name, sizeKB]` framing the shared browser
 * builder uses (`src/lib/attachments.js`), so a transcript reads identically either way.
 */
export function buildPromptWithAttachments(prompt, attachments = []) {
  const items = Array.isArray(attachments) ? attachments : []
  const multimodal = items.filter((item) => item.kind === 'image' || item.kind === 'pdf')
  if (multimodal.length > 0) {
    throw new CliUsageError(
      'CLI_ATTACHMENT_NEEDS_MULTIMODAL',
      `${multimodal.map((item) => item.name).join(', ')} needs the multimodal path; `
        + 'a headless run sends a plain-text prompt. Use `gugo chat` or the web composer for images and PDFs.',
    )
  }
  const appended = items.map((item) => (
    item.kind === 'text' && typeof item.text === 'string'
      ? `\n\n[附件: ${item.name}, ${item.sizeKB} KB]\n\`\`\`\n${item.text}\n\`\`\``
      : `\n\n[附件: ${item.name}, ${item.sizeKB} KB, 类型: ${item.type || 'unknown'}]`
  )).join('')
  const base = String(prompt ?? '').trim() || '请分析附件内容。'
  return `${base}${appended}`
}
