import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACT_DIR, isSafeArtifactFilename } from './artifactStorage.js'
import { listTurnEvents } from './turnEventStore.js'
import { getTurnArtifactByIdInTurn } from './turnArtifactStore.js'

const issuedEvidence = new WeakMap()
const COMMAND_TOOLS = new Set(['bash_exec', 'run_command'])
const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'image'])
const PAGE_SIZE = 2000
const MAX_EVENT_PAGES = 50
const MAX_PROJECTION_HASH_BYTES = 128 * 1024 * 1024

function canonicalPath(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && path.isAbsolute(left) && path.isAbsolute(right) && canonicalPath(left) === canonicalPath(right)
}

function completeScope(scope) {
  return ['userId', 'sessionId', 'turnId'].every((key) => (
    typeof scope?.[key] === 'string' && scope[key].trim() === scope[key] && scope[key].length > 0
  ))
}

function completionProjectionRecord(payload) {
  const result = payload?.result
  if (!result || !Array.isArray(result.artifactValidation?.receipts)
    || result.artifactValidation.receipts.length > 64 || !Array.isArray(result.artifacts)
    || result.artifacts.length > 64) return null
  return { name: payload.name, result: {
    ok: result.ok, cwd: result.cwd, code: result.code, unsafeToReplay: result.unsafeToReplay,
    artifactValidation: result.artifactValidation,
    artifactPublication: result.artifactPublication ? { ok: result.artifactPublication.ok } : null,
    artifacts: result.artifacts, changedPaths: result.changedPaths,
  } }
}

function readCanonicalCompletions(scope) {
  const completed = new Map()
  let after = -1
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const events = listTurnEvents({ ...scope, after, limit: PAGE_SIZE })
    if (!Array.isArray(events)) return new Map()
    for (const event of events) {
      if (event.sessionId !== scope.sessionId || event.turnId !== scope.turnId
        || !Number.isSafeInteger(event.sequence) || event.sequence <= after) return new Map()
      if (event.type !== 'tool.completed' || !COMMAND_TOOLS.has(event.payload?.name)) continue
      const callId = event.payload?.toolCallId
      if (typeof callId !== 'string' || !callId) continue
      // Ambiguous repeated identities are not a source of upgraded evidence.
      completed.set(callId, completed.has(callId) ? null : completionProjectionRecord(event.payload))
    }
    if (events.length < PAGE_SIZE) return completed
    const next = events.at(-1)?.sequence
    if (!Number.isSafeInteger(next) || next <= after) return new Map()
    after = next
  }
  return new Map()
}

function sameSnapshot(left, right) {
  return left?.ino > 0n && left.ino === right?.ino && left.dev === right.dev
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function stableFileHash(filePath, byteLength) {
  let fd = null
  try {
    const before = fs.lstatSync(filePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(byteLength)) return null
    fd = fs.openSync(filePath, 'r')
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!sameSnapshot(before, opened)) return null
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, byteLength))
    let offset = 0
    while (offset < byteLength) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, byteLength - offset), offset)
      if (read <= 0) return null
      hash.update(chunk.subarray(0, read))
      offset += read
    }
    const after = fs.fstatSync(fd, { bigint: true })
    const finalPath = fs.lstatSync(filePath, { bigint: true })
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, finalPath) || finalPath.isSymbolicLink()) return null
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* read-only descriptor cleanup */ }
  }
}

function receiptMatchesScope(receipt, scope, callId) {
  if (!receipt || receipt.verified !== true || receipt.verifier !== 'bounded_structure_parser'
    || receipt.verifierVersion !== 1 || !FORMATS.has(receipt.format)
    || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0
    || !/^[a-f0-9]{64}$/u.test(String(receipt.sha256 || ''))
    || !Number.isSafeInteger(receipt.candidateIndex) || receipt.candidateIndex < 0
    || receipt.toolCallId !== callId
    || ['userId', 'sessionId', 'turnId'].some((key) => receipt[key] !== scope[key])) return false
  const publicationKey = JSON.stringify(['local-tool-artifact-v1', scope.userId, 'turn',
    scope.sessionId, scope.turnId, callId, receipt.candidateIndex])
  const digest = createHash('sha256').update(publicationKey).digest('hex')
  return receipt.artifactId === `local-${digest}`
    && (!receipt.jobId || receipt.jobId === scope.turnId)
    && (!receipt.stepId || receipt.stepId === scope.turnId)
}

function registeredArtifact(receipt, scope, result) {
  const artifact = getTurnArtifactByIdInTurn({ ...scope, id: receipt.artifactId })
  if (!artifact || ['userId', 'sessionId', 'turnId'].some((key) => artifact[key] !== scope[key])
    || artifact.id !== receipt.artifactId || artifact.filename !== receipt.filename
    || !isSafeArtifactFilename(artifact.filename)) return null
  const published = result.artifacts?.find((value) => value?.id === artifact.id)
  if (!published || ['filename', 'type', 'url'].some((key) => published[key] !== artifact[key])
    || artifact.url !== `/api/artifacts/${encodeURIComponent(artifact.filename)}`) return null
  const extension = path.extname(artifact.filename).slice(1).toLowerCase()
  const format = ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? 'image' : extension
  if (format !== receipt.format || ![format, extension].includes(artifact.type)) return null
  const managedPath = path.join(ARTIFACT_DIR, artifact.filename)
  return samePath(receipt.artifactPath, managedPath) ? { artifact, managedPath } : null
}

function declaredPathMatches(rawPath, sourcePath, cwd) {
  if (rawPath === null || rawPath === undefined || rawPath === '') return true
  if (typeof rawPath !== 'string' || rawPath !== rawPath.trim()) return false
  if (path.isAbsolute(rawPath)) return samePath(rawPath, sourcePath)
  return typeof cwd === 'string' && path.isAbsolute(cwd) && samePath(path.resolve(cwd, rawPath), sourcePath)
}

/**
 * Mint an opaque, process-local projection capability only for the bundled
 * event/artifact persistence domain. Unknown/custom readers never fall back
 * to global SQLite, and serialized checkpoint/imported trace data cannot mint
 * this capability. This does not change completion or file-access authority.
 */
export function createTurnBinaryArtifactEvidence({ scope, replayEvents } = {}) {
  if (replayEvents !== listTurnEvents || !completeScope(scope)) return null
  const evidence = Object.freeze({})
  issuedEvidence.set(evidence, { scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId },
    completions: null, remainingHashBytes: MAX_PROJECTION_HASH_BYTES })
  return evidence
}

/** Only canonical host records may supply candidates lost from a compacted trace. */
export function listTurnBinaryArtifactCandidates(evidence, { userId } = {}) {
  const trusted = evidence && typeof evidence === 'object' ? issuedEvidence.get(evidence) : null
  if (!trusted || trusted.scope.userId !== userId) return []
  try {
    trusted.completions ??= readCanonicalCompletions(trusted.scope)
    const candidates = []
    for (const [toolCallId, completed] of trusted.completions) {
      if (!completed || completed.result.ok !== true) continue
      for (const receipt of completed.result.artifactValidation.receipts) {
        if (!receiptMatchesScope(receipt, trusted.scope, toolCallId)) continue
        candidates.push({ toolCallId, toolName: completed.name, sourcePath: receipt.sourcePath })
        if (candidates.length > 64) candidates.shift()
      }
    }
    return candidates
  } catch { return [] }
}

export function readTurnBinaryArtifactEvidence(evidence, { userId, toolCallId, toolName, sourcePath } = {}) {
  const trusted = evidence && typeof evidence === 'object' ? issuedEvidence.get(evidence) : null
  if (!trusted || trusted.scope.userId !== userId || !COMMAND_TOOLS.has(toolName)
    || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return null
  try {
    trusted.completions ??= readCanonicalCompletions(trusted.scope)
    const completed = trusted.completions.get(toolCallId)
    const result = completed?.result
    if (completed?.name !== toolName || result?.ok !== true || result?.artifactValidation?.ok !== true
      || result?.artifactPublication?.ok === false || result?.unsafeToReplay === true
      || /OUTCOME_UNKNOWN/u.test(String(result?.code || ''))
      || !Array.isArray(result?.artifactValidation?.receipts)
      || !Array.isArray(result.changedPaths) || !result.changedPaths.some((value) => samePath(value, sourcePath))) return null
    for (const receipt of result.artifactValidation.receipts) {
      if (!receiptMatchesScope(receipt, trusted.scope, toolCallId)
        || !samePath(receipt.sourcePath, sourcePath)
        || !declaredPathMatches(receipt.path, sourcePath, result.cwd)
        || !declaredPathMatches(receipt.declaredPath, sourcePath, result.cwd)) continue
      const registered = registeredArtifact(receipt, trusted.scope, result)
      if (!registered || receipt.byteLength > trusted.remainingHashBytes / 2) continue
      trusted.remainingHashBytes -= receipt.byteLength * 2
      const localHash = stableFileHash(sourcePath, receipt.byteLength)
      const managedHash = stableFileHash(registered.managedPath, receipt.byteLength)
      if (localHash !== receipt.sha256 || managedHash !== receipt.sha256) continue
      return { byteLength: receipt.byteLength, relatedArtifactIds: [registered.artifact.id] }
    }
  } catch { /* Missing, unavailable, or inconsistent evidence stays retained. */ }
  return null
}
