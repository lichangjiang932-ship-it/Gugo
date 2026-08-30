import {
  BATCH_FILE_TOOL_SPECS,
} from '../../../adapters/batchFileTools.js'
import {
  CODING_AGENT_TOOL_SPECS,
} from '../../../adapters/codingAgentTools.js'
import {
  FS_SHELL_TOOL_SPECS,
  resolveForFileTool,
} from '../../../adapters/fsShellTools.js'
import {
  IMAGE_TOOL_SPECS,
} from '../../../adapters/imageTools.js'
import {
  MAX_HTML_ARTIFACT_BYTES,
} from '../../htmlArtifactFormat.js'
import { resolveOfficeArtifactImageInputs } from '../../officeArtifactImages.js'
import {
  MEDIA_TOOL_SPECS,
} from '../../../adapters/mediaTools.js'
import {
  PDF_TOOL_SPECS,
} from '../../../adapters/pdfTools.js'
import fs from 'node:fs'
import {
  getManagedAttachment,
} from '../../managedAttachmentStore.js'
import {
  htmlArtifactAssetIds,
  htmlArtifactVisibleImageAssetIds,
} from '../../htmlArtifactAssets.js'
import path from 'node:path'

export const FS_SHELL_TOOL_NAMES = new Set(
  FS_SHELL_TOOL_SPECS.map((spec) => String(spec?.function?.name || '')).filter(Boolean),
)
export const IMAGE_TOOL_NAMES = new Set(IMAGE_TOOL_SPECS.map((spec) => spec.function.name))
export const MEDIA_TOOL_NAMES = new Set(MEDIA_TOOL_SPECS.map((spec) => spec.function.name))
export const PDF_TOOL_NAMES = new Set(PDF_TOOL_SPECS.map((spec) => spec.function.name))
export const BATCH_FILE_TOOL_NAMES = new Set(BATCH_FILE_TOOL_SPECS.map((spec) => spec.function.name))
export const CODING_AGENT_TOOL_NAMES = new Set(CODING_AGENT_TOOL_SPECS.map((spec) => spec.function.name))
export const COMMAND_EXECUTION_TOOL_NAMES = new Set(['bash_exec', 'run_command'])
export const COMMAND_OUTPUT_TOOL_NAMES = new Set([...COMMAND_EXECUTION_TOOL_NAMES, 'docker_exec'])
export const LOCAL_ARTIFACT_TOOL_NAMES = new Set([
  'write_file',
  ...COMMAND_OUTPUT_TOOL_NAMES,
  'image_transform',
  'media_transform',
  'pdf_transform',
  'archive_create',
  'file_download',
])
export const HTML_ATTACHMENT_URI = /attachment:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,127})/g
export const HTML_INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])
export const HTML_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'])
export const COMPLETE_HTML_MEDIA_COLLECTION = /(?:(?:所有|全部|每(?:一|个|张)|确保)[\s\S]{0,40}(?:jpe?g|png|webp|图片|照片|图像)|(?:jpe?g|png|webp|图片|照片|图像)[\s\S]{0,40}(?:所有|全部|每(?:一|个|张)|都被使用)|(?:all|every|each|entire)[\s\S]{0,40}(?:jpe?g|png|webp|images?|photos?))/i

export function htmlCollectionError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = true
  Object.assign(error, extra)
  return error
}

export function comparableLocalPath(filePath) {
  const normalized = path.normalize(String(filePath || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function requestedHtmlMediaExtensions(prompt = '') {
  const text = String(prompt || '')
  const extensions = new Set()
  if (/jpe?g/i.test(text)) {
    extensions.add('.jpg')
    extensions.add('.jpeg')
  }
  if (/\bpng\b/i.test(text)) extensions.add('.png')
  if (/\bwebp\b/i.test(text)) extensions.add('.webp')
  if (/\bavif\b/i.test(text)) extensions.add('.avif')
  if (extensions.size > 0) return extensions
  return new Set(HTML_MEDIA_EXTENSIONS)
}

export function collectHtmlMediaFiles(rootPath, { extensions, recursive = true, limit = 500 } = {}) {
  const files = []
  const pending = [fs.realpathSync(rootPath)]
  while (pending.length > 0) {
    const directory = pending.shift()
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (recursive) pending.push(candidate)
        continue
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue
      files.push(fs.realpathSync(candidate))
      if (files.length > limit) {
        throw htmlCollectionError(
          'HTML_MEDIA_COLLECTION_TOO_LARGE',
          `The requested media collection contains more than ${limit} supported files. Split the gallery into smaller deliverables.`,
        )
      }
    }
  }
  return files
}

export function requestedArtifactOutputDirective(prompt = '') {
  const text = String(prompt || '')
  // A source file commonly appears shortly after words such as “生成” (for
  // example: “生成 Word，把 C:\\source.png 插入其中”). Treat a local
  // path as a destination only when the wording contains an explicit
  // destination connector; otherwise the configured default directory wins.
  const connector = '(?:写入|写到|写至|存到|存至|放到|放至|保存(?:到|至)|生成(?:到|至)|导出(?:到|至)|(?:write|save|export)\\s+(?:to|in))'
  const candidates = []
  const isNegated = (index) => /(?:不要|别再?|不再|禁止|勿|无需|不用|不需要|do\s+not|don't|never)[^。！？!?，,；;\n]{0,16}$/i
    .test(text.slice(Math.max(0, index - 32), index))
  const addCandidate = (index, rawValue) => {
    if (isNegated(index)) {
      candidates.push({ index, directory: '' })
      return
    }
    let candidate = String(rawValue || '').trim()
      .replace(/[，。；;,.!?！？]+$/u, '')
      .replace(/\s+(?:(?:然后|并且|并|再|完成后)[\s\S]*|(?:and\s+then|then|afterwards)\b[\s\S]*)$/i, '')
      .replace(/\s+(?:这个|该)?(?:目录|文件夹|路径)$/u, '')
      .trim()
    if (!candidate) return
    if (/^[a-z]:$/i.test(candidate)) candidate += path.sep
    // User prompts can contain Windows paths even when the server/test runner
    // itself is hosted on Linux. node:path follows the host platform, so
    // path.isAbsolute('E:\\output') is false on POSIX and silently drops an
    // otherwise explicit destination. Select path semantics from the value
    // instead of from process.platform, while keeping POSIX paths unchanged.
    const pathApi = /^[a-z]:[\\/]/i.test(candidate) || /^\\\\[^\\]/.test(candidate)
      ? path.win32
      : candidate.startsWith('/')
        ? path.posix
        : null
    if (!pathApi?.isAbsolute(candidate)) return
    candidate = pathApi.normalize(candidate)
    const extension = pathApi.extname(pathApi.basename(candidate)).toLowerCase()
    const generatedFileExtensions = new Set([
      '.html', '.htm', '.pptx', '.docx', '.xlsx', '.pdf',
      '.png', '.jpg', '.jpeg', '.webp', '.avif',
    ])
    candidates.push({
      index,
      directory: generatedFileExtensions.has(extension) ? pathApi.dirname(candidate) : candidate,
    })
  }

  const quoted = new RegExp(`${connector}\\s*["'\u0060“‘]((?:[a-z]:[\\\\/]|/)[^\\r\\n"'\u0060”’<>|?*]+)["'\u0060”’]`, 'gi')
  for (const match of text.matchAll(quoted)) addCandidate(match.index, match[1])

  const unquoted = new RegExp(`${connector}\\s*((?:[a-z]:[\\\\/]|/)[^\\r\\n，。；;!?！？"'\u0060”’<>|?*]*)`, 'gi')
  for (const match of text.matchAll(unquoted)) addCandidate(match.index, match[1])

  // Keep the drive adjacent to a destination connector. A broad gap here
  // turns “生成网站，读取 E 盘图片” into a false E-drive output request.
  const drive = /(?:写(?:入|到|至)|存(?:到|至)|保存(?:到|至)?|生成(?:到|至)|导出(?:到|至)|放(?:到|至)|(?:write|save|export)\s+(?:to|in))\s*([a-z])\s*(?:盘|drive\b)/gi
  for (const match of text.matchAll(drive)) {
    candidates.push({
      index: match.index,
      directory: isNegated(match.index) ? '' : `${match[1].toUpperCase()}:${path.sep}`,
    })
  }

  const configuredDefault = /(?:(?:使用|改用|用|恢复使用|回到|写到|保存到)\s*)?(?:默认(?:的)?(?:生成|输出|保存)?(?:目录|文件夹|位置|路径)|default\s+(?:output\s+)?(?:directory|folder|location|path))/gi
  for (const match of text.matchAll(configuredDefault)) {
    if (!isNegated(match.index)) candidates.push({ index: match.index, directory: '' })
  }

  candidates.sort((left, right) => left.index - right.index)
  const selected = candidates.at(-1)
  return selected
    ? { hasDirective: true, directory: selected.directory }
    : { hasDirective: false, directory: '' }
}

export function requestedArtifactOutputDirectory(prompt = '') {
  return requestedArtifactOutputDirective(prompt).directory
}

export function attachmentUriOccurrences(source, uri) {
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(uri, offset)) !== -1) {
    count += 1
    offset += uri.length
  }
  return count
}

export function predictedInlineBytes(source, uri, attachment, mimeType) {
  const occurrences = attachmentUriOccurrences(source, uri)
  const encodedBytes = Math.ceil(Number(attachment.size || 0) / 3) * 4
  const dataUriBytes = Buffer.byteLength(`data:${mimeType};base64,`, 'utf8') + encodedBytes
  return Buffer.byteLength(source, 'utf8')
    - (Buffer.byteLength(uri, 'utf8') * occurrences)
    + (dataUriBytes * occurrences)
}

export async function inlineHtmlAttachmentUris(value, { userId } = {}) {
  const source = String(value || '')
  const attachmentIds = [...new Set([...source.matchAll(HTML_ATTACHMENT_URI)].map((match) => match[1]))]
  let resolved = source
  for (const attachmentId of attachmentIds) {
    const attachment = getManagedAttachment({ userId, id: attachmentId })
    if (!attachment || attachment.status !== 'ready') {
      throw new Error('html references an attachment that is unavailable or not owned by the current user')
    }
    const mimeType = String(attachment.mimeType || '').split(';', 1)[0].trim().toLowerCase()
    if (!HTML_INLINE_IMAGE_MIMES.has(mimeType)) {
      throw new Error('html attachment references must point to a supported raster image')
    }
    const uri = `attachment://${attachmentId}`
    if (predictedInlineBytes(resolved, uri, attachment, mimeType) > MAX_HTML_ARTIFACT_BYTES) {
      throw new Error('html attachment is too large to inline; resize or compress the image first')
    }
    const bytes = await fs.promises.readFile(attachment.fullPath)
    const dataUri = `data:${mimeType};base64,${bytes.toString('base64')}`
    resolved = resolved.replaceAll(uri, dataUri)
    if (Buffer.byteLength(resolved, 'utf8') > MAX_HTML_ARTIFACT_BYTES) {
      throw new Error('html attachment is too large to inline; resize or compress the image first')
    }
  }
  return resolved
}

export async function resolveHtmlArtifactArgs(args = {}, { userId, prompt = '' } = {}) {
  const resolved = { ...args }
  if (typeof resolved.html === 'string') {
    resolved.html = await inlineHtmlAttachmentUris(resolved.html, { userId })
  }
  if (resolved.files && typeof resolved.files === 'object' && !Array.isArray(resolved.files)) {
    resolved.files = Object.fromEntries(await Promise.all(Object.entries(resolved.files).map(async ([name, content]) => [
      name,
      typeof content === 'string' ? await inlineHtmlAttachmentUris(content, { userId }) : content,
    ])))
  }
  const markerSource = [resolved.html, ...Object.values(resolved.files || {})]
    .filter((value) => typeof value === 'string')
    .join('\n')
  const assetIds = htmlArtifactAssetIds(markerSource)
  const visibleImageAssetIds = new Set(htmlArtifactVisibleImageAssetIds(markerSource))
  const referenced = new Set(assetIds)
  const seen = new Set()
  const sources = []
  for (const entry of Array.isArray(resolved.assets) ? resolved.assets : []) {
    const id = String(entry?.id || '').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid HTML asset id')
    if (seen.has(id)) throw new Error(`duplicate HTML asset id: ${id}`)
    if (!referenced.has(id)) throw new Error(`HTML asset is declared but not referenced: ${id}`)
    seen.add(id)
    const rawPath = String(entry?.path || '').trim()
    if (!rawPath) continue
    const source = resolveForFileTool(rawPath, { userId })
    sources.push({ id, sourcePath: source.fullPath })
  }
  const completeCollectionRequested = COMPLETE_HTML_MEDIA_COLLECTION.test(String(prompt || ''))
  const collection = resolved.asset_collection && typeof resolved.asset_collection === 'object'
    ? resolved.asset_collection
    : null
  if (completeCollectionRequested && !collection?.directory) {
    throw htmlCollectionError(
      'HTML_MEDIA_COLLECTION_REQUIRED',
      'The user requested every image from a directory. Set asset_collection.directory, declare every returned file in assets, and reference every asset with gugo-asset://<id>.',
    )
  }
  let collectionCount = 0
  if (collection?.directory) {
    let directory
    try {
      directory = resolveForFileTool(String(collection.directory), { userId })
    } catch (cause) {
      throw htmlCollectionError(
        'HTML_MEDIA_COLLECTION_UNAVAILABLE',
        `asset_collection.directory is unavailable: ${cause?.message || cause}`,
      )
    }
    if (!fs.statSync(directory.fullPath).isDirectory()) {
      throw htmlCollectionError('HTML_MEDIA_COLLECTION_NOT_DIRECTORY', 'asset_collection.directory must reference a readable directory.')
    }
    const extensions = completeCollectionRequested
      ? requestedHtmlMediaExtensions(prompt)
      : new Set((Array.isArray(collection.extensions) ? collection.extensions : [])
          .map((extension) => `.${String(extension || '').replace(/^\./, '').toLowerCase()}`)
          .filter((extension) => HTML_MEDIA_EXTENSIONS.has(extension)))
    const requiredFiles = collectHtmlMediaFiles(directory.fullPath, {
      extensions: extensions.size > 0 ? extensions : new Set(HTML_MEDIA_EXTENSIONS),
      recursive: collection.recursive !== false,
    })
    if (completeCollectionRequested && requiredFiles.length === 0) {
      throw htmlCollectionError('HTML_MEDIA_COLLECTION_EMPTY', 'No requested image files were found in asset_collection.directory.')
    }
    const providedPaths = new Set(sources.map(({ sourcePath }) => comparableLocalPath(sourcePath)))
    const missingFiles = requiredFiles.filter((filePath) => !providedPaths.has(comparableLocalPath(filePath)))
    if (missingFiles.length > 0) {
      throw htmlCollectionError(
        'HTML_MEDIA_COLLECTION_INCOMPLETE',
        `The HTML media collection is incomplete: ${missingFiles.length} of ${requiredFiles.length} required files are missing from assets. Missing examples: ${missingFiles.slice(0, 20).map((filePath) => path.basename(filePath)).join(', ')}.`,
        { missingCount: missingFiles.length, requiredCount: requiredFiles.length },
      )
    }
    if (completeCollectionRequested) {
      const requiredPaths = new Set(requiredFiles.map(comparableLocalPath))
      const hiddenSources = sources.filter(({ id, sourcePath }) => (
        requiredPaths.has(comparableLocalPath(sourcePath)) && !visibleImageAssetIds.has(id)
      ))
      if (hiddenSources.length > 0) {
        throw htmlCollectionError(
          'HTML_MEDIA_COLLECTION_NOT_VISIBLE',
          `The HTML media collection is not visibly rendered: ${hiddenSources.length} of ${requiredFiles.length} required images are hidden or only referenced outside a visible image slot. Hidden examples: ${hiddenSources.slice(0, 20).map(({ sourcePath }) => path.basename(sourcePath)).join(', ')}.`,
          { hiddenCount: hiddenSources.length, requiredCount: requiredFiles.length },
        )
      }
    }
    collectionCount = requiredFiles.length
  }
  resolved.assets = assetIds.map((id) => ({ id }))
  delete resolved.asset_collection
  Object.defineProperty(resolved, '_htmlAssetIds', { value: assetIds, enumerable: false })
  Object.defineProperty(resolved, '_htmlAssetSources', { value: sources, enumerable: false })
  Object.defineProperty(resolved, '_htmlCollectionCount', { value: collectionCount, enumerable: false })
  return resolved
}

export function resolveOfficeArtifactArgs(args = {}, { userId } = {}) {
  const resolved = { ...args }
  const images = resolveOfficeArtifactImageInputs(Array.isArray(args.images) ? args.images : [], { userId })
  Object.defineProperty(resolved, '_officeImages', { value: images, enumerable: false })
  return resolved
}

// 死循环护栏,不是工作预算。后台任务无人盯着,不能真的无限跑 ——
// 但真正的收敛是 jobBudget(累积调用数 + 挂钟时间),那个和成本线性相关。
//
