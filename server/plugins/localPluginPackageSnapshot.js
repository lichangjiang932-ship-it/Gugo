import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import { validateManifest } from './pluginManifest.js'

export const LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE = '.gugo-package-receipt.json'
export const LOCAL_PLUGIN_PACKAGE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxEntries: 4_096,
  maxDirectories: 2_048,
  maxFiles: 2_048,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
})

const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const PORTABLE_INVALID_SEGMENT_RE = /[<>:"/\\|?*]/

function packageSnapshotError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function canonicalPath(target) {
  return fs.realpathSync.native?.(target) || fs.realpathSync(target)
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

function validatePortableSegment(segment) {
  const containsControlCharacter = typeof segment === 'string'
    && Array.from(segment).some((character) => character.charCodeAt(0) < 0x20)
  if (
    typeof segment !== 'string'
    || !segment
    || segment === '.'
    || segment === '..'
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || PORTABLE_INVALID_SEGMENT_RE.test(segment)
    || containsControlCharacter
    || WINDOWS_RESERVED_BASENAME_RE.test(segment)
  ) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_PATH_INVALID',
      `plugin package contains a non-portable path segment: ${JSON.stringify(segment)}`,
    )
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function readStableRegularFile(filePath, relativePath, limits) {
  let before
  try {
    before = fs.lstatSync(filePath, { bigint: true })
  } catch (error) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_CHANGED',
      `plugin package file disappeared while reading ${relativePath}: ${error?.message || error}`,
    )
  }
  if (before.isSymbolicLink()) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_LINK_FORBIDDEN',
      `plugin package links are not allowed: ${relativePath}`,
    )
  }
  if (!before.isFile()) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_FILE_TYPE_FORBIDDEN',
      `plugin package contains an unsupported file type: ${relativePath}`,
    )
  }
  if (before.size > BigInt(limits.maxFileBytes)) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_FILE_TOO_LARGE',
      `plugin package file exceeds ${limits.maxFileBytes} bytes: ${relativePath}`,
    )
  }

  const noFollow = Number(fs.constants.O_NOFOLLOW || 0)
  let descriptor
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_SOURCE_CHANGED',
        `plugin package file changed before it could be captured: ${relativePath}`,
      )
    }
    const chunks = []
    let totalBytes = 0
    while (true) {
      const remaining = limits.maxFileBytes + 1 - totalBytes
      if (remaining <= 0) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_FILE_TOO_LARGE',
          `plugin package file exceeds ${limits.maxFileBytes} bytes: ${relativePath}`,
        )
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      totalBytes += bytesRead
    }
    const bytes = Buffer.concat(chunks, totalBytes)
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (!sameFileIdentity(opened, after) || BigInt(bytes.length) !== after.size) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_SOURCE_CHANGED',
        `plugin package file changed while it was being captured: ${relativePath}`,
      )
    }
    const current = fs.lstatSync(filePath, { bigint: true })
    if (current.isSymbolicLink() || !sameFileIdentity(after, current)) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_SOURCE_CHANGED',
        `plugin package path changed while it was being captured: ${relativePath}`,
      )
    }
    return bytes
  } catch (error) {
    if (error?.code?.startsWith?.('PLUGIN_PACKAGE_')) throw error
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_READ_FAILED',
      `plugin package file could not be read: ${relativePath}: ${error?.message || error}`,
    )
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function packageDigest(files, directories) {
  const digest = createHash('sha256')
  digest.update('gugo-local-plugin-package-v2\0')
  const entries = [
    ...directories.map((relativePath) => ({ kind: 'directory', relativePath })),
    ...files.map((file) => ({ kind: 'file', ...file })),
  ].sort((left, right) => (
    compareUtf8(left.relativePath, right.relativePath)
    || compareUtf8(left.kind, right.kind)
  ))
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.relativePath, 'utf8')
    digest.update(entry.kind === 'directory' ? 'D:' : 'F:')
    digest.update(String(pathBytes.length))
    digest.update(':')
    digest.update(pathBytes)
    if (entry.kind === 'file') {
      digest.update(':')
      digest.update(String(entry.sizeBytes))
      digest.update(':')
      digest.update(entry.contentDigest)
    }
    digest.update('\n')
  }
  return `sha256-${digest.digest('hex')}`
}

function compareUtf8(left, right) {
  return Buffer.compare(
    Buffer.from(String(left).normalize('NFC'), 'utf8'),
    Buffer.from(String(right).normalize('NFC'), 'utf8'),
  )
}

function strictJsonObject(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_MANIFEST_INVALID',
      `plugin.json is not valid UTF-8: ${error?.message || error}`,
    )
  }

  let cursor = 0
  const skipWhitespace = () => {
    while (/\s/u.test(text[cursor] || '')) cursor += 1
  }
  const parseStringToken = () => {
    if (text[cursor] !== '"') throw new SyntaxError('expected JSON string')
    const start = cursor
    cursor += 1
    while (cursor < text.length) {
      const character = text[cursor]
      if (character === '"') {
        cursor += 1
        return JSON.parse(text.slice(start, cursor))
      }
      if (character === '\\') {
        cursor += 2
        continue
      }
      if (character.charCodeAt(0) < 0x20) throw new SyntaxError('control character in JSON string')
      cursor += 1
    }
    throw new SyntaxError('unterminated JSON string')
  }
  const parsePrimitive = () => {
    const match = text.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) throw new SyntaxError('invalid JSON value')
    cursor += match[0].length
  }
  const parseValue = () => {
    skipWhitespace()
    const character = text[cursor]
    if (character === '{') {
      cursor += 1
      skipWhitespace()
      const keys = new Set()
      if (text[cursor] === '}') {
        cursor += 1
        return
      }
      while (cursor < text.length) {
        skipWhitespace()
        const key = parseStringToken()
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON object key: ${key}`)
        keys.add(key)
        skipWhitespace()
        if (text[cursor] !== ':') throw new SyntaxError('expected colon after JSON object key')
        cursor += 1
        parseValue()
        skipWhitespace()
        if (text[cursor] === '}') {
          cursor += 1
          return
        }
        if (text[cursor] !== ',') throw new SyntaxError('expected comma in JSON object')
        cursor += 1
      }
      throw new SyntaxError('unterminated JSON object')
    }
    if (character === '[') {
      cursor += 1
      skipWhitespace()
      if (text[cursor] === ']') {
        cursor += 1
        return
      }
      while (cursor < text.length) {
        parseValue()
        skipWhitespace()
        if (text[cursor] === ']') {
          cursor += 1
          return
        }
        if (text[cursor] !== ',') throw new SyntaxError('expected comma in JSON array')
        cursor += 1
      }
      throw new SyntaxError('unterminated JSON array')
    }
    if (character === '"') {
      parseStringToken()
      return
    }
    parsePrimitive()
  }

  try {
    parseValue()
    skipWhitespace()
    if (cursor !== text.length) throw new SyntaxError('trailing data after JSON value')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError('manifest must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_MANIFEST_INVALID',
      `plugin.json is not valid strict JSON: ${error?.message || error}`,
    )
  }
}

function treeIdentity(stat, type) {
  return [
    type,
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
  ].join(':')
}

function rescanTreeIdentity(root, limits) {
  const identities = new Map()
  let entryCount = 0
  let directoryCount = 0
  const walk = (directory, segments, depth) => {
    if (depth > limits.maxDepth) {
      throw packageSnapshotError('PLUGIN_PACKAGE_SOURCE_CHANGED', 'plugin package tree depth changed')
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name))
    for (const entry of entries) {
      validatePortableSegment(entry.name)
      entryCount += 1
      if (entryCount > limits.maxEntries) {
        throw packageSnapshotError('PLUGIN_PACKAGE_TOO_MANY_ENTRIES', 'plugin package has too many entries')
      }
      const relativePath = [...segments, entry.name].join('/')
      const target = path.join(directory, entry.name)
      const stat = fs.lstatSync(target, { bigint: true })
      if (stat.isSymbolicLink()) {
        throw packageSnapshotError('PLUGIN_PACKAGE_LINK_FORBIDDEN', `plugin package links are not allowed: ${relativePath}`)
      }
      if (stat.isDirectory()) {
        directoryCount += 1
        if (directoryCount > limits.maxDirectories) {
          throw packageSnapshotError('PLUGIN_PACKAGE_TOO_MANY_DIRECTORIES', 'plugin package has too many directories')
        }
        identities.set(relativePath, treeIdentity(stat, 'directory'))
        walk(target, [...segments, entry.name], depth + 1)
      } else if (stat.isFile()) {
        identities.set(relativePath, treeIdentity(stat, 'file'))
      } else {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_FILE_TYPE_FORBIDDEN',
          `plugin package contains an unsupported file type: ${relativePath}`,
        )
      }
    }
  }
  walk(root, [], 0)
  return identities
}

function normalizedEntryPath(entry) {
  return String(entry || '').replaceAll('\\', '/')
}

function resolveSnapshotRoot(sourceDir) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_INVALID',
      'plugin package source must be a non-empty directory path',
    )
  }
  const resolvedRoot = path.resolve(sourceDir)
  let rootStat
  try {
    rootStat = fs.lstatSync(resolvedRoot)
  } catch (error) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_NOT_FOUND',
      `plugin package source does not exist: ${error?.message || error}`,
    )
  }
  if (rootStat.isSymbolicLink()) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_LINK_FORBIDDEN',
      'plugin package source must not be a symbolic link or junction',
    )
  }
  if (!rootStat.isDirectory()) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_INVALID',
      'plugin package source must be a directory',
    )
  }
  return canonicalPath(resolvedRoot)
}

function finalizePluginPackageSnapshot({
  canonicalRoot,
  limits,
  initialTreeIdentity,
  files,
  directories,
  totalBytes,
}) {
  const finalTreeIdentity = rescanTreeIdentity(canonicalRoot, limits)
  if (finalTreeIdentity.size !== initialTreeIdentity.size
    || [...initialTreeIdentity].some(([entry, identity]) => finalTreeIdentity.get(entry) !== identity)) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_CHANGED',
      'plugin package directory changed while it was being captured',
    )
  }
  const manifestFile = files.find((file) => file.relativePath === 'plugin.json')
  if (!manifestFile) {
    throw packageSnapshotError('PLUGIN_PACKAGE_MANIFEST_MISSING', 'plugin package must contain plugin.json')
  }
  if (manifestFile.sizeBytes > limits.maxManifestBytes) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_MANIFEST_TOO_LARGE',
      `plugin.json exceeds ${limits.maxManifestBytes} bytes`,
    )
  }
  const validated = validateManifest(strictJsonObject(manifestFile.bytes))
  if (!validated.ok) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_MANIFEST_INVALID',
      `plugin.json is invalid: ${validated.errors.join('; ')}`,
    )
  }
  const entryPath = normalizedEntryPath(validated.manifest.entry)
  if (!files.some((file) => file.relativePath === entryPath)) {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_ENTRY_MISSING',
      `plugin package entry file is missing: ${validated.manifest.entry}`,
    )
  }
  return {
    sourceRoot: canonicalRoot,
    manifest: validated.manifest,
    files,
    directories,
    fileCount: files.length,
    totalBytes,
    packageDigest: packageDigest(files, directories),
  }
}

/**
 * Capture a bounded, deterministic snapshot of a local plugin directory.
 * No plugin code is imported or executed. Buffers are retained only when
 * captureBytes=true so the installer copies the exact bytes that were hashed.
 */
export function snapshotLocalPluginPackage(sourceDir, {
  captureBytes = false,
  receiptMode = 'reject',
  limits = LOCAL_PLUGIN_PACKAGE_LIMITS,
} = {}) {
  if (receiptMode !== 'reject' && receiptMode !== 'exclude') {
    throw packageSnapshotError(
      'PLUGIN_PACKAGE_SOURCE_INVALID',
      'plugin package receipt mode is invalid',
    )
  }

  const canonicalRoot = resolveSnapshotRoot(sourceDir)
  const files = []
  const directories = []
  const portablePaths = new Set()
  const initialTreeIdentity = new Map()
  let totalBytes = 0
  let entryCount = 0
  let directoryCount = 0

  const walk = (directory, segments, depth) => {
    if (depth > limits.maxDepth) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_TOO_DEEP',
        `plugin package exceeds the maximum depth of ${limits.maxDepth}`,
      )
    }
    const canonicalDirectory = canonicalPath(directory)
    if (!isWithinDirectory(canonicalRoot, canonicalDirectory)) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_PATH_ESCAPE',
        'plugin package directory escapes its source root',
      )
    }
    let entries
    try {
      entries = fs.readdirSync(canonicalDirectory, { withFileTypes: true })
    } catch (error) {
      throw packageSnapshotError(
        'PLUGIN_PACKAGE_READ_FAILED',
        `plugin package directory could not be read: ${error?.message || error}`,
      )
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name))
    for (const entry of entries) {
      validatePortableSegment(entry.name)
      entryCount += 1
      if (entryCount > limits.maxEntries) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_TOO_MANY_ENTRIES',
          `plugin package exceeds the maximum entry count of ${limits.maxEntries}`,
        )
      }
      const childSegments = [...segments, entry.name]
      const relativePath = childSegments.join('/')
      const portableIdentity = relativePath.normalize('NFC').toLowerCase()
      if (portablePaths.has(portableIdentity)) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_PATH_COLLISION',
          `plugin package contains a cross-platform path collision: ${relativePath}`,
        )
      }
      portablePaths.add(portableIdentity)

      const childPath = path.join(canonicalDirectory, entry.name)
      const childStat = fs.lstatSync(childPath, { bigint: true })
      if (childStat.isSymbolicLink()) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_LINK_FORBIDDEN',
          `plugin package links are not allowed: ${relativePath}`,
        )
      }
      if (childStat.isDirectory()) {
        directoryCount += 1
        if (directoryCount > limits.maxDirectories) {
          throw packageSnapshotError(
            'PLUGIN_PACKAGE_TOO_MANY_DIRECTORIES',
            `plugin package exceeds the maximum directory count of ${limits.maxDirectories}`,
          )
        }
        initialTreeIdentity.set(relativePath, treeIdentity(childStat, 'directory'))
        directories.push(relativePath)
        walk(childPath, childSegments, depth + 1)
        continue
      }
      if (!childStat.isFile()) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_FILE_TYPE_FORBIDDEN',
          `plugin package contains an unsupported file type: ${relativePath}`,
        )
      }
      if (relativePath === LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE) {
        initialTreeIdentity.set(relativePath, treeIdentity(childStat, 'file'))
        if (receiptMode === 'exclude') continue
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_RESERVED_PATH',
          `${LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE} is reserved for the host install receipt`,
        )
      }
      if (files.length >= limits.maxFiles) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_TOO_MANY_FILES',
          `plugin package exceeds the maximum file count of ${limits.maxFiles}`,
        )
      }
      const bytes = readStableRegularFile(childPath, relativePath, limits)
      const stableStat = fs.lstatSync(childPath, { bigint: true })
      initialTreeIdentity.set(relativePath, treeIdentity(stableStat, 'file'))
      totalBytes += bytes.length
      if (totalBytes > limits.maxTotalBytes) {
        throw packageSnapshotError(
          'PLUGIN_PACKAGE_TOO_LARGE',
          `plugin package exceeds the maximum total size of ${limits.maxTotalBytes} bytes`,
        )
      }
      files.push({
        relativePath,
        sizeBytes: bytes.length,
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
        bytes: captureBytes || relativePath === 'plugin.json' ? bytes : null,
      })
    }
  }

  walk(canonicalRoot, [], 0)
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath))
  directories.sort(compareUtf8)

  return finalizePluginPackageSnapshot({
    canonicalRoot,
    limits,
    initialTreeIdentity,
    files,
    directories,
    totalBytes,
  })
}
