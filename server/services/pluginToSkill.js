/**
 * Import a skill-bundle without executing its code. Every file is read through
 * the existing handle-bound plugin reader using the original plugin root.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getPlugin } from '../plugins/pluginRegistry.js'
import { readPluginEntryFile } from '../plugins/pluginEntryFile.js'
import { validateSkillPack, installValidatedSkillPack } from './skillImport.js'

const ALLOWED_EXTS = new Set(['.md', '.txt', '.json'])
const MAX_FILES = 64
const MAX_DIRECTORIES = 256
const MAX_FILE_BYTES = 256 * 1024

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sourceError(message) {
  return Object.assign(new Error(message), { code: 'PLUGIN_SKILL_SCOPE_INVALID' })
}

async function directoryIdentity(pluginRoot, directory) {
  const stat = await fs.lstat(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw sourceError('路径越界或目录联接不可用')
  }
  const canonical = await fs.realpath(directory)
  const relative = path.relative(pluginRoot, canonical)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw sourceError('路径越界：技能资源不在插件目录内')
  }
  return stat
}

async function readSkillFile(pluginRoot, entryPath) {
  const { bytes } = await readPluginEntryFile({
    rootDir: pluginRoot,
    entryPath,
    maxBytes: MAX_FILE_BYTES,
  })
  return bytes.toString('utf8')
}

async function collectPromptFiles(pluginRoot) {
  const files = {}
  const stack = [{ abs: path.join(pluginRoot, 'prompts'), rel: 'prompts' }]
  let directories = 0
  while (stack.length) {
    if (++directories > MAX_DIRECTORIES) throw sourceError('plugin 目录数超限')
    const { abs, rel } = stack.pop()
    const before = await directoryIdentity(pluginRoot, abs)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    const after = await directoryIdentity(pluginRoot, abs)
    if (!sameIdentity(before, after)) throw sourceError('技能目录在读取期间发生变化')
    for (const entry of entries) {
      const entryPath = path.join(abs, entry.name)
      const relativePath = rel + '/' + entry.name
      if (entry.isSymbolicLink()) throw sourceError('路径越界或符号链接不可用: ' + relativePath)
      if (entry.isDirectory()) {
        stack.push({ abs: entryPath, rel: relativePath })
      } else if (entry.isFile() && ALLOWED_EXTS.has(path.extname(entry.name).toLowerCase())) {
        if (Object.keys(files).length >= MAX_FILES) throw sourceError('plugin 文件数超限')
        files[relativePath] = await readSkillFile(pluginRoot, entryPath)
      }
    }
  }
  return files
}

/** Filesystem failures stay data errors; no partial skill is installed. */
export async function installPluginAsSkill({ pluginId, userId, existingIds = [] } = {}) {
  if (!pluginId || typeof pluginId !== 'string') return { ok: false, reason: '缺少 pluginId' }
  if (!userId || typeof userId !== 'string') return { ok: false, reason: '缺少 userId' }
  const plugin = getPlugin(pluginId)
  if (!plugin) return { ok: false, reason: 'plugin not found: ' + pluginId }
  if (plugin.type !== 'skill-bundle') {
    return { ok: false, reason: 'plugin 类型必须是 skill-bundle (got ' + plugin.type + ')' }
  }
  if (!plugin.rootDir || typeof plugin.rootDir !== 'string') {
    return { ok: false, reason: 'plugin 缺少 rootDir' }
  }

  try {
    // Do not realpath away a replaced root before the handle-bound reader can
    // reject it. The loader-owned original path is the authority boundary.
    const pluginRoot = path.resolve(plugin.rootDir)
    const rootIdentity = await directoryIdentity(pluginRoot, pluginRoot)
    const files = {
      'skill.json': await readSkillFile(pluginRoot, path.join(pluginRoot, 'skill.json')),
      ...await collectPromptFiles(pluginRoot),
    }
    const finalRootIdentity = await directoryIdentity(pluginRoot, pluginRoot)
    if (!sameIdentity(rootIdentity, finalRootIdentity)) {
      throw sourceError('插件目录在读取期间发生变化')
    }
    const validation = validateSkillPack(files)
    if (!validation.ok) return validation
    return installValidatedSkillPack({ files, existingIds, userId })
  } catch (error) {
    return {
      ok: false,
      reason: '技能包读取或安装失败: ' + (error?.message || String(error)),
      ...(error?.code ? { code: error.code } : {}),
    }
  }
}
