import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertRegularOrDirectory,
  maxEntries,
  pathKey,
  requireString,
  throwIfAborted,
  toolError,
} from './batchFileSupport.js'
import { resolveForFileTool } from './fsShellTools.js'

function collectManifestFiles(rawInputs, { userId = null, recursive = true } = {}) {
  if (!Array.isArray(rawInputs) || !rawInputs.length) {
    throw toolError('file_hash_manifest 需要非空 inputs 数组', 400, 'HASH_INPUTS_REQUIRED')
  }
  const files = new Map()
  const visit = (fullPath) => {
    const stat = fs.lstatSync(fullPath)
    assertRegularOrDirectory(fullPath, stat, fullPath)
    if (stat.isFile()) {
      const resolved = resolveForFileTool(fullPath, { userId })
      files.set(pathKey(resolved.fullPath), { resolved, stat })
      if (files.size > maxEntries()) throw toolError('待计算哈希的文件数量超过配置上限', 413, 'BATCH_FILE_TOO_MANY_ENTRIES')
      return
    }
    if (!recursive) return
    for (const child of fs.readdirSync(fullPath).sort()) visit(path.join(fullPath, child))
  }
  rawInputs.forEach((rawPath, index) => {
    const resolved = resolveForFileTool(requireString(rawPath, `inputs[${index}]`), { userId })
    visit(resolved.fullPath)
  })
  return [...files.values()].sort((a, b) => a.resolved.displayPath.localeCompare(b.resolved.displayPath))
}

async function sha256File(file, signal) {
  const before = fs.statSync(file.resolved.fullPath)
  const hash = crypto.createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(file.resolved.fullPath)) {
    throwIfAborted(signal)
    hash.update(chunk)
    size += chunk.length
  }
  const after = fs.statSync(file.resolved.fullPath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) {
    throw toolError(`计算哈希时文件发生变化：${file.resolved.displayPath}`, 409, 'HASH_SOURCE_CHANGED')
  }
  return {
    path: file.resolved.displayPath,
    scope: file.resolved.source,
    size,
    modifiedAt: Math.round(after.mtimeMs),
    sha256: hash.digest('hex'),
  }
}

async function fileHashManifest(args, context) {
  const files = collectManifestFiles(args.inputs, { userId: context.userId, recursive: args.recursive !== false })
  const manifest = []
  for (const file of files) manifest.push(await sha256File(file, context.signal))
  const groups = new Map()
  for (const item of manifest) {
    const key = `${item.size}:${item.sha256}`
    const group = groups.get(key) || []
    group.push(item.path)
    groups.set(key, group)
  }
  const duplicates = [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([key, paths]) => {
      const separator = key.indexOf(':')
      return { size: Number(key.slice(0, separator)), sha256: key.slice(separator + 1), paths }
    })
  return {
    ok: true,
    algorithm: 'sha256',
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, item) => sum + item.size, 0),
    files: manifest,
    duplicates,
  }
}

export { fileHashManifest }
