import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  checkShellPathSyntax,
  extractAbsoluteShellPaths,
} from '../utils/bashGuard.js'
import { resolveAuthorizedLocalPath } from '../services/localFileAccessService.js'
import { SHELL_MAX_EXPECTED_OUTPUTS, badReq } from './fsShellSupport.js'

function outputEntryType(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

function hashFileContent(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(fullPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function hashDirectoryTree(rootPath) {
  const treeHash = createHash('sha256')

  async function visit(fullPath, relativePath) {
    const stat = await fs.promises.lstat(fullPath)
    const type = outputEntryType(stat)
    treeHash.update(JSON.stringify([
      relativePath.split(path.sep).join('/'),
      type,
      stat.size,
      stat.mtimeMs,
    ]))
    treeHash.update('\0')

    if (type === 'directory') {
      const entries = await fs.promises.readdir(fullPath)
      entries.sort((left, right) => left.localeCompare(right))
      for (const entry of entries) {
        await visit(path.join(fullPath, entry), path.join(relativePath, entry))
      }
      return
    }
    if (type === 'file') {
      treeHash.update(await hashFileContent(fullPath))
      treeHash.update('\0')
      return
    }
    if (type === 'symlink') {
      treeHash.update(await fs.promises.readlink(fullPath))
      treeHash.update('\0')
    }
  }

  await visit(rootPath, '')
  return treeHash.digest('hex')
}

async function snapshotExpectedOutput(fullPath) {
  let stat
  try {
    stat = await fs.promises.lstat(fullPath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false }
    throw error
  }

  const type = outputEntryType(stat)
  let contentHash = null
  if (type === 'file') contentHash = await hashFileContent(fullPath)
  else if (type === 'directory') contentHash = await hashDirectoryTree(fullPath)
  else if (type === 'symlink') contentHash = createHash('sha256')
    .update(await fs.promises.readlink(fullPath))
    .digest('hex')

  return {
    exists: true,
    type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash,
  }
}

export async function prepareExpectedOutputs(rawOutputs, { cwd, userId }) {
  if (rawOutputs == null) return []
  if (!Array.isArray(rawOutputs)) throw badReq('expected_outputs 必须是路径数组')
  if (rawOutputs.length > SHELL_MAX_EXPECTED_OUTPUTS) {
    throw badReq(`expected_outputs 最多 ${SHELL_MAX_EXPECTED_OUTPUTS} 项`, 413)
  }

  const targets = []
  const seen = new Set()
  for (const rawOutput of rawOutputs) {
    if (typeof rawOutput !== 'string' || !rawOutput.trim()) {
      throw badReq('expected_outputs 中的每一项都必须是非空路径')
    }
    const declaredPath = rawOutput.trim()
    const requestedPath = path.isAbsolute(declaredPath)
      ? declaredPath
      : path.resolve(cwd, declaredPath)
    const resolved = resolveAuthorizedLocalPath({
      userId,
      rawPath: requestedPath,
      write: true,
      allowMissing: true,
      allowWorkspace: true,
    })
    const dedupeKey = process.platform === 'win32'
      ? path.normalize(resolved.fullPath).toLowerCase()
      : path.normalize(resolved.fullPath)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    let before
    try {
      before = await snapshotExpectedOutput(resolved.fullPath)
    } catch (error) {
      const wrapped = badReq(`无法在命令执行前读取 expected_outputs: ${declaredPath}`)
      wrapped.code = 'EXPECTED_OUTPUT_SNAPSHOT_FAILED'
      wrapped.cause = error
      throw wrapped
    }
    targets.push({
      declaredPath,
      fullPath: resolved.fullPath,
      path: resolved.displayPath,
      scope: resolved.source,
      before,
    })
  }
  return targets
}

function changedOutputRecord(target, after, status) {
  const before = target.before
  return {
    path: target.path,
    declaredPath: target.declaredPath,
    scope: target.scope,
    status,
    type: after.type,
    size: after.size,
    modifiedAt: after.mtimeMs,
    contentChanged: before.exists && before.contentHash !== after.contentHash,
    sizeChanged: before.exists && before.size !== after.size,
    mtimeChanged: before.exists && before.mtimeMs !== after.mtimeMs,
    typeChanged: before.exists && before.type !== after.type,
  }
}

export async function verifyExpectedOutputs(targets) {
  const verifiedOutputs = []
  const unverifiedOutputs = []

  for (const target of targets) {
    let after
    try {
      after = await snapshotExpectedOutput(target.fullPath)
    } catch (error) {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'inaccessible',
        error: error?.message || String(error),
      })
      continue
    }

    if (!after.exists) {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'missing',
        existedBefore: target.before.exists,
      })
      continue
    }
    if (!target.before.exists) {
      verifiedOutputs.push(changedOutputRecord(target, after, 'created'))
      continue
    }

    const changed = target.before.type !== after.type
      || target.before.size !== after.size
      || target.before.mtimeMs !== after.mtimeMs
      || target.before.contentHash !== after.contentHash
    if (changed) {
      verifiedOutputs.push(changedOutputRecord(
        target,
        after,
        target.before.type === after.type ? 'modified' : 'replaced',
      ))
    } else {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'unchanged',
        existedBefore: true,
        type: after.type,
        size: after.size,
        modifiedAt: after.mtimeMs,
      })
    }
  }

  return {
    verifiedOutputs,
    unverifiedOutputs,
    changedPaths: verifiedOutputs.map((output) => output.path),
  }
}

function sameOrInside(rootPath, candidatePath) {
  const root = path.normalize(rootPath)
  const candidate = path.normalize(candidatePath)
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function assertShellCommandPathsAuthorized(command, { userId, expectedTargets }) {
  const pathSyntax = checkShellPathSyntax(command)
  if (pathSyntax) {
    const error = badReq(
      `命令路径被安全策略拦截：${pathSyntax.reason}`,
      pathSyntax.statusCode || 403,
    )
    error.code = pathSyntax.code || 'SHELL_PATH_POLICY_DENIED'
    if (pathSyntax.path) error.path = pathSyntax.path
    if (pathSyntax.hint) error.hint = pathSyntax.hint
    throw error
  }

  for (const rawPath of extractAbsoluteShellPaths(command)) {
    const absolutePath = path.resolve(rawPath)
    const declaredOutput = expectedTargets.some((target) => sameOrInside(target.fullPath, absolutePath))
    try {
      resolveAuthorizedLocalPath({
        userId,
        rawPath: absolutePath,
        write: declaredOutput,
        allowMissing: declaredOutput,
        allowWorkspace: true,
        allowAllFiles: false,
      })
    } catch (cause) {
      const error = badReq(`命令引用了未授权路径：${rawPath}`, 403)
      error.code = 'SHELL_PATH_NOT_AUTHORIZED'
      error.path = rawPath
      error.requiredAccessMode = declaredOutput ? 'read_write' : 'read_only'
      error.cause = cause
      throw error
    }
  }
}
