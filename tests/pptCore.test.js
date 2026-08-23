/**
 * pptCore — 三套 PPT 通路共享层
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  HEAD_FONT, BODY_FONT, CJK_FONT,
  PREMIUM_THEMES, resolvePremiumTheme,
  escapeXml, normalizeBullets, injectEaFont, injectEaFontWithReceipt,
  SLIDE_W, SLIDE_H, BULLET_MAX_CHARS, BULLETS_PER_PAGE,
} from '../src/lib/pptCore.js'

test('字体常量都是跨端安全', () => {
  assert.equal(HEAD_FONT, 'Calibri')
  assert.equal(BODY_FONT, 'Calibri')
  assert.equal(CJK_FONT, 'Microsoft YaHei')
})

test('16:9 宽屏尺寸', () => {
  assert.equal(SLIDE_W, 13.333)
  assert.equal(SLIDE_H, 7.5)
})

test('PREMIUM_THEMES 4 套都齐', () => {
  for (const k of ['noir', 'paper', 'ocean', 'forest']) {
    const t = PREMIUM_THEMES[k]
    assert.ok(t, `${k} 缺失`)
    for (const field of ['bg', 'panel', 'card', 'text', 'soft', 'muted', 'accent', 'accentSoft', 'line']) {
      assert.match(t[field], /^[0-9A-Fa-f]{6}$/, `${k}.${field} 不是 6 位 hex`)
    }
  }
})

test('resolvePremiumTheme 关键词路由', () => {
  assert.equal(resolvePremiumTheme('Q3 银行投研报告'), PREMIUM_THEMES.ocean)
  assert.equal(resolvePremiumTheme('ESG 与碳中和路径'), PREMIUM_THEMES.forest)
  assert.equal(resolvePremiumTheme('品牌手册'), PREMIUM_THEMES.paper)
  assert.equal(resolvePremiumTheme('随便什么主题'), PREMIUM_THEMES.noir)
})

test('escapeXml 处理所有 5 个保留字符', () => {
  assert.equal(escapeXml('<a href="x" \'b\' & c>'), '&lt;a href=&quot;x&quot; &apos;b&apos; &amp; c&gt;')
})

test('normalizeBullets 自动截断 + 限数', () => {
  const long = '这是一条非常长的 bullet'.repeat(20)
  const out = normalizeBullets({ bullets: [long, 'A', 'B', 'C', 'D', 'E', 'F'] })
  assert.equal(out.length, BULLETS_PER_PAGE, '最多 5 条')
  assert.ok(out[0].length <= BULLET_MAX_CHARS, '长 bullet 被截断')
  assert.ok(out[0].endsWith('…'), '截断有省略号')
})

test('normalizeBullets 从 body 字段 fallback 解析', () => {
  const out = normalizeBullets({ body: '- 一\n- 二\n- 三' })
  assert.deepEqual(out, ['一', '二', '三'])
})

test('injectEaFont 把 Microsoft YaHei 写进 theme1.xml', async () => {
  // 造一个最小 pptx 骨架（带 theme1.xml）
  const zip = new JSZip()
  const themeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Calibri"/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
  </a:fontScheme></a:themeElements>
</a:theme>`
  zip.file('ppt/theme/theme1.xml', themeXml)
  const buf = await zip.generateAsync({ type: 'uint8array' })
  const out = await injectEaFont(buf, 'Microsoft YaHei')
  // 解开看
  const z2 = await JSZip.loadAsync(out)
  const after = await z2.file('ppt/theme/theme1.xml').async('string')
  assert.match(after, /<a:ea typeface="Microsoft YaHei"\/>/)
  // major 和 minor 都有
  assert.equal((after.match(/Microsoft YaHei/g) || []).length, 2)
})

test('injectEaFont 重复注入不会重复 a:ea', async () => {
  const zip = new JSZip()
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="SimSun"/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
  </a:fontScheme></a:themeElements>
</a:theme>`)
  const buf = await zip.generateAsync({ type: 'uint8array' })
  const out = await injectEaFont(buf, 'Microsoft YaHei')
  const z2 = await JSZip.loadAsync(out)
  const after = await z2.file('ppt/theme/theme1.xml').async('string')
  // SimSun 应被替换为 Microsoft YaHei，不应有两个 a:ea
  assert.ok(!after.includes('SimSun'))
  assert.match(after, /<a:ea typeface="Microsoft YaHei"\/>/)
})

test('injectEaFontWithReceipt 区分首次注入与已存在字体', async () => {
  const zip = new JSZip()
  zip.file('ppt/theme/theme1.xml', `<a:theme><a:themeElements><a:fontScheme>
    <a:majorFont><a:latin typeface="Calibri"/></a:majorFont>
    <a:minorFont><a:latin typeface="Calibri"/></a:minorFont>
  </a:fontScheme></a:themeElements></a:theme>`)
  const initial = await zip.generateAsync({ type: 'uint8array' })
  const injected = await injectEaFontWithReceipt(initial, CJK_FONT)
  const alreadyPresent = await injectEaFontWithReceipt(injected.bytes, CJK_FONT)

  assert.equal(injected.status, 'injected')
  assert.equal(alreadyPresent.status, 'alreadyPresent')
  assert.equal(Object.hasOwn(alreadyPresent, 'warning'), false)
})

test('injectEaFont 失败时不抛错', async () => {
  // 给个坏的 buffer（不是 zip），应该原样返回 Uint8Array
  const garbage = new Uint8Array([1, 2, 3, 4, 5])
  const out = await injectEaFont(garbage, 'Microsoft YaHei')
  assert.ok(out instanceof Uint8Array)
})

test('injectEaFontWithReceipt 暴露有界失败诊断', async () => {
  const result = await injectEaFontWithReceipt(new Uint8Array([1, 2, 3]), CJK_FONT)
  assert.equal(result.status, 'failed')
  assert.ok(result.bytes instanceof Uint8Array)
  assert.ok(result.warning.length <= 200)
})
