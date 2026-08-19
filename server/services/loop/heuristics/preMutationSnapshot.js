import fs from 'node:fs'
import {
  recordFileSnapshot,
} from '../../fileSnapshotStore.js'
import {
  resolveForFileTool,
} from '../../../adapters/fsShellTools.js'

export const SNAPSHOT_TOOL_NAMES = new Set(['write_file', 'edit_file'])

/**
 * Record a before-image for the most common file-mutating tools so a turn can
 * be rewound after the model edits the wrong file. Best-effort: snapshot
 * failures never block the real mutation.
 */
export async function recordPreMutationSnapshot({ name, args, job, toolCallId }) {
  if (!job?.sessionId || !job?.id || !toolCallId || !SNAPSHOT_TOOL_NAMES.has(name)) return
  const rawPath = String(args?.path || '').trim()
  if (!rawPath) return
  let resolved
  try {
    resolved = resolveForFileTool(rawPath, { userId: job.userId, write: true, allowMissing: true })
  } catch {
    return
  }
  let beforeContent = null
  try {
    if (fs.existsSync(resolved.fullPath) && fs.statSync(resolved.fullPath).isFile()) {
      beforeContent = fs.readFileSync(resolved.fullPath)
    }
  } catch {
    return
  }
  try {
    recordFileSnapshot({
      userId: job.userId,
      sessionId: job.sessionId,
      turnId: job.id,
      toolCallId,
      toolName: name,
      filePath: resolved.fullPath,
      beforeContent,
    })
  } catch { /* snapshot is best-effort */ }
}
