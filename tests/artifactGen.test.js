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

// 用临时目录,跑完清理
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'))
process.env.ARTIFACT_DIR = TMP
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-artifact-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { createPptx, createDocx, createXlsx, getArtifactDir } = await import('../server/artifactGen.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

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
    /非空 sheet/,
  )
})

test('artifact 文件名格式安全(只含字母数字-.)', async () => {
  const r = await createPptx({ title: 'x', slides: [{ title: 'a', bullets: [] }] })
  assert.match(r.filename, /^[\w.-]+\.pptx$/, '文件名应只含安全字符')
})

test('generated artifacts are downloadable from /api/artifacts/* with auth', async () => {
  // 起 mock OpenAI 兼容服务器(default executor 用 callBackgroundModel)
  const http = await import('node:http')
  const mockModel = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '这是测试生成的内容。' } }],
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
    assert.equal(detail.job.status, 'completed', `job status: ${detail?.job?.status}`)
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
