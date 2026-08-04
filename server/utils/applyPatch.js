/**
 * Codex 风格 apply_patch — 服务端原生多文件原子编辑。
 *
 * 与已有 multi_edit 的区别:
 *   - multi_edit 是 SEARCH/REPLACE,要模型给整块旧文本,长 patch 很费 token
 *   - apply_patch 用类 unified-diff 格式,只给上下文 + 增删行,省 token、模型也更熟
 *   - 服务端原子写(都成功才落盘),不像前端 multi_edit 那样要 catch-rollback
 *   - 内置 dry-run 预览,前端 UI 可在执行前给用户看 diff
 *
 * 支持的 patch 格式(Codex 兼容):
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.js
 *   +line 1
 *   +line 2
 *   *** Update File: path/to/exist.js
 *   @@
 *    unchanged line
 *   -removed line
 *   +added line
 *    unchanged line
 *   *** Delete File: path/to/dead.js
 *   *** End Patch
 *
 * 规则:
 *   - Add: 目标文件不能已存在(防误覆盖); 行必须全部以 + 开头
 *   - Delete: 目标文件必须存在
 *   - Update: hunks 之间用 @@ 分隔,每个 hunk 内 ' ' 表示上下文(必须在原文中匹配),
 *             '-' 删行,'+' 加行;上下文 + 删除行拼起来必须在原文中"唯一存在"
 *   - dry_run: 全部规划但不写盘,返回每文件的 stats + 新内容预览(前 200 行)
 *
 * 安全:
 *   - 所有 path 经 resolveInWorkspace 沙箱
 *   - 单文件 8MB 上限,patch 文本 2MB 上限
 *   - 任一文件规划失败 → 全部不写
 *   - 写阶段任一失败 → 已写的回滚到原始内容
 */

import fs from 'node:fs'
import path from 'node:path'
import { patchLimiter } from './rateLimiter.js'
import { resolveAuthorizedLocalPath } from '../services/localFileAccessService.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'

const MAX_PATCH_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_OPS = 30
const PREVIEW_LINES = 200

function getWorkspaceRoot() {
  const raw = process.env.WORKSPACE_ROOT?.trim()
  return raw ? path.resolve(raw) : process.cwd()
}

function badReq(msg, status = 400) {
  const err = new Error(msg)
  err.statusCode = status
  return err
}

function resolveInWorkspace(rawPath, { mustExist = false, userId = null } = {}) {
  if (!userId) {
    try {
      return resolveAuthorizedLocalPath({
        userId: null,
        rawPath,
        write: true,
        allowMissing: !mustExist,
        allowWorkspace: true,
      })
    } catch (error) {
      if (error?.code === 'PATH_NOT_AUTHORIZED') {
        throw badReq(`\u8def\u5f84\u8d8a\u754c: ${rawPath}`, 403)
      }
      throw error
    }
  }
  if (userId) {
    const resolved = resolveAuthorizedLocalPath({
      userId,
      rawPath,
      write: true,
      allowMissing: !mustExist,
    })
    assertWorkspaceCapability({
      userId,
      rootPath: resolved.rootPath || getWorkspaceRoot(),
      capability: 'fileSystemWrite',
    })
    return resolved
  }
  const root = getWorkspaceRoot()
  if (!rawPath || typeof rawPath !== 'string') throw badReq('path 非法')
  const absRaw = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath)
  const rootReal = fs.realpathSync(root)
  let resolved
  if (fs.existsSync(absRaw)) {
    resolved = fs.realpathSync(absRaw)
  } else {
    if (mustExist) throw badReq(`文件不存在: ${rawPath}`, 404)
    // 不存在:用父目录 realpath + basename 拼,防 symlink 父目录跳出
    const parent = path.dirname(absRaw)
    if (!fs.existsSync(parent)) {
      // 也允许父目录不存在(Add File 的常见场景),但要确保 parent 解析后在 root 下
      const parentResolved = path.resolve(parent)
      if (parentResolved !== rootReal && !parentResolved.startsWith(rootReal + path.sep)) {
        throw badReq(`路径越界: ${rawPath}`, 403)
      }
      resolved = path.join(parentResolved, path.basename(absRaw))
    } else {
      const parentReal = fs.realpathSync(parent)
      resolved = path.join(parentReal, path.basename(absRaw))
    }
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw badReq(`路径越界: ${rawPath}`, 403)
  }
  return {
    fullPath: resolved,
    displayPath: toRelative(resolved),
    source: 'workspace',
  }
}

function toRelative(absPath) {
  try {
    const rootReal = fs.realpathSync(getWorkspaceRoot())
    return path.relative(rootReal, absPath) || '.'
  } catch {
    return absPath
  }
}

function sameResolvedPath(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function revalidatePlanPath(plan, { userId, mustExist = plan.op !== 'add' } = {}) {
  const resolved = resolveInWorkspace(plan.rawPath, { mustExist, userId })
  if (!sameResolvedPath(resolved.fullPath, plan.abs)) {
    throw badReq(`path changed after validation: ${plan.rawPath}`, 409)
  }
  return resolved.fullPath
}

/* ─── parser ─── */

const OP_RE = /^\*\*\* (Add File|Update File|Delete File): (.+)$/

export function parsePatch(text) {
  if (typeof text !== 'string') throw badReq('patch 必须是字符串')
  if (text.length > MAX_PATCH_BYTES) throw badReq('patch 过大', 413)
  // 标准化换行
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // 去除前后空行
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  if (lines[0] !== '*** Begin Patch') throw badReq('patch 必须以 "*** Begin Patch" 开头')
  if (lines[lines.length - 1] !== '*** End Patch') throw badReq('patch 必须以 "*** End Patch" 结尾')

  const ops = []
  let i = 1
  while (i < lines.length - 1) {
    const header = lines[i]
    const m = OP_RE.exec(header)
    if (!m) throw badReq(`第 ${i + 1} 行无法识别: ${header}`)
    const opKind = m[1]
    const opPath = m[2].trim()
    if (!opPath) throw badReq(`第 ${i + 1} 行缺少路径`)
    i++
    // 收集到下一个 *** 头或 End Patch
    const body = []
    while (i < lines.length - 1 && !lines[i].startsWith('*** ')) {
      body.push(lines[i])
      i++
    }
    if (opKind === 'Add File') {
      // 全部行必须 + 开头(允许行尾空白)
      const content = []
      for (const ln of body) {
        if (ln === '') { content.push(''); continue } // 空行允许
        if (!ln.startsWith('+')) throw badReq(`Add File ${opPath}: 行必须以 + 开头,得到 "${ln}"`)
        content.push(ln.slice(1))
      }
      // 去掉末尾因 split 多出来的空行
      while (content.length && content[content.length - 1] === '') content.pop()
      ops.push({ kind: 'add', path: opPath, content: content.join('\n') + (content.length ? '\n' : '') })
    } else if (opKind === 'Delete File') {
      // 不应有 body
      const nonEmpty = body.filter((l) => l.trim() !== '')
      if (nonEmpty.length > 0) throw badReq(`Delete File ${opPath}: 不应有正文`)
      ops.push({ kind: 'delete', path: opPath })
    } else if (opKind === 'Update File') {
      const hunks = parseHunks(body, opPath)
      ops.push({ kind: 'update', path: opPath, hunks })
    }
  }
  if (ops.length === 0) throw badReq('patch 没有任何操作')
  if (ops.length > MAX_OPS) throw badReq(`单次最多 ${MAX_OPS} 个文件操作`, 413)
  // 检查路径重复
  const seen = new Set()
  for (const op of ops) {
    if (seen.has(op.path)) throw badReq(`路径重复: ${op.path}`)
    seen.add(op.path)
  }
  return ops
}

function parseHunks(body, opPath) {
  // 跳过开头空行
  let start = 0
  while (start < body.length && body[start].trim() === '') start++
  if (start >= body.length) throw badReq(`Update File ${opPath}: 没有 hunk`)

  // 如果第一行不是 @@,自动当作单 hunk(允许省略 @@)
  if (!body[start].startsWith('@@')) {
    return [parseHunkLines(body.slice(start), opPath)]
  }
  // 按 @@ 切分
  const hunks = []
  let cur = null
  for (let i = start; i < body.length; i++) {
    const ln = body[i]
    if (ln.startsWith('@@')) {
      if (cur) hunks.push(parseHunkLines(cur, opPath))
      cur = []
    } else {
      if (cur == null) {
        if (ln.trim() === '') continue
        throw badReq(`Update File ${opPath}: 第一个有效行不是 @@`)
      }
      cur.push(ln)
    }
  }
  if (cur) hunks.push(parseHunkLines(cur, opPath))
  if (hunks.length === 0) throw badReq(`Update File ${opPath}: hunks 为空`)
  return hunks
}

function parseHunkLines(rawLines, opPath) {
  // 去掉尾部空行
  const lines = [...rawLines]
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) throw badReq(`Update File ${opPath}: 空 hunk`)
  // 期望的旧内容 = 上下文 + 删除行
  // 期望的新内容 = 上下文 + 添加行
  const oldLines = []
  const newLines = []
  let additions = 0
  let deletions = 0
  for (const ln of lines) {
    if (ln === '') {
      // 视为上下文空行(diff 习惯)
      oldLines.push('')
      newLines.push('')
      continue
    }
    const sigil = ln[0]
    const rest = ln.slice(1)
    if (sigil === ' ') {
      oldLines.push(rest); newLines.push(rest)
    } else if (sigil === '-') {
      oldLines.push(rest); deletions++
    } else if (sigil === '+') {
      newLines.push(rest); additions++
    } else {
      throw badReq(`Update File ${opPath}: hunk 行必须以 ' '/'+'/'-' 开头,得到 "${ln}"`)
    }
  }
  if (additions === 0 && deletions === 0) {
    throw badReq(`Update File ${opPath}: hunk 必须至少有一个增/删行`)
  }
  return { oldLines, newLines, additions, deletions }
}

/* ─── 应用 hunk 到文件内容 ─── */

function applyHunks(original, hunks, opPath) {
  // 用换行切分,保留末尾空字符串(以便保留尾换行符)
  const hasTrailingNewline = original.endsWith('\n')
  const lines = hasTrailingNewline ? original.slice(0, -1).split('\n') : original.split('\n')

  let cursor = 0
  const out = []
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]
    const oldBlock = hunk.oldLines.join('\n')
    // 在 cursor 之后找 oldBlock 的位置(逐行匹配,避免子串误判)
    const pos = findHunkPosition(lines, hunk.oldLines, cursor)
    if (pos === -1) {
      throw badReq(`Update File ${opPath}: 第 ${h + 1} 个 hunk 在原文中找不到匹配位置,oldText 起头 "${oldBlock.slice(0, 80)}"`)
    }
    // 检查唯一性(同一 cursor 之后只能有一处)
    const dup = findHunkPosition(lines, hunk.oldLines, pos + 1)
    if (dup !== -1) {
      throw badReq(`Update File ${opPath}: 第 ${h + 1} 个 hunk 在原文中存在多处匹配,需要更多上下文行`)
    }
    // 写 cursor → pos 的未变化行
    for (let i = cursor; i < pos; i++) out.push(lines[i])
    // 写 new lines
    for (const nl of hunk.newLines) out.push(nl)
    cursor = pos + hunk.oldLines.length
  }
  // 剩余
  for (let i = cursor; i < lines.length; i++) out.push(lines[i])
  return out.join('\n') + (hasTrailingNewline ? '\n' : '')
}

function findHunkPosition(lines, oldLines, fromIdx) {
  if (oldLines.length === 0) return fromIdx
  outer: for (let i = fromIdx; i <= lines.length - oldLines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) {
      if (lines[i + j] !== oldLines[j]) continue outer
    }
    return i
  }
  return -1
}

/* ─── 主入口 ─── */

export async function applyPatchTool({ patch, dry_run = false, userId = null } = {}) {
  if (typeof patch !== 'string' || !patch.trim()) throw badReq('patch 必填')
  // ★ M3.5:限流(dry_run 不计费)
  if (!dry_run && userId && !patchLimiter.tryConsume(userId, 'apply_patch')) {
    throw badReq('apply_patch 限流:超过 60 次/分钟', 429)
  }

  const ops = parsePatch(patch)

  // 阶段 1:规划 — 算每个 op 的新内容,任何错误都抛
  const plans = []
  for (const op of ops) {
    if (op.kind === 'add') {
      const resolved = resolveInWorkspace(op.path, { userId })
      const abs = resolved.fullPath
      if (fs.existsSync(abs)) throw badReq(`Add File ${op.path}: 已存在,不能 add`, 409)
      plans.push({
        op: 'add',
        rawPath: op.path,
        path: resolved.displayPath,
        abs,
        oldContent: null,
        newContent: op.content,
        additions: op.content ? op.content.split('\n').length - (op.content.endsWith('\n') ? 1 : 0) : 0,
        deletions: 0,
      })
    } else if (op.kind === 'delete') {
      const resolved = resolveInWorkspace(op.path, { mustExist: true, userId })
      const abs = resolved.fullPath
      const stat = fs.statSync(abs)
      if (!stat.isFile()) throw badReq(`Delete File ${op.path}: 不是文件`)
      const oldContent = fs.readFileSync(abs, 'utf8')
      plans.push({
        op: 'delete',
        rawPath: op.path,
        path: resolved.displayPath,
        abs,
        oldContent,
        newContent: null,
        additions: 0,
        deletions: oldContent ? oldContent.split('\n').length - (oldContent.endsWith('\n') ? 1 : 0) : 0,
      })
    } else if (op.kind === 'update') {
      const resolved = resolveInWorkspace(op.path, { mustExist: true, userId })
      const abs = resolved.fullPath
      const stat = fs.statSync(abs)
      if (!stat.isFile()) throw badReq(`Update File ${op.path}: 不是文件`)
      if (stat.size > MAX_FILE_BYTES) throw badReq(`Update File ${op.path}: 超过 ${MAX_FILE_BYTES} 字节`, 413)
      const oldContent = fs.readFileSync(abs, 'utf8')
      const newContent = applyHunks(oldContent, op.hunks, op.path)
      const additions = op.hunks.reduce((s, h) => s + h.additions, 0)
      const deletions = op.hunks.reduce((s, h) => s + h.deletions, 0)
      plans.push({ op: 'update', rawPath: op.path, path: resolved.displayPath, abs, oldContent, newContent, additions, deletions })
    }
  }

  // 阶段 2:执行(或 dry-run)
  const changes = plans.map((p) => ({
    op: p.op,
    path: p.path,
    additions: p.additions,
    deletions: p.deletions,
    preview: makePreview(p),
  }))

  if (dry_run) {
    return { ok: true, dry_run: true, total: plans.length, changes }
  }

  // 真写:成功的入栈,失败回滚
  const undoStack = []
  try {
    for (const p of plans) {
      const abs = revalidatePlanPath(p, { userId })
      if (p.op === 'add') {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, p.newContent, 'utf8')
        undoStack.push({ op: 'add', rawPath: p.rawPath, abs })
      } else if (p.op === 'delete') {
        fs.unlinkSync(abs)
        undoStack.push({ op: 'delete', rawPath: p.rawPath, abs, oldContent: p.oldContent })
      } else if (p.op === 'update') {
        fs.writeFileSync(abs, p.newContent, 'utf8')
        undoStack.push({ op: 'update', rawPath: p.rawPath, abs, oldContent: p.oldContent })
      }
    }
    return { ok: true, dry_run: false, total: plans.length, changes }
  } catch (err) {
    // 回滚
    for (const u of undoStack.reverse()) {
      try {
        const abs = revalidatePlanPath(u, { userId, mustExist: u.op !== 'delete' })
        if (u.op === 'add') fs.unlinkSync(abs)
        else if (u.op === 'delete') fs.writeFileSync(abs, u.oldContent, 'utf8')
        else if (u.op === 'update') fs.writeFileSync(abs, u.oldContent, 'utf8')
      } catch {
        // 回滚失败也继续,日志层面无能为力
      }
    }
    const wrapped = new Error(`apply_patch 失败,已回滚: ${err.message}`, { cause: err })
    const denied = ['EACCES', 'EPERM', 'EROFS'].includes(err?.code)
    wrapped.code = denied ? 'FILESYSTEM_WRITE_DENIED' : (err?.code || 'APPLY_PATCH_WRITE_FAILED')
    wrapped.statusCode = denied ? 403 : (err?.statusCode || 500)
    wrapped.retryable = denied ? false : err?.retryable
    wrapped.path = err?.path
    if (denied) {
      wrapped.hint = '宿主文件系统拒绝了写入；不要改试同一根目录下的其他子目录，请先修复该目录的读写授权或 Windows ACL。'
    }
    throw wrapped
  }
}

function makePreview(plan) {
  if (plan.op === 'add') {
    return clipLines(plan.newContent || '', PREVIEW_LINES, '(新文件)')
  }
  if (plan.op === 'delete') {
    return clipLines(plan.oldContent || '', PREVIEW_LINES, '(将删除)')
  }
  // update: 输出 +A -B 简要 diff,不输出整个文件
  return shortDiff(plan.oldContent || '', plan.newContent || '', PREVIEW_LINES)
}

function clipLines(text, n, label) {
  const lines = text.split('\n')
  if (lines.length <= n) return `${label}\n${text}`
  return `${label}\n${lines.slice(0, n).join('\n')}\n... (${lines.length - n} more lines)`
}

function shortDiff(oldText, newText, maxLines) {
  const o = oldText.split('\n')
  const n = newText.split('\n')
  // 朴素 LCS-free:行级 myers 太重,这里用 同前缀/同后缀 → 中间整块替换 的近似
  let pre = 0
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++
  let suf = 0
  while (suf < o.length - pre && suf < n.length - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++
  const removed = o.slice(pre, o.length - suf)
  const added = n.slice(pre, n.length - suf)
  const ctxBefore = o.slice(Math.max(0, pre - 2), pre)
  const ctxAfter = o.slice(o.length - suf, Math.min(o.length, o.length - suf + 2))
  const out = []
  out.push(`@@ around line ${pre + 1} @@`)
  for (const c of ctxBefore) out.push(' ' + c)
  for (const r of removed) out.push('-' + r)
  for (const a of added) out.push('+' + a)
  for (const c of ctxAfter) out.push(' ' + c)
  if (out.length > maxLines) {
    return out.slice(0, maxLines).join('\n') + `\n... (${out.length - maxLines} more)`
  }
  return out.join('\n')
}

/* ─── tool spec + dispatcher ─── */

export const APPLY_PATCH_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Codex 风格多文件原子 patch.支持 Add/Update/Delete File 三种操作,Update 用 unified-diff hunks(@@ 分隔,空格=上下文,+ 添加,- 删除).比 edit_file 省 token,比 write_file 安全(不会覆盖已存在文件),所有文件全部成功才落盘,任一失败自动回滚.dry_run=true 时只预览不写.格式:\n*** Begin Patch\n*** Update File: path/to/file.ts\n@@\n unchanged\n-removed\n+added\n*** End Patch',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Codex 格式 patch 文本' },
          dry_run: { type: 'boolean', description: '默认 false.true 时只规划不写盘,返回 diff 预览' },
        },
        required: ['patch'],
      },
    },
  },
]

export async function dispatchApplyPatchTool(name, args, { userId = null } = {}) {
  if (name !== 'apply_patch') throw new Error(`unknown apply_patch tool: ${name}`)
  return applyPatchTool({ ...(args || {}), userId })
}
