import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyPatchTool, parsePatch } from '../server/utils/applyPatch.js'

let tmpRoot
let savedWs

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-patch-'))
  savedWs = process.env.WORKSPACE_ROOT
  process.env.WORKSPACE_ROOT = tmpRoot
})

after(() => {
  if (savedWs == null) delete process.env.WORKSPACE_ROOT
  else process.env.WORKSPACE_ROOT = savedWs
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // 清空 fixtures
  for (const f of fs.readdirSync(tmpRoot)) {
    fs.rmSync(path.join(tmpRoot, f), { recursive: true, force: true })
  }
})

function writeFile(rel, content) {
  const abs = path.join(tmpRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}
function readFile(rel) {
  return fs.readFileSync(path.join(tmpRoot, rel), 'utf8')
}
function exists(rel) {
  return fs.existsSync(path.join(tmpRoot, rel))
}

/* ─── parser ─── */

test('parsePatch: 基础结构校验', () => {
  assert.throws(() => parsePatch('no header'), /Begin Patch/)
  assert.throws(() => parsePatch('*** Begin Patch\n'), /End Patch/)
  assert.throws(() => parsePatch('*** Begin Patch\n*** End Patch'), /任何操作/)
})

test('parsePatch: 路径重复拒绝', () => {
  assert.throws(() => parsePatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Delete File: a.txt
*** End Patch`), /路径重复/)
})

test('parsePatch: Add File 必须 + 开头', () => {
  assert.throws(() => parsePatch(`*** Begin Patch
*** Add File: a.txt
hello
*** End Patch`), /\+ 开头/)
})

/* ─── Add ─── */

test('apply_patch: Add File 写入新文件', async () => {
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Add File: src/new.js
+const x = 1
+export default x
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 1)
  assert.equal(r.changes[0].op, 'add')
  assert.equal(readFile('src/new.js'), 'const x = 1\nexport default x\n')
})

test('apply_patch: Add File 已存在 → 拒绝', async () => {
  writeFile('a.txt', 'old')
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Add File: a.txt
+new
*** End Patch`,
    }),
    /已存在/
  )
  assert.equal(readFile('a.txt'), 'old')
})

/* ─── Delete ─── */

test('apply_patch: Delete File 移除文件', async () => {
  writeFile('a.txt', 'bye')
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Delete File: a.txt
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(exists('a.txt'), false)
})

test('apply_patch: Delete File 不存在 → 拒绝', async () => {
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Delete File: ghost.txt
*** End Patch`,
    }),
    /不存在/
  )
})

/* ─── Update ─── */

test('apply_patch: Update File 单 hunk 替换', async () => {
  writeFile('a.txt', 'line1\nline2\nline3\n')
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Update File: a.txt
@@
 line1
-line2
+LINE2
 line3
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(r.changes[0].additions, 1)
  assert.equal(r.changes[0].deletions, 1)
  assert.equal(readFile('a.txt'), 'line1\nLINE2\nline3\n')
})

test('apply_patch: Update File 多 hunk', async () => {
  writeFile('a.txt', 'a\nb\nc\nd\ne\nf\ng\n')
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Update File: a.txt
@@
 a
-b
+B
 c
@@
 e
-f
+F
 g
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(readFile('a.txt'), 'a\nB\nc\nd\ne\nF\ng\n')
})

test('apply_patch: Update File 纯添加(无删除)', async () => {
  writeFile('a.txt', 'a\nb\n')
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Update File: a.txt
@@
 a
+inserted
 b
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(readFile('a.txt'), 'a\ninserted\nb\n')
})

test('apply_patch: Update File hunk 找不到匹配 → 拒绝', async () => {
  writeFile('a.txt', 'real\ncontent\n')
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
 wrong
-content
+new
*** End Patch`,
    }),
    /找不到匹配/
  )
  assert.equal(readFile('a.txt'), 'real\ncontent\n', '失败时不写盘')
})

test('apply_patch: Update File hunk 多处匹配 → 拒绝', async () => {
  writeFile('a.txt', 'x\nDUP\nx\nDUP\nx\n')
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
-DUP
+CHANGED
*** End Patch`,
    }),
    /多处匹配/
  )
})

test('apply_patch: Update File 不存在 → 拒绝', async () => {
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Update File: ghost.txt
@@
-a
+b
*** End Patch`,
    }),
    /不存在/
  )
})

/* ─── 多文件原子性 ─── */

test('apply_patch: 多文件 — 一个失败,全部不写', async () => {
  writeFile('a.txt', 'old-a\n')
  writeFile('b.txt', 'old-b\n')
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
-old-a
+new-a
*** Update File: b.txt
@@
-WRONG
+new-b
*** End Patch`,
    }),
    /找不到/
  )
  assert.equal(readFile('a.txt'), 'old-a\n', 'a 不应被写')
  assert.equal(readFile('b.txt'), 'old-b\n', 'b 不应被写')
})

test('apply_patch: 多文件 Add+Update+Delete 组合成功', async () => {
  writeFile('keep.txt', 'k1\nk2\n')
  writeFile('bye.txt', 'goodbye\n')
  const r = await applyPatchTool({
    patch: `*** Begin Patch
*** Add File: new.js
+console.log(1)
*** Update File: keep.txt
@@
 k1
-k2
+K2
*** Delete File: bye.txt
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 3)
  assert.equal(readFile('new.js'), 'console.log(1)\n')
  assert.equal(readFile('keep.txt'), 'k1\nK2\n')
  assert.equal(exists('bye.txt'), false)
})

/* ─── dry_run ─── */

test('apply_patch: dry_run 不落盘但返回 preview', async () => {
  writeFile('a.txt', 'a\nb\n')
  const r = await applyPatchTool({
    dry_run: true,
    patch: `*** Begin Patch
*** Update File: a.txt
@@
 a
-b
+B
*** End Patch`,
  })
  assert.equal(r.ok, true)
  assert.equal(r.dry_run, true)
  assert.equal(readFile('a.txt'), 'a\nb\n', '不应写盘')
  assert.ok(r.changes[0].preview.includes('-b'))
  assert.ok(r.changes[0].preview.includes('+B'))
})

/* ─── 沙箱 ─── */

test('apply_patch: 路径越界拒绝', async () => {
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Add File: /etc/passwd
+hacked
*** End Patch`,
    }),
    /路径越界/
  )
  // 也用 ../ 试
  await assert.rejects(
    () => applyPatchTool({
      patch: `*** Begin Patch
*** Add File: ../escaped
+x
*** End Patch`,
    }),
    /路径越界/
  )
})

test('apply_patch: patch 非法/空拒绝', async () => {
  await assert.rejects(() => applyPatchTool({}), /必填/)
  await assert.rejects(() => applyPatchTool({ patch: '' }), /必填/)
  await assert.rejects(() => applyPatchTool({ patch: 'nope' }), /Begin Patch/)
})
