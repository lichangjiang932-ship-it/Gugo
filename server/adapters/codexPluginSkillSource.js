import fs from 'node:fs'
import path from 'node:path'
import { parseCodexSkillMarkdown } from './codexSkillMarkdown.js'
import { MAX_MANIFEST_BYTES, MAX_SKILL_BYTES } from './codexPluginSkillConfig.js'

function canonicalKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function snapshotKey(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

function currentFileIdentity(pluginRoot, filePath, maxBytes) {
  const stat = fs.lstatSync(filePath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxBytes)) return null
  const canonical = fs.realpathSync(filePath)
  const relative = path.relative(pluginRoot, canonical)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
    || canonicalKey(canonical) !== canonicalKey(filePath)) return null
  return { stat, canonical, key: snapshotKey(stat) }
}

function readCurrentFile(pluginRoot, filePath, maxBytes, cache) {
  const identity = currentFileIdentity(pluginRoot, filePath, maxBytes)
  if (!identity) return null
  const cached = cache.get(filePath)
  if (cached?.key === identity.key) return cached.text
  const descriptor = fs.openSync(identity.canonical, 'r')
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (snapshotKey(opened) !== identity.key) return null
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    const finalFile = currentFileIdentity(pluginRoot, filePath, maxBytes)
    if (!finalFile || offset > maxBytes || BigInt(offset) !== opened.size
      || snapshotKey(fs.fstatSync(descriptor, { bigint: true })) !== identity.key
      || finalFile.key !== identity.key) return null
    const text = buffer.subarray(0, offset).toString('utf8')
    cache.set(filePath, { key: identity.key, text })
    return text
  } finally { fs.closeSync(descriptor) }
}

/** Reuse unchanged bytes, but let the caller reassess current dependencies. */
export function readCurrentCodexPluginSkillSource(source, cache) {
  if (!source) return null
  try {
    const manifestText = readCurrentFile(source.pluginRoot, source.manifestPath, MAX_MANIFEST_BYTES, cache)
    const skillText = readCurrentFile(source.pluginRoot, source.skillPath, MAX_SKILL_BYTES, cache)
    if (manifestText === null || skillText === null) return null
    const manifest = JSON.parse(manifestText)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !String(manifest.name || '').trim()) return null
    const prompt = String(parseCodexSkillMarkdown(skillText).body || '').trim()
    return prompt ? { manifest, skillText, prompt } : null
  } catch { return null }
}
