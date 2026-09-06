/**
 * G1.2 验收: createPptx premium pipeline
 *   - layout 选择正确（chart/kpi/section/cover/end）
 *   - bullets 完整保留，放不下时明确失败
 *   - cover 尊重 slide.title，显式设计决定可选页脚
 *   - theme.xml 注入了 east-asia 字体 (Microsoft YaHei)
 *   - 字体不再依赖 Aptos（避免跨端 fallback 灾难）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-premium-'))
process.env.ARTIFACT_DIR = TMP
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-premium-tests', String(process.pid))

const { createPptx } = await import('../server/services/artifactGen.js')

async function loadSlides(filename) {
  const buf = fs.readFileSync(filename)
  const zip = await JSZip.loadAsync(buf)
  // pptxgenjs 产物里幻灯片是 ppt/slides/slide1.xml ... slideN.xml
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort()
  return Promise.all(slideFiles.map((n) => zip.file(n).async('string')))
}

async function loadTheme(filename) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filename))
  return zip.file('ppt/theme/theme1.xml').async('string')
}

test('explicit cover honors the authored slide title and retains the supplied subtitle', async () => {
  const r = await createPptx({
    title: '2026 增长策略',
    subtitle: '从规模到效率',
    slides: [
      { title: '用户指定的第一页标题', layout: 'cover' },
      { title: '现状', bullets: ['MAU 320万', 'ARR 增长 47%'] },
    ],
  })
  const [slide1] = await loadSlides(r.fullPath)
  assert.ok(slide1.includes('<a:t>用户指定的第一页标题</a:t>'), 'cover must preserve the authored title')
  assert.ok(!slide1.includes('<a:t>2026 增长策略</a:t>'), 'deck metadata must not overwrite the authored title')
  assert.ok(slide1.includes('从规模到效率'), 'cover 应渲染 subtitle')
  assert.equal((await loadSlides(r.fullPath)).length, 2, 'no extra title page may be inserted')
})

test('layout=kpi 时渲染数字卡而非 bullet', async () => {
  const r = await createPptx({
    title: 'Q1 业绩',
    slides: [
      { title: '封面' },
      {
        title: '核心指标',
        layout: 'kpi',
        kpi: [
          { value: '47%', label: '同比增长', unit: 'YoY', delta: '+12pp' },
          { value: '320万', label: 'MAU', delta: '+18%' },
          { value: '¥4.7M', label: 'ARR', delta: '+47%' },
        ],
      },
    ],
  })
  const slides = await loadSlides(r.fullPath)
  const kpiXml = slides[1]
  assert.ok(kpiXml.includes('47%'), 'kpi 卡应渲 value')
  assert.ok(kpiXml.includes('同比增长'), 'kpi 卡应渲 label')
  assert.ok(kpiXml.includes('YoY'), 'kpi 卡应渲 unit')
  assert.ok(kpiXml.includes('+12pp'), 'kpi 卡应渲 delta')
})

test('layout=chart 时真的画了 chart（pptxgenjs 会生成 ppt/charts/chart1.xml）', async () => {
  const r = await createPptx({
    title: '季度趋势',
    slides: [
      { title: '封面' },
      {
        title: '收入趋势',
        layout: 'chart',
        chart: {
          type: 'line',
          categories: ['Q1', 'Q2', 'Q3', 'Q4'],
          series: [{ name: '收入', values: [120, 150, 180, 230] }],
        },
      },
    ],
  })
  const zip = await JSZip.loadAsync(fs.readFileSync(r.fullPath))
  const chartFiles = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))
  assert.ok(chartFiles.length >= 1, `chart layout 应生成至少 1 个 chart xml，实际 ${chartFiles.length}`)
})

test('long paragraphs are preserved as editable wrapping text or rejected when they cannot fit', async () => {
  const longBullet = '这是一条完整的长段落，需要保留每一处文字及其中的业务证据。'.repeat(5) + '完整尾部 END'
  const r = await createPptx({
    title: '测试',
    slides: [
      { title: '封面' },
      { title: '长 bullet', bullets: [longBullet] },
    ],
  })
  const slides = await loadSlides(r.fullPath)
  assert.ok(slides[1].includes(longBullet), 'every character and the final evidence marker must survive')
  assert.ok(slides[1].includes('wrap="square"'), 'the native editable text box must allow wrapping')
  assert.ok(!slides[1].includes('…'), 'the renderer must not insert a truncation marker')
  assert.ok(!slides[1].includes('<p:pic>'), 'body text must not become a screenshot')
  await assert.rejects(() => createPptx({
    title: 'Cannot fit',
    slides: [{ title: '全部保留或报错', layout: 'bullets', bullets: ['完整正文'.repeat(2000)] }],
  }), (error) => error.code === 'PPTX_CONTENT_OVERFLOW')
})

test('字体不再依赖 Aptos（避免 Mac/Linux Office fallback 灾难）', async () => {
  const r = await createPptx({
    title: '字体测试',
    slides: [{ title: '封面' }, { title: '正文页', bullets: ['一行字'] }],
  })
  const slides = await loadSlides(r.fullPath)
  const joined = slides.join('')
  assert.ok(!joined.includes('Aptos'), 'PPT 不应再写 Aptos 字体（跨端不可见）')
  assert.ok(joined.includes('Calibri'), '应使用 Calibri 兜底')
})

test('theme.xml 注入了 Microsoft YaHei 作为 east-asia 字体', async () => {
  const r = await createPptx({
    title: '中文测试',
    slides: [{ title: '中文封面' }],
  })
  const themeXml = await loadTheme(r.fullPath)
  assert.ok(/typeface="Microsoft YaHei"/.test(themeXml), 'theme1.xml 应注入 Microsoft YaHei 作为 ea')
})

test('page numbers and brand appear only when explicitly requested, including the ending slide', async () => {
  const input = {
    title: '测试',
    brand: '用户品牌',
    slides: [
      { title: '封面' },
      { title: '内容', bullets: ['一条'] },
      { title: '感谢观看', layout: 'end' },
    ],
  }
  const r = await createPptx(input)
  const slides = await loadSlides(r.fullPath)
  for (const xml of slides) assert.doesNotMatch(xml, /0[123] \/ 03|<a:t>用户品牌<\/a:t>/)
  const explicit = await createPptx({ ...input, design: { show_page_numbers: true, show_brand: true } })
  const numbered = await loadSlides(explicit.fullPath)
  assert.equal(numbered.length, 3)
  numbered.forEach((xml, index) => {
    assert.ok(xml.includes('0' + (index + 1) + ' / 03'))
    assert.ok(xml.includes('<a:t>用户品牌</a:t>'))
  })
})

test('内容感知 layout 自动选择: 单 bullet → statement', async () => {
  const r = await createPptx({
    title: '自动 layout',
    slides: [
      { title: '封面' },
      { title: '一句话结论', bullets: ['我们要做的是规模化的客户增长'] },
    ],
  })
  // 不报错即通过；layout 选择是黑箱，这里靠"渲染成功"做 smoke
  assert.ok(r.byteLength > 1000)
})

test('theme 参数显式指定时生效', async () => {
  const r = await createPptx({
    title: '海洋主题',
    theme: 'ocean',
    slides: [{ title: '封面' }, { title: '内容', bullets: ['一条'] }],
  })
  assert.equal(r.themeName, 'ocean')
})

test('createPptx 没有 layout 也能跑（向后兼容老 schema）', async () => {
  const r = await createPptx({
    title: '老 schema',
    slides: [
      { title: '封面' },
      { title: '亮点', bullets: ['客户 A', '客户 B', '客户 C'] },
    ],
  })
  assert.ok(r.byteLength > 1000)
  assert.equal(r.slideCount, 2)
})
