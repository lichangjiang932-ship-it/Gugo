import {
  appendJobArtifact,
} from '../../jobStore.js'
import {
  appendTurnArtifact,
  getTurnArtifactById,
} from '../../turnArtifactStore.js'
import {
  beginHtmlArtifactAssetInstall,
  discardStagedHtmlArtifactAssets,
  finishHtmlArtifactAssetInstall,
  rollbackHtmlArtifactAssetInstall,
  stageHtmlArtifactAssets,
} from '../../htmlArtifactAssets.js'
import {
  deleteArtifactSourceSnapshot,
  writeArtifactSourceSnapshot,
} from '../../artifactSourceStore.js'
import {
  discardInvalidGeneratedArtifactFile,
  validateGeneratedArtifactFile,
} from '../../generatedArtifactFormatValidation.js'
import fs from 'node:fs'
import {
  getArtifactDir,
} from '../../artifactGen.js'
import {
  getDb,
} from '../../../db.js'
import {
  parseMarkdownDocument,
} from '../../../../src/lib/officeExport/documentExport.js'
import {
  parseMarkdownSlides,
} from '../../../../src/lib/presentationExport/presentationParser.js'
import {
  parseSpreadsheetRows,
} from '../../../../src/lib/officeExport/spreadsheetExport.js'
import path from 'node:path'
import {
  syncGeneratedArtifactToOutputDirectory,
} from '../../generatedArtifactDelivery.js'
import {
  requestedArtifactOutputDirective,
} from './htmlArtifactInput.js'
import {
  markSideEffectOutcomeKnownFailed,
} from '../sideEffectExecution.js'

export function artifactDeliveryError(expectedTools) {
  const names = [...expectedTools].join(', ')
  const error = new Error(`The user expected artifact type(s) from ${names}, but the current tool calls did not produce them. Decide whether to continue the requested work or explain what is already complete.`)
  error.code = 'ARTIFACT_NOT_CREATED'
  error.retryable = false
  return error
}

export function persistGeneratedArtifact({ artifact, args, job, step }) {
  const common = {
    id: artifact.id,
    userId: job.userId,
    type: artifact.type,
    title: artifact.title || args.title,
    url: artifact.url,
    filename: artifact.filename,
  }
  return job?.origin === 'chat'
    ? appendTurnArtifact({ ...common, sessionId: job.sessionId, turnId: job.id })
    : appendJobArtifact({ ...common, jobId: job.id, stepId: step?.id || null })
}

export const GENERATED_ARTIFACT_TYPE = Object.freeze({
  generate_image: 'image',
  render_pdf_pages: 'image',
  create_pptx: 'pptx',
  create_docx: 'docx',
  create_xlsx: 'xlsx',
  create_pdf: 'pdf',
  create_html_app: 'html',
})

export function artifactReplacementError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

export function isInsideDirectory(filePath, directoryPath) {
  return filePath === directoryPath || filePath.startsWith(directoryPath + path.sep)
}

async function publishNewGeneratedArtifact({ name, artifact, args, job, step }) {
  let assetStage = null
  let assetTransaction = null
  try {
    if (name === 'create_html_app') {
      assetStage = await stageHtmlArtifactAssets({
        artifactDirectory: getArtifactDir(),
        artifactId: artifact.id,
        parentFilename: artifact.filename,
        requiredAssetIds: args?._htmlAssetIds || [],
        sources: args?._htmlAssetSources || [],
      })
      assetTransaction = beginHtmlArtifactAssetInstall(assetStage)
    }
    writeArtifactSourceSnapshot({ artifactId: artifact.id, toolName: name, args })
    persistGeneratedArtifact({ artifact, args, job, step })
    finishHtmlArtifactAssetInstall(assetTransaction)
    return artifact
  } catch (error) {
    rollbackHtmlArtifactAssetInstall(assetTransaction)
    discardStagedHtmlArtifactAssets(assetStage)
    deleteArtifactSourceSnapshot(artifact.id)
    discardInvalidGeneratedArtifactFile({
      filePath: artifact?.fullPath,
      artifactDirectory: getArtifactDir(),
    })
    throw error
  }
}

/**
 * Publish a generated artifact, or replace one explicitly authorized managed
 * artifact in place. The original database identity and filename remain
 * stable so existing chat cards continue to point at the revised file.
 */
export async function publishGeneratedArtifact({ name, artifact, args, job, step }) {
  if (name !== 'create_html_app') {
    try {
      await validateGeneratedArtifactFile({
        filePath: artifact?.fullPath,
        filename: artifact?.filename,
        artifactType: artifact?.type,
        toolName: name,
      })
    } catch (error) {
      discardInvalidGeneratedArtifactFile({
        filePath: artifact?.fullPath,
        artifactDirectory: getArtifactDir(),
      })
      throw error
    }
  }
  const replacementId = String(args?.replace_artifact_id || '').trim()
  if (!replacementId) return publishNewGeneratedArtifact({ name, artifact, args, job, step })
  if (job?.origin !== 'chat' || !job?.userId || !job?.sessionId) {
    throw artifactReplacementError(
      'artifact_replacement_scope_unavailable',
      'In-place artifact replacement is available only for an owned chat artifact.',
    )
  }
  const target = getTurnArtifactById({
    id: replacementId,
    userId: job.userId,
    sessionId: job.sessionId,
  })
  if (!target) {
    throw artifactReplacementError(
      'artifact_replacement_not_found',
      'The requested replacement artifact does not exist in this user and session scope.',
    )
  }
  const expectedType = GENERATED_ARTIFACT_TYPE[name]
  if (!expectedType || String(target.type || '').toLowerCase() !== expectedType) {
    throw artifactReplacementError(
      'artifact_replacement_type_mismatch',
      `Cannot replace a ${target.type || 'different'} artifact with ${name}.`,
    )
  }

  const artifactDirectory = fs.realpathSync(getArtifactDir())
  const sourcePath = fs.realpathSync(artifact.fullPath || path.join(artifactDirectory, artifact.filename))
  const targetPath = fs.realpathSync(path.join(artifactDirectory, target.filename))
  if (!isInsideDirectory(sourcePath, artifactDirectory)
    || !isInsideDirectory(targetPath, artifactDirectory)) {
    throw artifactReplacementError(
      'artifact_replacement_path_invalid',
      'Artifact replacement paths must stay inside the managed artifact directory.',
    )
  }
  if (path.extname(sourcePath).toLowerCase() !== path.extname(targetPath).toLowerCase()) {
    throw artifactReplacementError(
      'artifact_replacement_format_mismatch',
      'The revised artifact format must match the original managed file.',
    )
  }

  const backupPath = `${targetPath}.replace-${artifact.id}.bak`
  let assetStage = null
  let assetTransaction = null
  try {
    if (name === 'create_html_app') {
      assetStage = await stageHtmlArtifactAssets({
        artifactDirectory: artifactDirectory,
        artifactId: target.id,
        parentFilename: target.filename,
        requiredAssetIds: args?._htmlAssetIds || [],
        sources: args?._htmlAssetSources || [],
        existingArtifactId: target.id,
      })
    }
    fs.renameSync(targetPath, backupPath)
    try {
      fs.renameSync(sourcePath, targetPath)
    } catch (error) {
      fs.renameSync(backupPath, targetPath)
      throw error
    }
    assetTransaction = beginHtmlArtifactAssetInstall(assetStage)
    fs.rmSync(backupPath, { force: true })
    finishHtmlArtifactAssetInstall(assetTransaction)
    try {
      writeArtifactSourceSnapshot({ artifactId: target.id, toolName: name, args })
    } catch {
      // The artifact replacement itself is already committed. Never report it
      // as failed and invite a duplicate retry; remove any stale source so a
      // legacy HTML artifact falls back to its current file contents.
      deleteArtifactSourceSnapshot(target.id)
    }
  } catch (error) {
    rollbackHtmlArtifactAssetInstall(assetTransaction)
    discardStagedHtmlArtifactAssets(assetStage)
    try {
      if (!fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetPath)
      } else if (fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
        fs.rmSync(targetPath, { force: true })
        fs.renameSync(backupPath, targetPath)
      }
    } catch { /* best-effort rollback; original backup remains managed */ }
    try { if (fs.existsSync(sourcePath)) fs.rmSync(sourcePath, { force: true }) } catch { /* generated temp cleanup */ }
    throw artifactReplacementError(
      'artifact_replacement_failed',
      error?.message || 'Failed to replace the managed artifact.',
    )
  }

  return {
    ...artifact,
    id: target.id,
    filename: target.filename,
    url: target.url,
    type: target.type,
    title: target.title || artifact.title,
    fullPath: targetPath,
    replaced: true,
    replacedArtifactId: target.id,
  }
}

export function pptxSlidesFromArtifactArgs(args = {}) {
  if (Array.isArray(args.slides) && args.slides.length > 0) return args.slides
  const parsed = parseMarkdownSlides(String(args.markdown || ''))
  return parsed.map((slide) => ({
    ...slide,
    ...(slide.layout ? {} : slide.type === 'cover' ? { layout: 'cover' } : {}),
  }))
}

export function docxParagraphsFromArtifactArgs(args = {}) {
  if (Array.isArray(args.paragraphs) && args.paragraphs.length > 0) return args.paragraphs
  const parsed = parseMarkdownDocument(String(args.markdown || ''))
  return parsed.blocks
    .filter((block, index) => !(index === 0 && block.type === 'title' && block.text === parsed.title))
    .map((block) => ({
      text: block.text,
      ...(block.type === 'title' ? { heading: 1 } : block.type === 'heading' ? { heading: 2 } : {}),
    }))
}

export function xlsxSheetsFromArtifactArgs(args = {}) {
  if (Array.isArray(args.sheets) && args.sheets.length > 0) return args.sheets
  if (Array.isArray(args.rows) && args.rows.length > 0) return [{ name: 'Sheet1', rows: args.rows }]
  const rows = parseSpreadsheetRows(String(args.markdown || ''))
  return rows.length > 0 ? [{ name: 'Sheet1', rows }] : []
}

export function pdfBlocksFromArtifactArgs(args = {}) {
  if (Array.isArray(args.blocks) && args.blocks.length > 0) return args.blocks
  return parseMarkdownDocument(String(args.markdown || '')).blocks
}

export function publishedArtifactResult({
  name,
  artifact,
  args,
  job,
  extra = {},
  requiresLocalArtifactDelivery = false,
}) {
  const result = {
    ok: true,
    artifactId: artifact.id,
    filename: artifact.filename,
    url: artifact.url,
    replaced: artifact.replaced === true,
    ...extra,
  }
  try {
    // The latest user instruction is authoritative. A model can accidentally
    // echo the configured default directory into output_directory even when
    // the same turn explicitly says "write to E drive". Resolve that
    // deterministic destination first so model arguments cannot reverse the
    // documented explicit-path > default-directory priority.
    const requestedOutput = requestedArtifactOutputDirective(
      job?.userPrompt || job?.prompt || '',
    )
    return {
      ...result,
      ...syncGeneratedArtifactToOutputDirectory({
        artifact,
        args,
        toolName: name,
        userId: job?.userId,
        outputDirectory: String(
          requestedOutput.hasDirective
            ? requestedOutput.directory
            : args?.output_directory || args?._outputDirectory || '',
        ).trim(),
      }),
      deliveryStatus: 'delivered',
    }
  } catch (error) {
    const deliveryError = {
      code: error?.code || 'ARTIFACT_DEFAULT_DELIVERY_FAILED',
      message: error?.message || String(error),
    }
    // A managed preview is a valid fallback only when the caller's
    // server-owned delivery contract did not require a local file. Default
    // output, exact-path, and in-place revision turns must never turn a failed
    // disk write into a semantic success.
    return {
      ...result,
      ...(requiresLocalArtifactDelivery
        ? {
            ok: false,
            code: deliveryError.code,
            error: deliveryError.message,
            retryable: false,
          }
        : {}),
      deliveryStatus: 'managed_only',
      deliveryError,
      warning: 'The managed artifact was created, but its default-directory copy could not be written.',
    }
  }
}

export function cleanupGeneratedArtifactBatch({ artifacts = [], deliveries = [] } = {}) {
  let cleanupComplete = true
  for (const delivery of deliveries) {
    const deliveryPath = String(delivery?.path || delivery?.localPath || '').trim()
    if (!deliveryPath || !path.isAbsolute(deliveryPath)) continue
    try {
      fs.rmSync(deliveryPath, { force: true })
      if (fs.existsSync(deliveryPath)) cleanupComplete = false
    } catch {
      cleanupComplete = false
    }
  }
  for (const artifact of artifacts) {
    try {
      deleteArtifactSourceSnapshot(artifact?.id)
    } catch {
      cleanupComplete = false
    }
    const filePath = String(artifact?.fullPath || '').trim()
    const removed = discardInvalidGeneratedArtifactFile({
      filePath,
      artifactDirectory: getArtifactDir(),
    })
    if (filePath && !removed && fs.existsSync(filePath)) cleanupComplete = false
  }
  return cleanupComplete
}

/**
 * Publish a multi-file result as one observable unit. All files are validated
 * before the first database row or default-directory copy is created. The DB
 * transaction and explicit filesystem rollback prevent a later-page failure
 * from leaking an earlier page as a deliverable.
 */
export async function publishGeneratedArtifactBatch({ name, entries, job, step, requiresLocalArtifactDelivery }) {
  const batch = Array.isArray(entries) ? entries : []
  const artifacts = batch.map((entry) => entry.artifact)
  const deliveries = []
  try {
    for (const { artifact } of batch) {
      await validateGeneratedArtifactFile({
        filePath: artifact?.fullPath,
        filename: artifact?.filename,
        artifactType: artifact?.type,
        toolName: name,
      })
    }
    getDb().transaction(() => {
      for (const { artifact, args, extra } of batch) {
        writeArtifactSourceSnapshot({ artifactId: artifact.id, toolName: name, args })
        persistGeneratedArtifact({ artifact, args, job, step })
        const delivery = publishedArtifactResult({
          name,
          artifact,
          args,
          job,
          requiresLocalArtifactDelivery,
          extra,
        })
        deliveries.push(delivery)
        if (delivery.ok !== true) {
          const error = new Error(delivery.error || 'The generated artifact batch could not be delivered.')
          error.code = delivery.code || 'ARTIFACT_BATCH_DELIVERY_FAILED'
          error.retryable = delivery.retryable !== false
          throw error
        }
      }
    })()
    return deliveries
  } catch (error) {
    const cleanupComplete = cleanupGeneratedArtifactBatch({ artifacts, deliveries })
    throw cleanupComplete
      ? markSideEffectOutcomeKnownFailed(error, {
          code: error?.code,
          retryable: error?.retryable === true,
        })
      : error
  }
}
