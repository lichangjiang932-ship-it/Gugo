/**
 * G1.2 验收: createPptx premium pipeline
 *   - layout 选择正确（chart/kpi/section/cover/end）
 *   - bullets 自动截断
 *   - cover 用 deck title 而不是 slide.title
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

test('cover 用 deck title，而不是 slide[0].title', async () => {
  const r = await createPptx({
    title: '2026 增长策略',
    subtitle: '从规模到效率',
    slides: [
      { title: '封面' }, // 故意叫"封面"，cover 应该用 deck title
      { title: '现状', bullets: ['MAU 320万', 'ARR 增长 47%'] },
    ],
  })
  const [slide1] = await loadSlides(r.fullPath)
  assert.ok(slide1.includes('2026 增长策略'), 'cover 应渲染 deck title')
  assert.ok(slide1.includes('从规模到效率'), 'cover 应渲染 subtitle')
  // "封面"这俩字不应该作为大标题出现
  assert.ok(!/sz="5600"[^<]*<a:t>封面/.test(slide1.replace(/\s+/g, '')), 'cover 不应把 slide.title="封面" 当大字')
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

test('bullets 过长自动截断（不会把 200 字塞进一行）', async () => {
  const longBullet = '这是一条非常非常非常长的 bullet，它会被自动截断到 60 字符以内，'.repeat(5)
  const r = await createPptx({
    title: '测试',
    slides: [
      { title: '封面' },
      { title: '长 bullet', bullets: [longBullet] },
    ],
  })
  const slides = await loadSlides(r.fullPath)
  // 检查渲染出来的字符串不应该把整段 longBullet 完整放进去
  assert.ok(!slides[1].includes(longBullet), 'bullet 应被截断，不能完整出现')
  assert.ok(slides[1].includes('…'), '应包含省略号')
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

test('end layout 不画 footer（节奏更稳）', async () => {
  const r = await createPptx({
    title: '测试',
    slides: [
      { title: '封面' },
      { title: '内容', bullets: ['一条'] },
      { title: '感谢观看', layout: 'end' },
    ],
  })
  const slides = await loadSlides(r.fullPath)
  // 中间那页（content）应该有页码 "02 / 03"；end 页（最后）不应该有
  assert.ok(slides[1].includes('02 / 03'), '中间页应有页码')
  assert.ok(!slides[2].includes('03 / 03'), 'end 页不应渲染页码')
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
