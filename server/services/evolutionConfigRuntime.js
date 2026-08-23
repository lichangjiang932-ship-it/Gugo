import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  readRuntimeConfigFile,
  readRuntimeEnvFile,
  resolveRuntimeConfigPaths,
} from '../utils/runtimeEnv.js'
import {
  applyEvolutionConfigPatch,
  configSha256,
  normalizeRuntimeConfigDocument,
  safeEffectiveConfigSnapshot,
} from './evolutionConfigPolicy.js'

const EMPTY_RUNTIME_CONFIG = '{\n  "env": {}\n}\n'

function runtimeError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode })
}

function readOptionalLayer(filePath) {
  return filePath ? readRuntimeConfigFile(filePath) : {}
}

function readRuntimeFileState(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        exists: false,
        content: EMPTY_RUNTIME_CONFIG,
        sha256: configSha256(EMPTY_RUNTIME_CONFIG),
      })
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw runtimeError('EVOLUTION_CONFIG_FILE_INVALID', 'runtime config must be a regular file')
  }
  const content = fs.readFileSync(filePath, 'utf8')
  return Object.freeze({ exists: true, content, sha256: configSha256(content) })
}

function writeDurableFile(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const descriptor = fs.openSync(filePath, 'r+')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function acquireRuntimeConfigLock(filePath) {
  const lockPath = `${filePath}.evolution.lock`
  const token = randomUUID()
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw runtimeError(
        'EVOLUTION_CONFIG_LOCKED',
        'another process is changing the runtime config',
        423,
      )
    }
    throw error
  }
  const ownerPath = path.join(lockPath, 'owner.json')
  try {
    writeDurableFile(ownerPath, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`)
  } catch (error) {
    try { fs.rmdirSync(lockPath) } catch { /* preserve the original error */ }
    throw error
  }
  return Object.freeze({ lockPath, ownerPath, token })
}

function releaseRuntimeConfigLock(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8'))
    if (owner?.token !== lock.token) return
  } catch {
    return
  }
  try { fs.unlinkSync(lock.ownerPath) } catch { return }
  try { fs.rmdirSync(lock.lockPath) } catch { /* a foreign recovery artifact keeps the lock closed */ }
}

function linkNoClobber(sourcePath, targetPath) {
  // A hard link is an atomic create-if-absent operation on both NTFS and POSIX.
  // Unlike rename(), it can never replace a target created by a manual editor.
  fs.linkSync(sourcePath, targetPath)
}

function unlinkBestEffort(filePath) {
  try { fs.unlinkSync(filePath) } catch { /* recovery metadata on the error is authoritative */ }
}

function restoreClaimedFile({ claimedPath, filePath }) {
  try {
    linkNoClobber(claimedPath, filePath)
    unlinkBestEffort(claimedPath)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

function restorationConflict(cause, {
  filePath,
  recoveryPath = null,
  displacedRecoveryPath = null,
  actualSha256 = null,
} = {}) {
  const error = runtimeError(
    'EVOLUTION_CONFIG_RESTORE_CONFLICT',
    'runtime config changed during activation; newer content was preserved and automatic restore was refused',
  )
  error.cause = cause
  error.restoreConflict = true
  error.targetPath = filePath
  if (recoveryPath) error.recoveryPath = recoveryPath
  if (displacedRecoveryPath) error.displacedRecoveryPath = displacedRecoveryPath
  if (actualSha256) error.actualSha256 = actualSha256
  return error
}

function rollbackPublishedConfig({
  filePath,
  beforePath,
  beforeState,
  afterSha256,
  displacedPath,
  cause,
  hooks,
}) {
  const current = readRuntimeFileState(filePath)
  if (!current.exists || current.sha256 !== afterSha256) {
    throw restorationConflict(cause, {
      filePath,
      recoveryPath: beforeState.exists ? beforePath : null,
      actualSha256: current.sha256,
    })
  }
  if (typeof hooks?.afterRollbackShaVerified === 'function') {
    hooks.afterRollbackShaVerified()
  }

  try {
    fs.renameSync(filePath, displacedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw restorationConflict(cause, {
        filePath,
        recoveryPath: beforeState.exists ? beforePath : null,
      })
    }
    throw error
  }
  if (typeof hooks?.afterRollbackTargetClaimed === 'function') {
    hooks.afterRollbackTargetClaimed()
  }

  const displaced = readRuntimeFileState(displacedPath)
  if (displaced.sha256 !== afterSha256) {
    const restored = restoreClaimedFile({ claimedPath: displacedPath, filePath })
    throw restorationConflict(cause, {
      filePath,
      recoveryPath: beforeState.exists ? beforePath : null,
      displacedRecoveryPath: restored ? null : displacedPath,
      actualSha256: displaced.sha256,
    })
  }

  if (beforeState.exists) {
    const recoverableBefore = readRuntimeFileState(beforePath)
    if (recoverableBefore.sha256 !== beforeState.sha256) {
      restoreClaimedFile({ claimedPath: displacedPath, filePath })
      throw restorationConflict(cause, {
        filePath,
        recoveryPath: beforePath,
        actualSha256: recoverableBefore.sha256,
      })
    }
    try {
      linkNoClobber(beforePath, filePath)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      throw restorationConflict(cause, { filePath, recoveryPath: beforePath })
    }
  }

  unlinkBestEffort(displacedPath)
  unlinkBestEffort(beforePath)
}

export function readEvolutionRuntimeState({
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
} = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  let rawContent = EMPTY_RUNTIME_CONFIG
  if (fs.existsSync(paths.user)) {
    const stat = fs.lstatSync(paths.user)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw runtimeError('EVOLUTION_CONFIG_FILE_INVALID', 'runtime config must be a regular file')
    }
    rawContent = fs.readFileSync(paths.user, 'utf8')
  }
  const baseline = normalizeRuntimeConfigDocument(rawContent)
  const project = readOptionalLayer(paths.project)
  const explicit = paths.explicit && ![paths.user, paths.project].includes(paths.explicit)
    ? readOptionalLayer(paths.explicit)
    : {}
  const dotenv = hostEnv.GUGO_LOAD_DOTENV !== '0' ? readRuntimeEnvFile(cwd) : {}
  const effective = {
    ...baseline.document.env,
    ...project,
    ...explicit,
    ...dotenv,
    ...hostEnv,
  }
  return Object.freeze({
    path: paths.user,
    rawContent,
    document: baseline.document,
    documentSha256: configSha256(rawContent),
    effective: safeEffectiveConfigSnapshot(effective),
    higherLayers: Object.freeze({ project, explicit, dotenv, environment: hostEnv }),
  })
}

export function lockedEvolutionConfigKeys(state, keys) {
  const priority = [
    ['environment', state.higherLayers.environment],
    ['.env', state.higherLayers.dotenv],
    ['explicit_config', state.higherLayers.explicit],
    ['project_config', state.higherLayers.project],
  ]
  return Object.freeze(keys.flatMap((key) => {
    const layer = priority.find(([, values]) => Object.hasOwn(values || {}, key))
    return layer ? [Object.freeze({ key, source: layer[0] })] : []
  }))
}

export function proposedEvolutionRuntimeState(state, patch) {
  const proposed = applyEvolutionConfigPatch(state.document, patch)
  const effective = {
    ...proposed.document.env,
    ...state.higherLayers.project,
    ...state.higherLayers.explicit,
    ...state.higherLayers.dotenv,
    ...state.higherLayers.environment,
  }
  return Object.freeze({
    content: proposed.content,
    document: proposed.document,
    documentSha256: configSha256(proposed.content),
    effective: safeEffectiveConfigSnapshot(effective),
  })
}

export function atomicWriteEvolutionRuntimeConfig({
  filePath,
  content,
  expectedSha256,
  activate,
  hooks,
} = {}) {
  const normalized = normalizeRuntimeConfigDocument(content)
  const exactContent = typeof content === 'string' ? content : normalized.content
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const lock = acquireRuntimeConfigLock(filePath)
  const transactionId = `${process.pid}.${randomUUID()}`
  const tempPath = `${filePath}.${transactionId}.next.tmp`
  const beforePath = `${filePath}.${transactionId}.before.tmp`
  const displacedPath = `${filePath}.${transactionId}.after.tmp`
  let beforeState
  let claimed = false
  let published = false
  try {
    beforeState = readRuntimeFileState(filePath)
    if (beforeState.sha256 !== expectedSha256) {
      throw runtimeError('EVOLUTION_CONFIG_CAS_MISMATCH', 'runtime config changed after review')
    }
    // Validation and activation use the normalized document, but the durable
    // file must retain the exact reviewed bytes. This matters for reversal:
    // whitespace, key order, and trailing-newline choices are user data too.
    writeDurableFile(tempPath, exactContent)
    if (typeof hooks?.afterExpectedShaVerified === 'function') {
      hooks.afterExpectedShaVerified()
    }

    if (beforeState.exists) {
      try {
        fs.renameSync(filePath, beforePath)
        claimed = true
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw runtimeError('EVOLUTION_CONFIG_CAS_MISMATCH', 'runtime config changed before publish')
        }
        throw error
      }
      const claimedState = readRuntimeFileState(beforePath)
      if (claimedState.sha256 !== expectedSha256) {
        restoreClaimedFile({ claimedPath: beforePath, filePath })
        claimed = false
        throw runtimeError('EVOLUTION_CONFIG_CAS_MISMATCH', 'runtime config changed before publish')
      }
    }

    try {
      linkNoClobber(tempPath, filePath)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw runtimeError('EVOLUTION_CONFIG_CAS_MISMATCH', 'runtime config changed before publish')
      }
      throw error
    }
    published = true
    unlinkBestEffort(tempPath)
    if (typeof activate === 'function') activate(normalized.document.env)

    const activatedState = readRuntimeFileState(filePath)
    const afterSha256 = configSha256(exactContent)
    if (!activatedState.exists || activatedState.sha256 !== afterSha256) {
      throw restorationConflict(new Error('runtime config changed before activation completed'), {
        filePath,
        recoveryPath: beforeState.exists ? beforePath : null,
        actualSha256: activatedState.sha256,
      })
    }

    unlinkBestEffort(beforePath)
    claimed = false
    return Object.freeze({
      beforeContent: beforeState.content,
      beforeSha256: beforeState.sha256,
      afterContent: exactContent,
      afterSha256,
    })
  } catch (error) {
    unlinkBestEffort(tempPath)
    if (published) {
      try {
        rollbackPublishedConfig({
          filePath,
          beforePath,
          beforeState,
          afterSha256: configSha256(exactContent),
          displacedPath,
          cause: error,
          hooks,
        })
        claimed = false
      } catch (restoreError) {
        if (restoreError?.code === 'EVOLUTION_CONFIG_RESTORE_CONFLICT') throw restoreError
        error.restoreFailed = true
        error.restoreError = restoreError
      }
    } else if (claimed) {
      const restored = restoreClaimedFile({ claimedPath: beforePath, filePath })
      if (!restored) {
        throw restorationConflict(error, { filePath, recoveryPath: beforePath })
      }
      claimed = false
    }
    throw error
  } finally {
    unlinkBestEffort(tempPath)
    if (!claimed) unlinkBestEffort(beforePath)
    releaseRuntimeConfigLock(lock)
  }
}

export function activateEvolutionRuntimeEnv(nextEnv, keys, target = process.env) {
  for (const key of keys) {
    if (Object.hasOwn(nextEnv, key)) target[key] = String(nextEnv[key])
    else delete target[key]
  }
}

export { EMPTY_RUNTIME_CONFIG }
