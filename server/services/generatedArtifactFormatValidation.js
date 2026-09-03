import fs from 'node:fs'
import path from 'node:path'

import { invalid } from './generatedArtifactFormatValidationError.js'
import { validateGeneratedArtifactImage } from './generatedArtifactImageValidation.js'
import { validateGeneratedArtifactOffice } from './generatedArtifactOfficeValidation.js'
import { validateGeneratedArtifactPdf } from './generatedArtifactPdfValidation.js'

export {
  GeneratedArtifactFormatError,
  isGeneratedArtifactFormatError,
} from './generatedArtifactFormatValidationError.js'

const MAX_FILE_BYTES = 256 * 1024 * 1024
const FORMAT_BY_TOOL = Object.freeze({
  create_docx: 'docx',
  create_pptx: 'pptx',
  create_xlsx: 'xlsx',
  create_pdf: 'pdf',
  generate_image: 'image',
  render_pdf_pages: 'image',
})

function checkedFile(filePath) {
  const raw = String(filePath || '').trim()
  if (!raw || !path.isAbsolute(raw)) {
    invalid('ARTIFACT_FORMAT_PATH_INVALID', 'Generated artifact validation requires an absolute file path.')
  }
  let canonical
  let stat
  try {
    canonical = fs.realpathSync(raw)
    stat = fs.statSync(canonical)
  } catch (cause) {
    invalid('ARTIFACT_FORMAT_FILE_UNREADABLE', 'The generated artifact file cannot be read.', cause)
  }
  if (!stat.isFile()) invalid('ARTIFACT_FORMAT_FILE_INVALID', 'The generated artifact path is not a file.')
  if (stat.size <= 0) invalid('ARTIFACT_FORMAT_FILE_EMPTY', 'The generated artifact file is empty.')
  if (stat.size > MAX_FILE_BYTES) {
    invalid('ARTIFACT_FORMAT_FILE_TOO_LARGE', 'The generated artifact is too large for bounded validation.')
  }
  try {
    return { canonical, stat, bytes: fs.readFileSync(canonical) }
  } catch (cause) {
    invalid('ARTIFACT_FORMAT_FILE_UNREADABLE', 'The generated artifact file cannot be read.', cause)
  }
}

function isPathInside(candidate, directory) {
  const relative = path.relative(directory, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Remove a rejected generated file only when both its lexical path and its
 * resolved target are inside the managed artifact directory. This prevents a
 * malformed tool result (or a symlink) from turning validation cleanup into
 * an arbitrary file deletion primitive.
 */
export function discardInvalidGeneratedArtifactFile({ filePath, artifactDirectory } = {}) {
  const rawFile = String(filePath || '').trim()
  const rawDirectory = String(artifactDirectory || '').trim()
  if (!rawFile || !rawDirectory || !path.isAbsolute(rawFile) || !path.isAbsolute(rawDirectory)) return false

  const directory = path.resolve(rawDirectory)
  const candidate = path.resolve(rawFile)
  if (!isPathInside(candidate, directory)) return false

  let realDirectory
  let realCandidate
  let candidateStat
  try {
    realDirectory = fs.realpathSync(directory)
    candidateStat = fs.lstatSync(candidate)
    realCandidate = fs.realpathSync(candidate)
  } catch {
    return false
  }
  if (!fs.statSync(realDirectory).isDirectory() || candidateStat.isDirectory()
    || !isPathInside(realCandidate, realDirectory)) return false

  try {
    fs.rmSync(candidate, { force: true })
    return !fs.existsSync(candidate)
  } catch {
    return false
  }
}

function resolveFormat({ toolName, artifactType, filename, filePath }) {
  const toolFormat = FORMAT_BY_TOOL[String(toolName || '').trim()]
  const type = String(artifactType || '').trim().toLowerCase()
  const extension = path.extname(String(filename || filePath || '')).slice(1).toLowerCase()
  const extensionFormat = extension === 'jpeg' ? 'image'
    : ['png', 'jpg', 'webp'].includes(extension) ? 'image'
      : ['docx', 'pptx', 'xlsx', 'pdf'].includes(extension) ? extension
        : null
  const declaredFormat = type === 'image' ? 'image'
    : ['docx', 'pptx', 'xlsx', 'pdf'].includes(type) ? type
      : null
  const format = toolFormat || declaredFormat || extensionFormat
  if (!format) {
    invalid('ARTIFACT_FORMAT_UNSUPPORTED', 'The generated artifact format is not supported by the validator.')
  }
  if (toolFormat && declaredFormat && toolFormat !== declaredFormat) {
    invalid('ARTIFACT_FORMAT_TYPE_MISMATCH', 'The generated artifact type does not match its generator.')
  }
  if (!extensionFormat || extensionFormat !== format) {
    invalid('ARTIFACT_FORMAT_EXTENSION_MISMATCH', 'The generated artifact extension does not match its format.')
  }
  return { format, extension }
}

/**
 * Validate a generated deliverable before it is exposed as a completed
 * artifact. All parsers are bounded because this runs on the turn
 * execution path and must not turn malformed output into a resource attack.
 */
export async function validateGeneratedArtifactFile({ filePath, filename = '', toolName = '', artifactType = '' } = {}) {
  const { canonical, stat, bytes } = checkedFile(filePath)
  const { format, extension } = resolveFormat({ toolName, artifactType, filename, filePath: canonical })
  const details = format === 'image'
    ? await validateGeneratedArtifactImage(bytes, extension)
    : format === 'pdf'
      ? await validateGeneratedArtifactPdf(bytes)
      : await validateGeneratedArtifactOffice(bytes, format)
  return { ok: true, format, byteLength: stat.size, ...details }
}
