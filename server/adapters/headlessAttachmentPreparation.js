import fs from 'node:fs/promises'
import path from 'node:path'
import { createManagedAttachment, discardUnboundManagedAttachment } from '../services/managedAttachmentStore.js'
import { resolvedMimeType } from '../services/managedAttachmentStoreSupport.js'
import { resolveAgentModelRuntimeBinding } from '../services/modelReadinessService.js'
import { resolveModelConfigForModel } from './modelProviderConfig.js'
import { profileForConfig } from './modelEndpoint.js'

const MAX_FILES = 8
const MAX_BYTES = 10 * 1024 * 1024
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|pdf)$/iu
const fail = (code, message) => Object.assign(new Error(message), { code, exitCode: 2, retryable: false })

function assertActive(signal) {
  if (signal?.aborted) throw signal.reason || fail('CLI_RUN_CANCELLED', 'attachment preparation was cancelled')
}

function sameFile(before, after) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

async function uploadFile(request, input, stage) {
  if (!request || typeof request.path !== 'string' || !request.path.trim() || !['auto', 'image'].includes(request.kind || 'auto')) {
    throw fail('CLI_ATTACHMENT_INVALID', 'attachments require a file path and a supported kind')
  }
  const filePath = path.resolve(input.cwd || process.cwd(), request.path)
  let file
  try { file = await fs.open(filePath, 'r') }
  catch { throw fail('CLI_ATTACHMENT_NOT_FOUND', `attachment could not be opened: ${path.basename(filePath)}`) }
  try {
    const before = await file.stat()
    if (!before.isFile()) throw fail('CLI_ATTACHMENT_NOT_A_FILE', 'attachment must be a regular file')
    if (before.size > MAX_BYTES) throw fail('CLI_ATTACHMENT_TOO_LARGE', 'each CLI attachment must be at most 10 MiB')
    assertActive(input.signal)
    const prefix = Buffer.alloc(Math.min(512, before.size))
    await file.read(prefix, 0, prefix.length, 0)
    const detected = resolvedMimeType('application/octet-stream', prefix, 'unknown')
    if ((request.kind === 'image' || BINARY_EXTENSIONS.test(filePath)) && !/^(?:image\/|application\/pdf$)/u.test(detected)) {
      throw fail('CLI_ATTACHMENT_SIGNATURE_INVALID', 'image/PDF attachment bytes do not match a supported signature')
    }
    if (request.kind === 'image' && !detected.startsWith('image/')) {
      throw fail('CLI_ATTACHMENT_NOT_AN_IMAGE', '--image requires an actual supported image')
    }
    const mimeType = detected === 'application/octet-stream'
      ? resolvedMimeType('application/octet-stream', prefix, path.basename(filePath)) : detected
    const source = file.createReadStream({ start: 0, autoClose: false, signal: input.signal || undefined })
    let attachment
    try {
      attachment = await stage({ userId: input.userId, sessionId: input.sessionId, name: path.basename(filePath),
        mimeType, source, contentLength: before.size, env: input.env })
      input.created.push(attachment)
      if (!sameFile(before, await file.stat())) throw fail('CLI_ATTACHMENT_CHANGED', 'attachment changed while it was read; nothing was submitted')
      assertActive(input.signal)
      return attachment
    } finally { source.destroy() }
  } finally { await file.close() }
}

function attachmentProfile(input) {
  const binding = resolveAgentModelRuntimeBinding({ userId: input.userId, modelName: input.modelName,
    providerId: input.modelProviderId, env: input.env })
  const config = resolveModelConfigForModel({ modelName: binding.modelName, providerId: binding.providerId, env: binding.env })
  return profileForConfig(config, binding.env)
}

/** Exact caller-selected files only; never grant their parent directory to model tools. */
export async function prepareHeadlessAttachments(input, dependencies = {}) {
  const requests = input.requests || []
  if (!Array.isArray(requests) || requests.length > MAX_FILES) throw fail('CLI_TOO_MANY_ATTACHMENTS', 'at most 8 attachments per turn')
  const created = []
  const discard = async () => {
    for (const item of created) {
      await (dependencies.discard || discardUnboundManagedAttachment)({
        userId: input.userId, sessionId: input.sessionId, id: item.id, env: input.env,
      })
    }
  }
  try {
    for (const request of requests) {
      assertActive(input.signal)
      await uploadFile(request, { ...input, created }, dependencies.stage || createManagedAttachment)
    }
    if (created.some((item) => item.mimeType.startsWith('image/') || item.mimeType === 'application/pdf')) {
      const profile = await (dependencies.profile || attachmentProfile)(input)
      if (created.some((item) => item.mimeType.startsWith('image/')) && profile.supportsVision !== true
        || created.some((item) => item.mimeType === 'application/pdf') && profile.supportsPdf !== true) {
        throw fail('CLI_ATTACHMENT_MODEL_UNSUPPORTED', 'the selected model does not support one or more image/PDF attachments')
      }
    }
    assertActive(input.signal)
    return { attachments: created.map((item) => item.id), discard }
  } catch (error) {
    try { await discard() }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], 'attachment preparation and cleanup failed', { cause: error }),
        { code: 'CLI_ATTACHMENT_CLEANUP_FAILED', retryable: false })
    }
    // Node's file stream wraps the supplied abort reason. Only unwrap that
    // exact, causal cancellation here, after cleanup; unrelated I/O errors or
    // cleanup failures must still reach the caller as failures.
    if (input.signal?.aborted && error?.name === 'AbortError' && error.code === 'ABORT_ERR'
      && error.cause === input.signal.reason) throw input.signal.reason
    throw error
  }
}
