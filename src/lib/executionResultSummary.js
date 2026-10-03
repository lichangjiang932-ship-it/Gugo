import { parseToolArgs } from './toolCallPresentation.js'
import { normalizeVerifiedLocalFilePath } from './verifiedLocalFileIdentity.js'

const FILE_MUTATIONS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'patch_file'])

function changedTargets(call, args, result) {
  const paths = [
    result.path,
    ...(Array.isArray(result.files) ? result.files : []),
    ...(Array.isArray(result.changes) ? result.changes.map((change) => change?.path) : []),
  ].filter((path) => typeof path === 'string' && path.trim())
  if (paths.length) return paths
  // Successful single-file calls have an unambiguous target even in old snapshots.
  // Never infer patch effects from proposed patch text or shell command output.
  return ['write_file', 'edit_file', 'patch_file'].includes(call.name) ? [args.path] : []
}

export function executionResultSummary(toolCalls, t) {
  const files = new Set()
  const failures = new Set()
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  calls.forEach((call, index) => {
    if (!call || typeof call !== 'object') return
    if (call.status === 'error') failures.add(call.id || index)
    if (call.status !== 'success' || call.error || !FILE_MUTATIONS.has(call.name)) return
    const args = parseToolArgs(call.arguments)
    const envelope = parseToolArgs(call.result)
    const result = typeof envelope.content === 'string'
      ? { ...envelope, ...parseToolArgs(envelope.content) }
      : envelope
    if (envelope.ok === false || result.ok === false || result.error || result.isError
      || args.dry_run === true || args.dryRun === true
      || result.dry_run === true || result.dryRun === true) return
    for (const target of changedTargets(call, args, result)) {
      if (typeof target !== 'string' || !target.trim()) continue
      const path = target.trim()
      files.add(normalizeVerifiedLocalFilePath(path) || path.replace(/\\/g, '/').replace(/^(\.\/)+/, ''))
    }
  })
  return [
    files.size > 0 ? t(files.size === 1 ? 'chatMessages.executionChangedFile' : 'chatMessages.executionChangedFiles', { count: files.size }) : '',
    failures.size > 0 ? t('chatMessages.executionFailedTools', { count: failures.size }) : '',
  ].filter(Boolean).join(' · ')
}
