import path from 'node:path'
import { collectAttachmentRequests, MAX_ATTACHMENTS } from './cliAttachments.js'
import { CliUsageError } from './errors.js'

const safe = (value) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')

function selectedPath(value, cwd) {
  const text = String(value || '').trim()
  const unquoted = text.length > 1 && ['"', "'"].includes(text[0]) && text.at(-1) === text[0] ? text.slice(1, -1) : text
  if (!unquoted) throw new CliUsageError('CLI_ATTACHMENT_PATH_REQUIRED', '/attach requires a file path')
  return path.resolve(cwd || process.cwd(), unquoted)
}

export function createAttachmentQueue({ files = [], images = [], cwd } = {}) {
  let pending = collectAttachmentRequests({ files, images }).map((request) => ({ ...request, path: selectedPath(request.path, cwd) }))
  return {
    list: () => pending.map((request) => ({ ...request })),
    clear() { pending = [] },
    take() { const taken = pending; pending = []; return taken },
    handle(command, { cwd: currentCwd, stdout }) {
      if (command.name === '/attach') {
        if (pending.length >= MAX_ATTACHMENTS) throw new CliUsageError('CLI_TOO_MANY_ATTACHMENTS', 'at most 8 attachments per turn')
        pending.push({ path: selectedPath(command.args, currentCwd), kind: 'auto' })
        stdout.write(`Attachment queued for the next turn: ${safe(pending.at(-1).path)}\n`)
      } else if (command.name === '/detach') {
        if (command.args === 'all') pending = []
        else {
          const index = /^\d+$/u.test(command.args) ? Number(command.args) : 0
          if (!Number.isSafeInteger(index) || index < 1 || index > pending.length) {
            throw new CliUsageError('CLI_ATTACHMENT_INDEX_INVALID', '/detach requires an index from /attachments, or all')
          }
          pending.splice(index - 1, 1)
        }
        stdout.write('Pending attachment removed; no original file was deleted.\n')
      } else if (command.name === '/attachments') {
        stdout.write(pending.length ? pending.map((request, index) => `${index + 1}. ${safe(request.path)}`).join('\n') + '\n' : 'No pending attachments.\n')
      } else return false
      return true
    },
  }
}
