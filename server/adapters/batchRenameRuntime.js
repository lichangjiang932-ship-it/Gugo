import fs from 'node:fs'
import path from 'node:path'

import { resolveForFileTool } from './fsShellTools.js'
import {
  maxEntries,
  pathKey,
  requireString,
  tempSibling,
  throwIfAborted,
  toolError,
} from './batchFileSupport.js'

function nearestExistingDirectory(target) {
  let current = path.dirname(target)
  while (!fs.existsSync(current) && current !== path.dirname(current)) current = path.dirname(current)
  const stat = fs.lstatSync(current)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw toolError(`重命名目标的父路径不是安全目录：${current}`, 409, 'BATCH_RENAME_DESTINATION_PARENT_INVALID')
  }
  return { fullPath: current, stat }
}

function findPathAncestor(items, keyName) {
  const byKey = new Map(items.map((item) => [item[keyName], item]))
  for (const descendant of items) {
    let current = descendant[keyName]
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) break
      const ancestor = byKey.get(parent)
      if (ancestor) return { ancestor, descendant }
      current = parent
    }
  }
  return null
}

function findPathAncestorAcross(descendants, descendantKeyName, ancestors, ancestorKeyName) {
  const ancestorsByKey = new Map(ancestors.map((item) => [item[ancestorKeyName], item]))
  for (const descendant of descendants) {
    let current = descendant[descendantKeyName]
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) break
      const ancestor = ancestorsByKey.get(parent)
      if (ancestor) return { ancestor, descendant }
      current = parent
    }
  }
  return null
}

function assertRenameTopology(mappings) {
  const nestedSources = findPathAncestor(mappings, 'sourceKey')
  if (nestedSources) {
    throw toolError(
      `不能在同一批操作中同时选择目录及其后代：${nestedSources.ancestor.source.displayPath}，${nestedSources.descendant.source.displayPath}`,
      409,
      'BATCH_RENAME_NESTED_SOURCE',
    )
  }
  const nestedDestinations = findPathAncestor(mappings, 'destinationKey')
  if (nestedDestinations) {
    throw toolError(
      `重命名目标不能互为父子路径：${nestedDestinations.ancestor.destination.displayPath}，${nestedDestinations.descendant.destination.displayPath}`,
      409,
      'BATCH_RENAME_NESTED_DESTINATION',
    )
  }
  const destinationBelowSource = findPathAncestorAcross(mappings, 'destinationKey', mappings, 'sourceKey')
  if (destinationBelowSource) {
    throw toolError(
      `重命名目标不能与任一源形成父子路径：${destinationBelowSource.descendant.destination.displayPath}，${destinationBelowSource.ancestor.source.displayPath}`,
      409,
      'BATCH_RENAME_SOURCE_DESTINATION_OVERLAP',
    )
  }
  const sourceBelowDestination = findPathAncestorAcross(mappings, 'sourceKey', mappings, 'destinationKey')
  if (sourceBelowDestination) {
    throw toolError(
      `重命名目标不能与任一源形成父子路径：${sourceBelowDestination.ancestor.destination.displayPath}，${sourceBelowDestination.descendant.source.displayPath}`,
      409,
      'BATCH_RENAME_SOURCE_DESTINATION_OVERLAP',
    )
  }
}

function resolveRenameOperations(rawOperations, { userId = null, overwrite = false } = {}) {
  if (!Array.isArray(rawOperations) || !rawOperations.length) {
    throw toolError('batch_rename 需要非空 operations 数组', 400, 'BATCH_RENAME_OPERATIONS_REQUIRED')
  }
  if (rawOperations.length > maxEntries()) throw toolError('重命名操作数量超过配置上限', 413, 'BATCH_FILE_TOO_MANY_ENTRIES')
  const mappings = rawOperations.map((operation, index) => {
    const source = resolveForFileTool(requireString(operation?.from, `operations[${index}].from`), { userId, write: true })
    const destination = resolveForFileTool(requireString(operation?.to, `operations[${index}].to`), {
      userId,
      write: true,
      allowMissing: true,
    })
    const stat = fs.lstatSync(source.fullPath)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw toolError(
        `batch_rename 仅支持普通文件和目录，不支持符号链接或特殊文件：${source.displayPath}`,
        422,
        'BATCH_RENAME_SOURCE_TYPE_UNSUPPORTED',
      )
    }
    const destinationParent = nearestExistingDirectory(destination.fullPath)
    if (destinationParent.stat.dev !== stat.dev) {
      throw toolError('不支持跨磁盘批量重命名', 422, 'BATCH_RENAME_CROSS_DEVICE_UNSUPPORTED')
    }
    return {
      source,
      destination,
      sourceKey: pathKey(source.fullPath),
      destinationKey: pathKey(destination.fullPath),
      type: stat.isDirectory() ? 'directory' : 'file',
    }
  })
  const sourceKeys = new Set()
  const destinationKeys = new Set()
  for (const mapping of mappings) {
    if (sourceKeys.has(mapping.sourceKey)) throw toolError('重命名源重复', 409, 'BATCH_RENAME_DUPLICATE_SOURCE')
    if (destinationKeys.has(mapping.destinationKey)) throw toolError('重命名目标重复', 409, 'BATCH_RENAME_DUPLICATE_DESTINATION')
    sourceKeys.add(mapping.sourceKey)
    destinationKeys.add(mapping.destinationKey)
  }
  assertRenameTopology(mappings)
  for (const mapping of mappings) {
    if (mapping.sourceKey === mapping.destinationKey && mapping.source.fullPath === mapping.destination.fullPath) continue
    if (fs.existsSync(mapping.destination.fullPath) && !sourceKeys.has(mapping.destinationKey)) {
      const stat = fs.lstatSync(mapping.destination.fullPath)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw toolError('重命名目标不是普通文件或目录', 409, 'BATCH_RENAME_DESTINATION_CONFLICT')
      }
      const destinationType = stat.isDirectory() ? 'directory' : 'file'
      if (destinationType !== mapping.type) {
        throw toolError(
          `重命名源与现有目标类型不一致：${mapping.source.displayPath}，${mapping.destination.displayPath}`,
          409,
          'BATCH_RENAME_DESTINATION_TYPE_CONFLICT',
        )
      }
      if (!overwrite) throw toolError(`重命名目标已存在：${mapping.destination.displayPath}`, 409, 'BATCH_FILE_OUTPUT_EXISTS')
    }
  }
  return mappings
}

function ensureRenameParent(target, createdDirectories) {
  const missing = []
  let current = path.dirname(target)
  while (!fs.existsSync(current) && current !== path.dirname(current)) {
    missing.push(current)
    current = path.dirname(current)
  }
  const existing = fs.lstatSync(current)
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw toolError(`重命名目标的父路径不是安全目录：${current}`, 409, 'BATCH_RENAME_DESTINATION_PARENT_INVALID')
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory)
      createdDirectories.add(directory)
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause
      const stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw cause
    }
  }
}

function rollbackBatchRename({ published, staged, backups, createdDirectories }) {
  const failures = []
  const recover = (from, to, label) => {
    if (!fs.existsSync(from)) {
      failures.push(`${label}：找不到 ${from}`)
      return
    }
    if (fs.existsSync(to)) {
      failures.push(`${label}：目标已存在 ${to}`)
      return
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, to)
    } catch (cause) {
      failures.push(`${label}：${cause?.message || '文件系统错误'}`)
    }
  }

  for (const item of [...published].reverse()) {
    recover(item.mapping.destination.fullPath, item.stagePath, '撤回已发布目标失败')
  }
  for (const item of [...staged].reverse()) {
    if (fs.existsSync(item.stagePath)) recover(item.stagePath, item.mapping.source.fullPath, '恢复原始路径失败')
  }
  for (const backup of [...backups].reverse()) {
    if (fs.existsSync(backup.backupPath)) recover(backup.backupPath, backup.target, '恢复被覆盖目标失败')
  }
  for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(directory) } catch (cause) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(cause?.code)) failures.push(`清理新建目录失败：${cause?.message || directory}`)
    }
  }
  return failures
}

export async function batchRename(args, context) {
  const overwrite = args.overwrite === true
  const mappings = resolveRenameOperations(args.operations, { userId: context.userId, overwrite })
  const active = mappings.filter((item) => item.source.fullPath !== item.destination.fullPath)
  const staged = []
  const backups = []
  const published = []
  const createdDirectories = new Set()
  try {
    for (const mapping of active) {
      throwIfAborted(context.signal)
      const stagePath = tempSibling(mapping.source.fullPath, '.rename')
      fs.renameSync(mapping.source.fullPath, stagePath)
      staged.push({ mapping, stagePath })
    }
    for (const item of staged) {
      const target = item.mapping.destination.fullPath
      ensureRenameParent(target, createdDirectories)
      if (fs.existsSync(target)) {
        const backupPath = tempSibling(target, '.bak')
        fs.renameSync(target, backupPath)
        backups.push({ target, backupPath })
      }
    }
    for (const item of staged) {
      throwIfAborted(context.signal)
      fs.renameSync(item.stagePath, item.mapping.destination.fullPath)
      published.push(item)
    }
  } catch (cause) {
    const rollbackFailures = rollbackBatchRename({ published, staged, backups, createdDirectories })
    const recoveryPaths = [
      ...staged.map((item) => item.stagePath),
      ...published.map((item) => item.mapping.destination.fullPath),
      ...backups.map((item) => item.backupPath),
    ].filter((candidate) => fs.existsSync(candidate))
    if (cause?.code === 'BATCH_FILE_CANCELLED') {
      Object.assign(cause, { rollbackFailures, recoveryPaths })
      throw cause
    }
    const recovery = rollbackFailures.length ? '部分路径未能自动恢复，请检查 recoveryPaths' : '原路径已自动恢复'
    throw toolError(
      `批量重命名失败，${recovery}：${cause?.message || '文件系统错误'}`,
      500,
      'BATCH_RENAME_FAILED',
      { cause, rollbackFailures, recoveryPaths },
    )
  }

  const cleanupWarnings = []
  for (const backup of backups) {
    try { fs.rmSync(backup.backupPath, { recursive: true, force: true }) } catch (cause) {
      cleanupWarnings.push(`未能清理备份 ${backup.backupPath}：${cause?.message || '文件系统错误'}`)
    }
  }
  return {
    ok: true,
    changedPaths: mappings.map((mapping) => mapping.destination.displayPath),
    renamed: mappings.map((mapping) => ({
      from: mapping.source.displayPath,
      to: mapping.destination.displayPath,
      type: mapping.type,
      recursive: mapping.type === 'directory',
      unchanged: mapping.source.fullPath === mapping.destination.fullPath,
    })),
    ...(cleanupWarnings.length ? { cleanupWarnings } : {}),
  }
}
