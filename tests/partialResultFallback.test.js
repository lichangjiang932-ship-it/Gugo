import test from 'node:test'
import assert from 'node:assert/strict'

import { createPartialResultFallback } from '../server/services/partialResultFallback.js'

test('read_file interruption summary keeps only path and numeric metadata', () => {
  const fallback = createPartialResultFallback()
  fallback.record(
    { name: 'read_file', args: { path: 'D:\\project\\config.json' } },
    {
      ok: true,
      content: '{"apiKey":"sk-audit-secret","password":"do-not-leak"}',
      summary: 'apiKey=sk-audit-secret',
      bytes: 128,
    },
  )

  const result = fallback.apply({ interrupted: true, text: 'provider error' })
  assert.match(result.text, /read_file/)
  assert.match(result.text, /D:\\project\\config\.json/)
  assert.match(result.text, /bytes=128/)
  assert.doesNotMatch(result.text, /sk-audit-secret|do-not-leak|apiKey=/)
})

test('artifact summaries retain safe filenames and counts while redacting credentials', () => {
  const fallback = createPartialResultFallback()
  fallback.record(
    { name: 'create_html_app', args: { outputPath: 'D:\\site\\gallery.html' } },
    {
      ok: true,
      summary: '已生成 12 张图片；token=tkn_private_value',
      outputPath: 'D:\\site\\gallery.html?token=tkn_private_value',
      imageCount: 12,
    },
  )

  const text = fallback.apply({ interrupted: true }).text
  assert.match(text, /create_html_app/)
  assert.match(text, /gallery\.html/)
  assert.match(text, /imageCount=12/)
  assert.doesNotMatch(text, /tkn_private_value/)
})

test('snapshot is safe to persist and restore without reintroducing source text', () => {
  const first = createPartialResultFallback()
  first.record(
    { name: 'write_file', args: { path: 'D:\\out\\index.html' } },
    { ok: true, summary: '<html><script>secret()</script></html>', outputPath: 'D:\\out\\index.html' },
  )
  const snapshot = first.snapshot()
  assert.equal(snapshot.length, 1)
  assert.doesNotMatch(snapshot[0], /<html>|secret\(\)/)

  const restored = createPartialResultFallback({
    entries: [...snapshot, '```js\nconst token = "secret"\n```'],
  })
  const text = restored.apply({ interrupted: true }).text
  assert.match(text, /D:\\out\\index\.html/)
  assert.doesNotMatch(text, /const token|secret/)
})

test('successful tool with no safe details still records completion', () => {
  const fallback = createPartialResultFallback()
  fallback.record({ name: 'browser_click', args: {} }, { ok: true, data: 'private page source' })
  assert.deepEqual(fallback.snapshot(), ['browser_click 已成功完成。'])
})

test('incomplete summaries preserve the blocker and remain idempotent', () => {
  const fallback = createPartialResultFallback()
  fallback.record(
    { name: 'write_file', args: { path: 'D:\\out\\report.txt' } },
    { ok: true, outputPath: 'D:\\out\\report.txt' },
  )

  const first = fallback.apply({ incomplete: true, text: '验证尚未完成。' })
  const second = fallback.apply({ ...first, interrupted: true })
  assert.match(second.text, /^验证尚未完成。/)
  assert.equal(second.text.match(/已经完成的部分：/g)?.length, 1)
  assert.equal(second.text.match(/write_file/g)?.length, 1)
})

test('bounded summaries keep recent writes and verification over early reads', () => {
  const fallback = createPartialResultFallback({ maxEntries: 3 })
  for (let index = 1; index <= 3; index += 1) {
    fallback.record(
      { name: 'read_file', args: { path: `D:\\src\\input-${index}.txt` } },
      { ok: true, bytes: index },
    )
  }
  fallback.record(
    { name: 'write_file', args: { path: 'D:\\out\\final.txt' } },
    { ok: true, outputPath: 'D:\\out\\final.txt' },
  )
  fallback.record(
    { name: 'run_project_check', args: {} },
    { ok: true, summary: '测试通过' },
  )

  const snapshot = fallback.snapshot().join('\n')
  assert.match(snapshot, /write_file.*final\.txt/)
  assert.match(snapshot, /run_project_check.*测试通过/)
  assert.equal((snapshot.match(/read_file/g) || []).length, 1)
})
