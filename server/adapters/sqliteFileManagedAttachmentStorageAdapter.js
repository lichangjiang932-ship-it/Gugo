import crypto from 'node:crypto'
import fs from 'node:fs'

import { MANAGED_ATTACHMENT_STORAGE_PORT_VERSION } from '../core/managedAttachmentStoragePort.js'
import {
  projectManagedAttachmentDto,
  projectManagedAttachmentList,
} from '../core/managedAttachmentDtos.js'
import {
  cleanupManagedAttachments,
  createManagedAttachment,
  deleteManagedAttachment,
  deleteManagedAttachmentsForSession,
  getManagedAttachment,
  listManagedAttachments,
} from '../services/managedAttachmentStore.js'

export const SQLITE_FILE_MANAGED_ATTACHMENT_STORAGE_ADAPTER_ID = 'builtin.sqlite-file-managed-attachment-storage'

function attachmentError(message, statusCode, code, cause) {
  return Object.assign(new Error(message, { cause }), { statusCode, code })
}

async function hashStoredContent(descriptor, size) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(size, 1024 * 1024))
  let position = 0
  while (position < size) {
    const length = Math.min(buffer.length, size - position)
    const bytesRead = await new Promise((resolve, reject) => {
      fs.read(descriptor, buffer, 0, length, position, (error, count) => {
        if (error) reject(error)
        else resolve(count)
      })
    })
    if (bytesRead === 0) {
      throw attachmentError(
        '附件内容与存储记录不一致',
        410,
        'ATTACHMENT_CONTENT_CHANGED',
      )
    }
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

function sameOpenedFile(before, after) {
  return before.isFile()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
}

async function openStoredContent(attachment, range) {
  let descriptor
  try {
    descriptor = fs.openSync(attachment.fullPath, 'r')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    throw attachmentError('附件内容不存在', 410, 'ATTACHMENT_CONTENT_MISSING', error)
  }
  try {
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.size !== attachment.size) {
      throw attachmentError(
        '附件内容与存储记录不一致',
        410,
        'ATTACHMENT_CONTENT_CHANGED',
      )
    }
    const digest = await hashStoredContent(descriptor, before.size)
    const after = fs.fstatSync(descriptor)
    if (!sameOpenedFile(before, after) || digest !== attachment.sha256) {
      throw attachmentError(
        '附件内容与存储记录不一致',
        410,
        'ATTACHMENT_CONTENT_CHANGED',
      )
    }
    // The descriptor is authoritative; an empty path prevents the ReadStream
    // capability from carrying a host filesystem path across the port.
    return fs.createReadStream('', {
      ...(range || {}),
      fd: descriptor,
      autoClose: true,
    })
  } catch (error) {
    try { fs.closeSync(descriptor) } catch { /* best effort after stream construction failure */ }
    throw error
  }
}

export function createSqliteFileManagedAttachmentStorageAdapter({
  getEnv = () => process.env,
} = {}) {
  if (typeof getEnv !== 'function') throw new TypeError('getEnv must be a function')
  const env = () => ({ ...process.env, ...(getEnv() || {}) })

  return Object.freeze({
    apiVersion: MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
    id: SQLITE_FILE_MANAGED_ATTACHMENT_STORAGE_ADAPTER_ID,

    async create(input) {
      const attachment = await createManagedAttachment({ ...input, env: env() })
      return projectManagedAttachmentDto(attachment)
    },

    list(input) {
      return projectManagedAttachmentList(listManagedAttachments(input))
    },

    get(input) {
      return projectManagedAttachmentDto(getManagedAttachment({ ...input, env: env() }))
    },

    delete(input) {
      return deleteManagedAttachment({ ...input, env: env() })
    },

    deleteForSession(input) {
      return deleteManagedAttachmentsForSession({ ...input, env: env() })
    },

    cleanup(input) {
      return cleanupManagedAttachments({ ...input, env: env() })
    },

    async openContent(input) {
      const attachment = getManagedAttachment({ ...input, env: env() })
      if (!attachment) {
        throw attachmentError('附件不存在或无权访问', 404, 'ATTACHMENT_NOT_FOUND')
      }
      if (input.expected
        && (attachment.size !== input.expected.size
          || attachment.sha256 !== input.expected.sha256)) {
        throw attachmentError(
          '附件内容在读取前发生变化，请重试',
          409,
          'ATTACHMENT_CONTENT_CHANGED',
        )
      }
      return {
        attachment: projectManagedAttachmentDto(attachment),
        stream: await openStoredContent(attachment, input.range),
      }
    },
  })
}
