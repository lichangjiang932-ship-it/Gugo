import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'

const temporaryParent = fs.realpathSync(os.tmpdir())
const testRoot = fs.mkdtempSync(path.join(temporaryParent, 'gugo-pptx-prompt-experience-'))
process.env.APP_DATA_DIR = path.join(testRoot, 'data')
process.env.APP_DB_PATH = path.join(testRoot, 'data', 'app.db')
process.env.ARTIFACT_DIR = path.join(testRoot, 'artifacts')
process.env.YMA_TEST_DEFAULT_OUTPUT_DIR = path.join(testRoot, 'output')
process.env.WORKSPACE_ROOT = path.join(testRoot, 'workspace')
fs.mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true })

const { closeDb, createUser } = await import('../server/db.js')
const { getArtifactDir } = await import('../server/services/artifactGen.js')
const { setDefaultOutputDirectory, grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { getTurnArtifactById, listSessionTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const { readArtifactSourceSnapshot } = await import('../server/services/artifactSourceStore.js')
const { executeGeneratedArtifactTool } = await import('../server/services/loop/heuristics/generatedArtifactExecutor.js')
const { executeServerTool } = await import('../server/services/loop/heuristics/toolExecutor.js')

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)

test.after(() => {
  closeDb()
  const resolved = path.resolve(testRoot)
  assert.ok(resolved.startsWith(`${temporaryParent}${path.sep}`))
  assert.ok(path.basename(resolved).startsWith('gugo-pptx-prompt-experience-'))
  fs.rmSync(resolved, { recursive: true, force: true })
})

function turnJob(userId, sessionId, prompt) {
  const id = randomUUID()
  appendTurnEvent({
    userId,
    event: createTurnEvent({ id: randomUUID(), sessionId, turnId: id, sequence: 0, type: 'turn.started', payload: { content: prompt } }),
  })
  return { id, userId, sessionId, origin: 'chat', prompt, userPrompt: prompt }
}

function scope(label) {
  const userId = `pptx-user-${randomUUID()}`
  const sessionId = `pptx-session-${randomUUID()}`
  createUser({ id: userId, email: `${userId}@example.test` })
  upsertSession({ id: sessionId, userId, title: label })
  const outputDirectory = path.join(testRoot, 'output', userId)
  setDefaultOutputDirectory({ userId, rootPath: outputDirectory })
  return {
    userId, sessionId, outputDirectory,
    job: turnJob(userId, sessionId, '生成1页PPT，不要封面，白底红字，保留指定字体、原生三列表格和全部原文。'),
  }
}

function requestedDeck() {
  return {
    title: 'User-directed single-slide table',
    brand: 'This supplied metadata must not become visible chrome',
    design: {
      background: 'FFFFFF', foreground: 'CC0000', accent: 'CC0000',
      secondary: 'FFFFFF', muted: 'CC0000',
      heading_font: 'Arial', body_font: 'SimSun', east_asian_font: 'SimSun',
      heading_font_size: 24, body_font_size: 16, aspect_ratio: '4:3',
      show_page_numbers: false, show_brand: false, show_date: false,
    },
    slides: [{
      elements: [
        { type: 'text', x: 0.05, y: 0.04, w: 0.9, h: 0.2, font_face: 'Arial', font_size: 24, text: '课程比较表：每一行都是用户要求保留的原始内容' },
        {
          type: 'table', x: 0.05, y: 0.3, w: 0.9, h: 0.6,
          font_size: 16, fill: 'FFFFFF', header_fill: 'FFFFFF', header_color: 'CC0000', line_color: 'CC0000',
          table: {
            header: true,
            column_widths: [0.18, 0.22, 0.6],
            rows: [
              ['项目', '原始数据', '说明'],
              ['语文', '27', '保留标点 A&B <内容>'],
              ['科学', '0', '缺失资料应注明，不补造数值'],
              ['术语', '12.50%', '这些文字必须完整保留到最终文件'],
            ],
          },
        },
      ],
    }],
  }
}

function generate(current, args, job = current.job) {
  return executeGeneratedArtifactTool({ name: 'create_pptx', args, job, step: { id: job.id, kind: 'chat' }, requiresLocalArtifactDelivery: true })
}

const nodes = (element, namespace, name) => [...element.getElementsByTagNameNS(namespace, name)]

async function inspectPptx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort()
  assert.equal(slides.length, 1, 'the real file must contain one total slide, with no generated cover/end')
  const parse = async (name) => new JSDOM(await zip.file(name).async('string'), { contentType: 'application/xml' }).window.document
  return { slide: await parse(slides[0]), presentation: await parse('ppt/presentation.xml'), theme: await parse('ppt/theme/theme1.xml') }
}

function assertRequestedAppearance(pkg, args) {
  const [background] = nodes(pkg.slide, PRESENTATION_NS, 'bg')
  assert.equal(nodes(background, DRAWING_NS, 'srgbClr')[0].getAttribute('val'), 'FFFFFF')
  const size = nodes(pkg.presentation, PRESENTATION_NS, 'sldSz')[0]
  assert.equal(Number(size.getAttribute('cx')) / Number(size.getAttribute('cy')), 4 / 3)
  const textNodes = nodes(pkg.slide, DRAWING_NS, 't')
  const expected = [args.slides[0].elements[0].text, ...args.slides[0].elements[1].table.rows.flat()]
  assert.deepEqual(textNodes.map((node) => node.textContent), expected, 'all requested words/cells survive with no invented chrome')
  for (const node of textNodes) {
    const properties = nodes(node.parentElement, DRAWING_NS, 'rPr')[0]
    assert.equal(nodes(properties, DRAWING_NS, 'srgbClr')[0].getAttribute('val'), 'CC0000')
  }
  const fonts = new Set(nodes(pkg.slide, DRAWING_NS, 'latin').map((node) => node.getAttribute('typeface')))
  assert.ok(fonts.has('Arial'))
  assert.ok(fonts.has('SimSun'))
  const eastAsianFonts = nodes(pkg.theme, DRAWING_NS, 'ea')
  assert.ok(eastAsianFonts.length >= 2)
  assert.ok(eastAsianFonts.every((node) => node.getAttribute('typeface') === 'SimSun'))
  const tables = nodes(pkg.slide, DRAWING_NS, 'tbl')
  assert.equal(tables.length, 1, 'the published file must contain exactly one native editable table')
  const [table] = tables
  assert.equal(nodes(table, DRAWING_NS, 'gridCol').length, 3)
  assert.equal(nodes(table, DRAWING_NS, 'tr').length, args.slides[0].elements[1].table.rows.length)
  assert.equal(nodes(pkg.slide, PRESENTATION_NS, 'pic').length, 0)
}

async function readSourceThroughTool(current, artifactId, limit = 241) {
  let offset = 0
  let source = ''
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const result = await executeServerTool({
      name: 'read_artifact_source', args: { artifact_id: artifactId, offset, limit },
      job: current.job, step: { id: current.job.id, kind: 'chat' },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.sourceFormat, 'artifact_tool_arguments_json')
    source += result.content
    if (result.complete) return JSON.parse(source)
    assert.ok(result.nextOffset > offset)
    offset = result.nextOffset
  }
  assert.fail('source reader must finish within its bounded paging window')
}

test('the real generated PPTX tool preserves one-page design, native three-column data and all supplied text', async () => {
  const current = scope('one-page design')
  const args = requestedDeck()
  const originalArgs = structuredClone(args)
  const result = await generate(current, args)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.deliveryStatus, 'delivered')
  assert.equal(path.dirname(result.path), current.outputDirectory)
  const artifact = getTurnArtifactById({ id: result.artifactId, ...current })
  assert.equal(artifact.type, 'pptx')
  assert.equal(artifact.turnId, current.job.id)
  const managedPath = path.join(getArtifactDir(), artifact.filename)
  assert.deepEqual(fs.readFileSync(managedPath), fs.readFileSync(result.path))
  assert.deepEqual(args, originalArgs, 'the real renderer must not rewrite model-authored input')
  assertRequestedAppearance(await inspectPptx(result.path), originalArgs)
  const snapshot = readArtifactSourceSnapshot(result.artifactId)
  assert.deepEqual(JSON.parse(snapshot.source), originalArgs)
  assert.deepEqual(await readSourceThroughTool(current, result.artifactId), originalArgs)
  assert.equal(listSessionTurnArtifacts(current).length, 1)
})

test('reading and updating the real source replaces the same PPTX while retaining design and untouched cells', async () => {
  const current = scope('source replacement')
  const first = await generate(current, requestedDeck())
  assert.equal(first.ok, true, JSON.stringify(first))
  const beforeBytes = fs.readFileSync(first.path)
  const originalSource = await readSourceThroughTool(current, first.artifactId)
  const revisedSource = structuredClone(originalSource)
  revisedSource.slides[0].elements[0].text = '更新后的课程比较表：原始文字与指定样式保持不变'
  revisedSource.slides[0].elements[1].table.rows.push(['历史', '41', '追加行也应可编辑且完整'])
  const job = turnJob(current.userId, current.sessionId, '更新原PPT的标题与最后一行，替换原文件，保留所有设计与其他数据。')
  const result = await generate(current, { ...revisedSource, replace_artifact_id: first.artifactId }, job)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.replaced, true)
  assert.equal(result.artifactId, first.artifactId)
  assert.equal(result.filename, first.filename)
  assert.equal(result.path, first.path)
  assert.equal(fs.readFileSync(result.path).equals(beforeBytes), false)
  assertRequestedAppearance(await inspectPptx(result.path), revisedSource)
  const reread = await readSourceThroughTool(current, result.artifactId)
  assert.deepEqual(reread, revisedSource)
  assert.deepEqual(reread.design, originalSource.design)
  assert.equal(readArtifactSourceSnapshot(result.artifactId).deliveryGeneration, 2)
  assert.equal(listSessionTurnArtifacts(current).length, 1)
})

const invalidCases = [
  { label: 'overflowing element geometry', mutate: (args) => { args.slides[0].elements[0].x = 0.8 }, code: 'PPTX_CONTENT_INVALID' },
  { label: 'unequal table rows', mutate: (args) => { args.slides[0].elements[1].table.rows[1].pop() }, code: 'PPTX_CONTENT_INVALID' },
  { label: 'non-finite chart data', mutate: (args) => {
    args.slides[0].elements = [{ type: 'chart', x: 0.05, y: 0.05, w: 0.9, h: 0.9, chart: { type: 'bar', categories: ['A', 'B'], series: [{ name: 'Original', values: [1, NaN] }] } }]
  }, code: 'PPTX_CONTENT_INVALID' },
  { label: 'unprepared image reference', mutate: (args) => {
    args.slides[0].elements = [{ type: 'image', x: 0.1, y: 0.1, w: 0.8, h: 0.8, image_index: 1 }]
  }, code: 'PPTX_IMAGE_REFERENCE_INVALID' },
]

for (const scenario of invalidCases) {
  test(`the real generated tool rejects ${scenario.label} without publishing a fallback`, async () => {
    const current = scope(scenario.label)
    const args = requestedDeck()
    scenario.mutate(args)
    const before = fs.readdirSync(getArtifactDir()).sort()
    await assert.rejects(generate(current, args), (error) => error.code === scenario.code)
    assert.deepEqual(listSessionTurnArtifacts(current), [])
    assert.deepEqual(fs.readdirSync(current.outputDirectory), [])
    assert.deepEqual(fs.readdirSync(getArtifactDir()).sort(), before)
  })
}

test('a real image granted to another user cannot be smuggled through generated PPTX elements', async () => {
  const owner = scope('image owner')
  const current = scope('image outsider')
  const privateImage = path.join(testRoot, 'private-image.png')
  fs.writeFileSync(privateImage, IMAGE_BYTES)
  grantLocalPath({ userId: owner.userId, rootPath: privateImage, accessMode: 'read_only' })
  const args = requestedDeck()
  args.images = [{ path: privateImage }]
  args.slides[0].elements = [{ type: 'image', x: 0.1, y: 0.1, w: 0.8, h: 0.8, image_index: 1 }]
  const before = fs.readdirSync(getArtifactDir()).sort()
  await assert.rejects(generate(current, args), (error) => error.code === 'PATH_NOT_AUTHORIZED')
  assert.deepEqual(listSessionTurnArtifacts(current), [])
  assert.deepEqual(fs.readdirSync(current.outputDirectory), [])
  assert.deepEqual(fs.readdirSync(getArtifactDir()).sort(), before)
})

test('source reads remain limited to the generated artifact owner and chat session', async () => {
  const owner = scope('source owner')
  const outsider = scope('source outsider')
  const generated = await generate(owner, requestedDeck())
  assert.equal(generated.ok, true, JSON.stringify(generated))
  const otherSessionId = `pptx-session-${randomUUID()}`
  upsertSession({ id: otherSessionId, userId: owner.userId, title: 'Another owned session' })
  const otherSessionJob = turnJob(owner.userId, otherSessionId, 'Read only the source owned by this session.')
  for (const job of [outsider.job, otherSessionJob]) {
    const result = await executeServerTool({
      name: 'read_artifact_source', args: { artifact_id: generated.artifactId },
      job, step: { id: job.id, kind: 'chat' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'artifact_source_not_found')
    assert.equal(result.content, undefined)
  }
})
