import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractArtifacts,
  splitByArtifacts,
  isSafeArtifactPath,
} from '../src/lib/artifactMarker.js'

test('artifactMarker 单个裸 marker 命中', () => {
  const out = extractArtifacts('请看 [report-2026.pptx] 这个文件')
  assert.equal(out.length, 1)
  assert.equal(out[0].file, 'report-2026.pptx')
  assert.equal(out[0].type, 'pptx')
  assert.equal(out[0].source, 'bare')
})

test('artifactMarker 多个 marker (link + 裸 + 不同后缀)', () => {
  const md = '看 [a.pptx] 和 [周报](weekly.docx), 再看 [扫描件.pdf]'
  const out = extractArtifacts(md)
  assert.equal(out.length, 3)
  // 升序
  assert.ok(out[0].start < out[1].start)
  assert.ok(out[1].start < out[2].start)
  const files = out.map((o) => o.file).sort()
  assert.deepEqual(files, ['a.pptx', 'weekly.docx', '扫描件.pdf'])
})

test('artifactMarker 无 marker 时返回空', () => {
  assert.deepEqual(extractArtifacts('就是普通一段文字, 没有附件'), [])
  assert.deepEqual(extractArtifacts(''), [])
  assert.deepEqual(extractArtifacts(null), [])
})

test('artifactMarker 嵌入段落不误伤 [像这种 PPT] 描述', () => {
  // 没有合法后缀的方括号文本 → 不命中
  const out = extractArtifacts('参考 [像这种 PPT] 风格, 或者 [TODO] 修一下')
  assert.equal(out.length, 0)
})

test('artifactMarker 路径白名单 / 拒绝危险输入', () => {
  // 危险路径全部拒绝
  assert.equal(extractArtifacts('[/etc/passwd.pptx]').length, 0)
  assert.equal(extractArtifacts('[../secret.pptx]').length, 0)
  assert.equal(extractArtifacts('[a/../b.pptx]').length, 0)
  // 后缀不在白名单
  assert.equal(extractArtifacts('[malware.exe]').length, 0)
  assert.equal(extractArtifacts('[script.js]').length, 0)
  // link 形式同样校验 target, label 安全的也不算
  assert.equal(extractArtifacts('[看这里](http://x.com/evil.pptx)').length, 0)
  assert.equal(extractArtifacts('[看这里](../../etc/x.pptx)').length, 0)
  // 超长拒绝
  const long = 'a'.repeat(250) + '.pptx'
  assert.equal(extractArtifacts(`[${long}]`).length, 0)
})

test('artifactMarker splitByArtifacts 交错切片', () => {
  const md = '前 [a.pptx] 中 [b.pdf] 尾'
  const parts = splitByArtifacts(md)
  // text, artifact, text, artifact, text
  assert.equal(parts.length, 5)
  assert.equal(parts[0].kind, 'text')
  assert.equal(parts[0].value, '前 ')
  assert.equal(parts[1].kind, 'artifact')
  assert.equal(parts[1].value.file, 'a.pptx')
  assert.equal(parts[2].kind, 'text')
  assert.equal(parts[3].kind, 'artifact')
  assert.equal(parts[3].value.file, 'b.pdf')
  assert.equal(parts[4].kind, 'text')
})

test('isSafeArtifactPath 边界', () => {
  assert.ok(isSafeArtifactPath('a.pptx'))
  assert.ok(isSafeArtifactPath('sub/a.pdf'))
  assert.ok(isSafeArtifactPath('周报-2026.docx'))
  assert.equal(isSafeArtifactPath(''), false)
  assert.equal(isSafeArtifactPath('a.exe'), false)
  assert.equal(isSafeArtifactPath('/a.pptx'), false)
  assert.equal(isSafeArtifactPath('a..b.pptx'), false)
  assert.equal(isSafeArtifactPath('a b.pptx'), false) // 空格不在 SAFE_CHAR
  assert.equal(isSafeArtifactPath(null), false)
})
