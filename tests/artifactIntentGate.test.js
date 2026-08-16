import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  allowedArtifactTools,
  detectArtifactIntent,
  expectsFileArtifact,
  findAdjacentDeliveredArtifacts,
  findExplicitlyReferencedDeliveredArtifacts,
  isArtifactRevisionRequest,
  isFileArtifactTool,
  parseSkillIdFromPrompt,
  resolveArtifactDeliveryTarget,
  resolveArtifactDeliveryTargets,
  resolveArtifactRevisionMode,
} from '../server/services/artifactIntent.js'
import { runToolsLoop, SERVER_TOOL_SPECS, selectJobToolSpecs } from '../server/services/jobTools.js'
import { buildFinalOutput, shouldCompileDocx } from '../server/services/jobWorkflow.js'
import { validateHtmlArtifactSource } from '../server/services/artifactGen.js'
import { createUser, getDb } from '../server/db.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { appendTurnArtifact, listTurnArtifacts } from '../server/services/turnArtifactStore.js'

const nameOf = (specs) => specs.map((s) => s?.function?.name)
const ARTIFACT_GENERATOR_NAMES = [
  'create_docx',
  'create_html_app',
  'create_pdf',
  'create_pptx',
  'create_xlsx',
  'generate_image',
  'render_pdf_pages',
]
const INTENT_ARTIFACT_USER_ID = 'intent-user'
const INTENT_ARTIFACT_SESSION_ID = 'artifact-intent-session'
let intentArtifactScopeReady = false

function persistStubTurnArtifact({ turnId, id, filename, type }) {
  if (!intentArtifactScopeReady) {
    getDb().prepare('DELETE FROM turn_artifacts WHERE user_id = ? AND session_id = ?')
      .run(INTENT_ARTIFACT_USER_ID, INTENT_ARTIFACT_SESSION_ID)
    createUser({ id: INTENT_ARTIFACT_USER_ID, email: 'artifact-intent@example.com' })
    upsertSession({
      id: INTENT_ARTIFACT_SESSION_ID,
      userId: INTENT_ARTIFACT_USER_ID,
      title: 'Artifact intent tests',
    })
    intentArtifactScopeReady = true
  }
  const url = `/api/artifacts/${filename}`
  appendTurnArtifact({
    id,
    userId: INTENT_ARTIFACT_USER_ID,
    sessionId: INTENT_ARTIFACT_SESSION_ID,
    turnId,
    type,
    title: filename,
    url,
    filename,
  })
  return { ok: true, artifactId: id, filename, url }
}

function forgedArtifactArgs(name) {
  if (name === 'generate_image') return { prompt: 'An unrelated verification image' }
  if (name === 'render_pdf_pages') return { input: 'unrelated.pdf', pages: [1] }
  return { title: 'Unrequested artifact', paragraphs: [{ text: 'Must not be generated' }] }
}

function validArtifactArgs(name) {
  if (name === 'create_pptx') {
    return { title: 'Presentation', slides: [{ title: 'Summary', body: 'Done' }] }
  }
  if (name === 'create_docx') {
    return { title: 'Document', paragraphs: [{ text: 'Done' }] }
  }
  if (name === 'create_xlsx') {
    return { title: 'Workbook', sheets: [{ name: 'Data', rows: [['Status'], ['Done']] }] }
  }
  if (name === 'create_pdf') return { title: 'PDF', markdown: '# Done' }
  if (name === 'create_html_app') {
    return { title: 'Webpage', html: '<!doctype html><html><body><main>Done</main></body></html>' }
  }
  if (name === 'generate_image') return { prompt: 'Create a new abstract status image' }
  if (name === 'render_pdf_pages') return { input: 'source.pdf', pages: [1], format: 'png' }
  throw new Error(`unknown artifact generator: ${name}`)
}

function deliveredArtifactMessages({ prefix, tool, artifactId, filename, type }) {
  const createCallId = `${prefix}-create`
  const deliveryCallId = `${prefix}-delivery`
  return [
    { role: 'user', content: `生成 ${filename}` },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: createCallId,
        type: 'function',
        function: { name: tool, arguments: JSON.stringify(validArtifactArgs(tool)) },
      }],
    },
    {
      role: 'tool',
      tool_call_id: createCallId,
      name: tool,
      content: JSON.stringify({
        ok: true,
        artifactId,
        filename,
        type,
        url: `/api/artifacts/${filename}`,
      }),
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: deliveryCallId,
        type: 'function',
        function: {
          name: 'set_deliverables',
          arguments: JSON.stringify({ artifact_ids: [artifactId] }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: deliveryCallId,
      name: 'set_deliverables',
      content: JSON.stringify({ ok: true, deliveryArtifactIds: [artifactId] }),
    },
    { role: 'assistant', content: `${filename} 已生成。` },
  ]
}

// ── 事故回归:代码任务不该看得见 create_pptx ────────────────────────────

test('code task cannot even see file-artifact tools', () => {
  const specs = selectJobToolSpecs({ prompt: '修复量化交易平台页面刷新时数据丢失的 bug' })
  const names = nameOf(specs)
  assert.ok(!names.includes('create_pptx'), 'create_pptx 必须对代码任务不可见')
  assert.ok(!names.includes('create_docx'))
  assert.ok(!names.includes('create_xlsx'))
  assert.ok(!names.includes('create_html_app'))
  // 非文件类工具一个都不能被误伤
  const nonArtifact = nameOf(SERVER_TOOL_SPECS).filter((n) => (
    !isFileArtifactTool(n) && n !== 'set_deliverables'
  ))
  for (const n of nonArtifact) assert.ok(names.includes(n), `${n} 被误过滤`)
})

test('ordinary model discussion cannot see docx or pptx tools', () => {
  const names = nameOf(selectJobToolSpecs({
    prompt: '为什么云端模型可以，你是我的本地模型好不好',
  }))
  assert.equal(names.includes('create_docx'), false)
  assert.equal(names.includes('create_pptx'), false)
  assert.equal(names.includes('create_xlsx'), false)
})

test('explicit ppt request unlocks only create_pptx', () => {
  const names = nameOf(selectJobToolSpecs({ prompt: '帮我做一个关于新能源行业的 PPT' }))
  assert.ok(names.includes('create_pptx'))
  assert.ok(!names.includes('create_xlsx'))
})

test('ppt-family skill prefixes unlock create_pptx even without artifact nouns', () => {
  // S6 回归：/ppt-master 做演示 没有 "PPT/幻灯片" 关键词，但技能前缀必须解锁
  for (const prompt of [
    '/ppt-master 做演示',
    '/axippt 帮我做科技风演示',
    '/htmlppt 生成网页',
    '/guizang-ppt 做分享',
  ]) {
    assert.equal(detectArtifactIntent(prompt).pptx, true, prompt)
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
  }
  // 非文件类技能前缀不得解锁
  assert.equal(detectArtifactIntent('/connector-operator 帮我查 GitHub').pptx, false)
})

test('negative and diagnostic PPT mentions never authorize PPT generation', () => {
  for (const prompt of [
    '不要生成 PPT，只在聊天里回答',
    '修复自动生成 PPT 的问题',
    '为什么它会突然变成幻灯片？',
    '我没有让他生成，他自动生成了 pptx 文件',
    '还有在生成幻灯片.pptx文件，我没有让他生成，他自动生成，你深入解读代码，彻底修复',
    '确保不会随意生成幻灯片了',
    '检查 create_pptx 工具为什么被调用',
    'do not create a ppt',
    'fix automatic slide generation',
  ]) {
    const intent = detectArtifactIntent(prompt)
    assert.equal(intent.pptx, false, prompt)
    assert.equal(allowedArtifactTools(prompt).has('create_pptx'), false, prompt)
  }
})

test('explicit production wording still authorizes PPT generation', () => {
  for (const prompt of [
    '帮我做一个关于新能源行业的 PPT',
    '给我一份路演稿',
    'make a 5 page product intro ppt',
    '/ppt 讲讲量子计算',
  ]) {
    assert.equal(detectArtifactIntent(prompt).pptx, true, prompt)
  }
})

test('explicit document wording authorizes DOCX without weakening negative guards', () => {
  for (const prompt of [
    '导出测试文档',
    '整理会议纪要并导出',
    '写个 Word',
    '编写一份周报',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, true, prompt)
  }
  for (const prompt of [
    '不要生成文档，只在聊天里回答',
    '修复自动生成报告的问题',
    '检查 create_docx 工具为什么被调用',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
  }
})

test('explicit image production unlocks only generate_image', () => {
  assert.deepEqual(
    [...allowedArtifactTools('生成一张产品海报图片')],
    ['generate_image'],
  )
  assert.equal(detectArtifactIntent('why did generate_image run?').image, false)
})

test('existing file formats used as website inputs do not become extra deliverables', () => {
  const htmlOnly = [
    '"E:\\果"这个地方有很多人物图片，用这些人物图片你来写一个网站，确保该文件下的所有内容都被使用，我想在网站看这些，这样更方便，写到D盘',
    '读取本地图片目录，生成一个 HTML 画廊网站',
    '/webpage 使用 E:\\果 目录里的所有人物图片做一个网站',
    '读取 D:\\资料\\季度报告.pdf 的内容，生成一个网页展示',
    '使用已有的 budget.xlsx 制作一个网站',
    '根据上传的 slides.pptx 写一个网站',
  ]

  for (const prompt of htmlOnly) {
    assert.deepEqual(detectArtifactIntent(prompt), {
      pptx: false,
      docx: false,
      xlsx: false,
      html: true,
      pdf: false,
      image: false,
    }, prompt)
    assert.deepEqual([...allowedArtifactTools(prompt)], ['create_html_app'], prompt)
    const visible = nameOf(selectJobToolSpecs({ prompt, specs: SERVER_TOOL_SPECS }))
    assert.equal(visible.includes('create_html_app'), true, prompt)
    assert.equal(visible.includes('generate_image'), false, prompt)
    assert.equal(visible.includes('create_pdf'), false, prompt)
    assert.equal(visible.includes('create_xlsx'), false, prompt)
    assert.equal(visible.includes('create_pptx'), false, prompt)
  }

  for (const prompt of [
    '生成图片并做网站',
    '做一个网站，另外生成一张新封面图',
    '/webpage 使用已有图片制作画廊，另外生成一张新的装饰插图',
  ]) {
    assert.deepEqual([...allowedArtifactTools(prompt)].sort(), [
      'create_html_app',
      'generate_image',
    ], prompt)
  }

  assert.deepEqual([...allowedArtifactTools('生成一张人物图片')], ['generate_image'])
})

test('existing artifacts used as inputs unlock only the explicitly requested output format', () => {
  const scenarios = [
    ['使用已有 PDF 生成 Word 文档', 'create_docx'],
    ['读取现有 Word 文档制作一份 PPT 演示文稿', 'create_pptx'],
    ['参考已有 PPT 创建 Excel 工作簿', 'create_xlsx'],
    ['基于已有 Excel 导出 PDF', 'create_pdf'],
    ['把 Word 文档转成网页', 'create_html_app'],
    ['把 PDF 转成图片', 'render_pdf_pages'],
    ['把 HTML 页面转为 PDF', 'create_pdf'],
    ['把图片转成 PDF', 'create_pdf'],
    ['将 PDF 作为附件放入 Word 文档', 'create_docx'],
    ['把图片作为 PPT 背景', 'create_pptx'],
  ]

  for (const [prompt, expectedTool] of scenarios) {
    assert.deepEqual([...allowedArtifactTools(prompt)], [expectedTool], prompt)
    const visible = nameOf(selectJobToolSpecs({
      prompt,
      userPrompt: prompt,
      origin: 'chat',
      intentMode: 'execute',
      specs: SERVER_TOOL_SPECS,
    }))
    for (const generator of ARTIFACT_GENERATOR_NAMES) {
      assert.equal(visible.includes(generator), generator === expectedTool, `${prompt}: ${generator}`)
    }
  }

  for (const [prompt, expectedTool] of [
    ['读取已有 report.pdf，生成 Word 文档', 'create_docx'],
    ['参考现有 slides.pptx，生成 Excel 工作簿', 'create_xlsx'],
    ['使用已有 budget.xlsx，制作一份 PPT 演示文稿', 'create_pptx'],
    ['基于已有 notes.docx，导出 PDF', 'create_pdf'],
    ['读取现有 landing.html，创建一份 PDF', 'create_pdf'],
    ['用上传的 hero.png 制作一份 PPT', 'create_pptx'],
  ]) {
    assert.deepEqual([...allowedArtifactTools(prompt)], [expectedTool], prompt)
  }
})

test('English convert and export clauses unlock only the target artifact format', () => {
  const scenarios = [
    ['convert Word to PDF', 'create_pdf'],
    ['convert PDF to Word', 'create_docx'],
    ['convert Excel into PDF', 'create_pdf'],
    ['convert HTML to PowerPoint', 'create_pptx'],
    ['convert PowerPoint into a Word document', 'create_docx'],
    ['convert image to PDF', 'create_pdf'],
    ['convert PDF to image', 'render_pdf_pages'],
    ['export PDF as images', 'render_pdf_pages'],
    ['convert the document into a spreadsheet', 'create_xlsx'],
    ['convert the website to a PowerPoint', 'create_pptx'],
  ]

  for (const [prompt, expectedTool] of scenarios) {
    assert.deepEqual([...allowedArtifactTools(prompt)], [expectedTool], prompt)
  }
})

test('placing a provided image in an adjacent artifact retains only the original format tool', () => {
  const scenarios = [
    ['在原版 Word 文档中加入这张图片', 'docx', 'create_docx'],
    ['在原版 PPT 中加入这张图片', 'pptx', 'create_pptx'],
    ['在原版 Excel 中加入这张图片', 'xlsx', 'create_xlsx'],
    ['在原版 PDF 中加入这张图片', 'pdf', 'create_pdf'],
    ['在原版网页中加入这张图片', 'html', 'create_html_app'],
    ['put this uploaded photo into the existing PowerPoint', 'pptx', 'create_pptx'],
  ]

  for (const [prompt, priorType, expectedTool] of scenarios) {
    const options = { priorArtifactTypes: [priorType], hasPriorArtifact: true }
    assert.deepEqual([...allowedArtifactTools(prompt, options)], [expectedTool], prompt)
    assert.equal(detectArtifactIntent(prompt, options).image, false, prompt)
  }
})

test('all artifact formats distinguish create, replace, copy, convert, and input-only intent', () => {
  const cases = [
    {
      type: 'pptx', tool: 'create_pptx', create: '生成一份 PPT',
      convert: '把 Word 文档转成 PPT', input: '读取已有 PPT 并在聊天里总结内容',
    },
    {
      type: 'docx', tool: 'create_docx', create: '生成一份 Word 文档',
      convert: '把 PDF 转成 Word 文档', input: '读取已有 Word 文档并在聊天里总结内容',
    },
    {
      type: 'xlsx', tool: 'create_xlsx', create: '生成一个 Excel 工作簿',
      convert: '把 PPT 转成 Excel 工作簿', input: '分析已有 Excel 并在聊天里总结数据',
    },
    {
      type: 'pdf', tool: 'create_pdf', create: '生成一份 PDF',
      convert: '把图片转成 PDF', input: '读取已有 PDF 并在聊天里总结内容',
    },
    {
      type: 'html', tool: 'create_html_app', create: '生成一个网页',
      convert: '把 Word 文档转成网页', input: '读取已有 HTML 并在聊天里总结内容',
    },
    {
      type: 'image', tool: 'generate_image', convertTool: 'render_pdf_pages', create: '生成一张图片',
      convert: '把 PDF 转成图片', input: '查看已有图片并在聊天里描述内容',
    },
  ]

  for (const scenario of cases) {
    assert.deepEqual([...allowedArtifactTools(scenario.create)], [scenario.tool], `${scenario.type}: create`)
    assert.deepEqual(
      [...allowedArtifactTools(scenario.convert)],
      [scenario.convertTool || scenario.tool],
      `${scenario.type}: convert`,
    )
    assert.deepEqual([...allowedArtifactTools(scenario.input)], [], `${scenario.type}: input only`)
    assert.deepEqual(
      [...allowedArtifactTools('直接修改原版，保留原文件名，不要新建版本', {
        priorArtifactTypes: [scenario.type],
      })],
      [scenario.tool],
      `${scenario.type}: replace`,
    )
    assert.deepEqual(
      [...allowedArtifactTools('基于上一版另建一个新文件，保留原版', {
        priorArtifactTypes: [scenario.type],
      })],
      [scenario.tool],
      `${scenario.type}: create copy`,
    )
  }
})

test('object-first attachment placement inherits the adjacent webpage revision contract', () => {
  const priorArtifacts = [{
    id: 'previous-html-artifact',
    type: 'html',
    filename: '产品网页.html',
    toolName: 'create_html_app',
  }]
  const priorArtifactTypes = priorArtifacts.map((artifact) => artifact.type)
  const revisionPrompts = [
    '把这张人物图作为背景',
    '请把这张图片设为背景',
    '帮我把这张图片设为背景',
    '将上传的照片设为网页背景图',
    '麻烦将附件图片用作网页背景',
    '使用附件里的图片作为页面主视觉',
    '用这张图片做背景',
    '请使用这张图片作为网页背景',
    '请把附件里的图片当背景使用',
    '用我提供的照片做封面图',
    'Use this attached image as the website background',
    'Use this image as a background',
    'Set the uploaded photo as the page hero image',
  ]

  for (const prompt of revisionPrompts) {
    assert.equal(isArtifactRevisionRequest(prompt), true, prompt)
    const intentOptions = { priorArtifacts, priorArtifactTypes }
    assert.equal(detectArtifactIntent(prompt, intentOptions).html, true, prompt)
    assert.deepEqual([...allowedArtifactTools(prompt, intentOptions)], ['create_html_app'], prompt)
    assert.equal(resolveArtifactDeliveryTarget(prompt, intentOptions), 'managed_artifact', prompt)

    const visible = nameOf(selectJobToolSpecs({
      prompt,
      userPrompt: prompt,
      priorArtifacts,
      priorArtifactTypes,
      origin: 'chat',
      specs: SERVER_TOOL_SPECS,
    }))
    for (const name of [
      'create_html_app',
      'image_info',
      'image_transform',
      'read_artifact_source',
      'write_file',
      'run_project_check',
      'set_deliverables',
    ]) {
      assert.ok(visible.includes(name), `${prompt}: ${name}`)
    }
    assert.equal(visible.includes('generate_image'), false, prompt)
  }

  for (const prompt of [
    '不要把这张图作为背景',
    '别用这张图作为背景',
    '是否用这张图作为背景？',
    '我建议用这张图作为背景',
    '为什么上一版把人物图设为背景？',
    '先告诉我如何把图片作为背景，不要修改文件',
    'Do not use this image as the background.',
    'Why use this image as the background?',
    'Can I use this image as the background?',
    'Should we use this image as the background?',
    '把项目经历作为背景介绍一下',
    '将现状作为背景分析问题',
    '把这个需求作为背景说明一下',
    '把项目经历作为背景介绍一下，并参考这张图',
    '把项目经历作为背景介绍一下，这张图不要改',
    'Use this file as background information',
  ]) {
    assert.equal(isArtifactRevisionRequest(prompt), false, prompt)
    const intentOptions = { priorArtifacts, priorArtifactTypes }
    assert.equal(detectArtifactIntent(prompt, intentOptions).html, false, prompt)
    assert.deepEqual([...allowedArtifactTools(prompt, intentOptions)], [], prompt)
  }

  assert.deepEqual(
    [...allowedArtifactTools('把这张人物图作为背景')],
    [],
    'an existing input image is not a request to generate a new image without a target artifact',
  )
  assert.deepEqual(
    [...allowedArtifactTools('把这张人物图作为背景，同时生成一张新的装饰插图', {
      priorArtifacts,
      priorArtifactTypes,
    })].sort(),
    ['create_html_app', 'generate_image'],
  )
})

test('explicit PDF production works without a slash skill', () => {
  assert.deepEqual([...allowedArtifactTools('请生成一份中文项目总结 PDF')], ['create_pdf'])
  assert.equal(detectArtifactIntent('导出为 PDF').pdf, true)
  assert.equal(detectArtifactIntent('为什么会自动生成 PDF？').pdf, false)
})

test('existing uploaded images route to the requested file generator instead of generate_image', () => {
  const cases = [
    {
      prompt: '请用上传的 hero.png 作为封面，制作一份 PPT 演示文稿',
      expected: ['create_pptx'],
    },
    {
      prompt: '请把 D:\\assets\\portrait.png 插入新的 Word 文档',
      expected: ['create_docx'],
    },
    {
      prompt: '请将 attachment://image_asset_12345678 放入新的 Excel 工作簿',
      expected: ['create_xlsx'],
    },
    {
      prompt: '请使用上传的 photo.jpg 制作一份 PDF',
      expected: ['create_pdf'],
    },
    {
      prompt: '请用 attachment://image_asset_87654321 作为背景生成一个网页',
      expected: ['create_html_app'],
    },
    {
      prompt: '请把上传的 portrait.png 放入新的 Word 文档，另外生成一张新的装饰插图',
      expected: ['create_docx', 'generate_image'],
    },
    {
      prompt: '请把上传的 report.pdf 转成 PNG 图片',
      expected: ['render_pdf_pages'],
    },
  ]

  for (const { prompt, expected } of cases) {
    assert.deepEqual([...allowedArtifactTools(prompt)].sort(), expected.sort(), prompt)

    const visible = nameOf(selectJobToolSpecs({
      prompt,
      userPrompt: prompt,
      origin: 'chat',
      specs: SERVER_TOOL_SPECS,
    }))
    for (const generator of ARTIFACT_GENERATOR_NAMES) {
      assert.equal(visible.includes(generator), expected.includes(generator), `${prompt}: ${generator}`)
    }
  }
})

test('explicit workspace filenames are not standalone managed artifacts', () => {
  const priorArtifacts = [{
    id: 'managed-html-1',
    type: 'html',
    filename: 'Gugo-产品落地页.html',
    toolName: 'create_html_app',
  }]
  for (const prompt of [
    '继续修改刚才的原文件 qa-context-test.html，只允许修改这个现有原文件，不要新建任何文件或 artifact',
    '修改 qa-context-test.html 的主视觉标题',
    '请在当前项目根目录中新建 qa-context-test-v2.html',
    'edit the existing workspace file pages/product.html in place',
  ]) {
    assert.equal(
      resolveArtifactDeliveryTarget(prompt, { priorArtifacts }),
      'workspace_file',
      prompt,
    )
  }
  assert.equal(
    resolveArtifactDeliveryTarget('生成一个产品网页', { priorArtifacts: [] }),
    'standalone',
  )
  assert.equal(
    resolveArtifactDeliveryTarget('继续修改 Gugo-产品落地页.html', {
      priorArtifacts,
      hasExplicitManagedArtifactReference: true,
    }),
    'managed_artifact',
  )
  assert.equal(
    resolveArtifactDeliveryTarget('把这里的按钮缩小一点', { priorArtifacts }),
    'managed_artifact',
  )
})

function adjacentHtmlRevisionMessages(currentPrompt = '这里不足，请修改一下') {
  return [
    { role: 'user', content: '/webpage 生成一个产品网页' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'previous-html-call',
        function: {
          name: 'create_html_app',
          arguments: JSON.stringify({
            title: '产品网页',
            html: '<!doctype html><html><body><main><button>开始</button></main></body></html>',
          }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'previous-html-call',
      name: 'create_html_app',
      content: JSON.stringify({
        ok: true,
        artifactId: 'previous-html-artifact',
        filename: '产品网页.html',
        url: '/api/artifacts/previous-html-artifact',
      }),
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'previous-delivery-call',
        function: {
          name: 'set_deliverables',
          arguments: JSON.stringify({ artifact_ids: ['previous-html-artifact'] }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'previous-delivery-call',
      name: 'set_deliverables',
      content: JSON.stringify({ ok: true, deliveryArtifactIds: ['previous-html-artifact'] }),
    },
    { role: 'assistant', content: '网页已生成。' },
    { role: 'user', content: currentPrompt },
  ]
}

test('remote URLs never become local targets or historical artifact references', () => {
  const prompt = '参考 https://example.com/product-page.html然后修改“qa.html”'
  const delivery = resolveArtifactDeliveryTargets(prompt)

  assert.equal(delivery.target, 'workspace_file')
  assert.deepEqual(delivery.localFileTargets, [{
    path: 'qa.html',
    filename: 'qa.html',
    type: 'html',
  }])
  assert.deepEqual(delivery.workspaceArtifactTypes, ['html'])
  assert.deepEqual(delivery.managedArtifactTypes, [])
  assert.deepEqual(
    findExplicitlyReferencedDeliveredArtifacts(adjacentHtmlRevisionMessages(prompt), prompt),
    [],
  )

  const urlOnly = resolveArtifactDeliveryTargets('请检查 https://example.com/report.pdf 的内容')
  assert.deepEqual(urlOnly.localFileTargets, [])
  assert.deepEqual(urlOnly.workspaceArtifactTypes, [])
  assert.deepEqual(urlOnly.managedArtifactTypes, [])
})

test('Chinese quotes and parentheses preserve explicit workspace filenames', () => {
  for (const prompt of [
    '修改本地文件“qa.html”',
    '修改本地文件（qa.html）',
  ]) {
    const delivery = resolveArtifactDeliveryTargets(prompt)
    assert.equal(delivery.target, 'workspace_file', prompt)
    assert.deepEqual(delivery.localFileTargets, [{
      path: 'qa.html',
      filename: 'qa.html',
      type: 'html',
    }], prompt)
    assert.deepEqual([...allowedArtifactTools(prompt)], [], prompt)
  }

  const skillDelivery = resolveArtifactDeliveryTargets('/webpage 修改本地文件“qa.html”', {
    skillId: 'webpage',
  })
  assert.equal(skillDelivery.target, 'workspace_file')
  assert.deepEqual(skillDelivery.managedArtifactTypes, [])
})

test('bare named artifact files remain managed deliverables', () => {
  for (const scenario of [
    { prompt: '生成 report.docx', type: 'docx', tool: 'create_docx' },
    { prompt: '制作 slides.pptx', type: 'pptx', tool: 'create_pptx' },
    { prompt: '生成 budget.xlsx', type: 'xlsx', tool: 'create_xlsx' },
    { prompt: '生成 landing.html', type: 'html', tool: 'create_html_app' },
    { prompt: '导出 report.pdf', type: 'pdf', tool: 'create_pdf' },
    { prompt: '生成 hero.png', type: 'image', tool: 'generate_image' },
  ]) {
    const delivery = resolveArtifactDeliveryTargets(scenario.prompt)
    assert.equal(delivery.target, 'standalone', scenario.prompt)
    assert.deepEqual(delivery.localFileTargets, [], scenario.prompt)
    assert.deepEqual(delivery.workspaceArtifactTypes, [], scenario.prompt)
    assert.deepEqual(delivery.managedArtifactTypes, [scenario.type], scenario.prompt)
    assert.deepEqual([...allowedArtifactTools(scenario.prompt)], [scenario.tool], scenario.prompt)
  }
})

test('mixed local HTML and managed PDF expose only the PDF generator', () => {
  const prompt = '修改本地文件“index.html”，并另外生成一份 PDF'
  const delivery = resolveArtifactDeliveryTargets(prompt)

  assert.equal(delivery.target, 'mixed')
  assert.deepEqual(delivery.localFileTargets, [{
    path: 'index.html',
    filename: 'index.html',
    type: 'html',
  }])
  assert.deepEqual(delivery.workspaceArtifactTypes, ['html'])
  assert.deepEqual(delivery.managedArtifactTypes, ['pdf'])
  assert.deepEqual([...allowedArtifactTools(prompt)], ['create_pdf'])

  const names = nameOf(selectJobToolSpecs({
    prompt,
    userPrompt: prompt,
    origin: 'chat',
    intentMode: 'execute',
    specs: SERVER_TOOL_SPECS,
  }))
  assert.equal(names.includes('create_html_app'), false)
  assert.equal(names.includes('create_pdf'), true)
})

test('workspace HTML targets use filesystem tools without a managed-artifact completion guard', async () => {
  const cases = [
    {
      label: 'auto-skill-existing-file',
      prompt: '请直接修改当前项目根目录中现有的 qa-context-test.html，把它完善成一个简洁的深色产品落地页。必须实际编辑原文件并验证，不要输出代码片段。',
      path: 'qa-context-test.html',
      skillId: 'webpage',
    },
    {
      label: 'plain-follow-up-existing-file',
      prompt: '继续修改刚才的原文件 qa-context-test.html：优化主视觉。只允许修改这个现有原文件，不要新建任何文件或 artifact。',
      path: 'qa-context-test.html',
      messages: null,
    },
    {
      label: 'auto-skill-new-file',
      prompt: '请在当前项目根目录中新建 qa-context-test-v2.html，并直接完成页面和验证，不要输出代码片段。',
      path: 'qa-context-test-v2.html',
      skillId: 'webpage',
    },
  ]

  for (const scenario of cases) {
    let modelCalls = 0
    const executions = []
    const history = scenario.messages
      || (scenario.label === 'plain-follow-up-existing-file'
        ? adjacentHtmlRevisionMessages(scenario.prompt)
        : [{ role: 'user', content: scenario.prompt }])
    const result = await runToolsLoop({
      job: {
        id: `workspace-html-${scenario.label}`,
        userId: INTENT_ARTIFACT_USER_ID,
        origin: 'chat',
        prompt: scenario.prompt,
        userPrompt: scenario.prompt,
      },
      step: { id: `workspace-html-${scenario.label}`, kind: 'chat' },
      messages: history,
      skillId: scenario.skillId,
      intentMode: 'execute',
      toolSpecs: SERVER_TOOL_SPECS,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      executeTool: async ({ name, args }) => {
        executions.push({ name, args })
        assert.equal(args.path, scenario.path)
        if (name === 'write_file') {
          return { ok: true, path: scenario.path, bytes: 64, scope: 'workspace' }
        }
        if (name === 'read_file') {
          return {
            ok: true,
            path: scenario.path,
            content: '<!doctype html><html><body><main>verified</main></body></html>',
            truncated: false,
          }
        }
        assert.fail(`unexpected tool for ${scenario.label}: ${name}`)
      },
      runModel: async ({ messages, tools }) => {
        modelCalls += 1
        const names = tools.map((tool) => tool.function.name)
        assert.equal(names.includes('create_html_app'), false, scenario.label)
        assert.equal(
          messages.some((message) => String(message.content || '').includes('[PERSISTED ARTIFACT DELIVERY REQUIRED]')),
          false,
          scenario.label,
        )
        if (modelCalls === 1) {
          assert.ok(names.includes('write_file'), scenario.label)
          return {
            content: '',
            toolCalls: [{
              id: `${scenario.label}-write`,
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: scenario.path,
                  content: '<!doctype html><html><body><main>updated</main></body></html>',
                }),
              },
            }],
          }
        }
        if (modelCalls === 2) {
          assert.ok(names.includes('read_file'), scenario.label)
          return {
            content: '',
            toolCalls: [{
              id: `${scenario.label}-read`,
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: scenario.path }),
              },
            }],
          }
        }
        return { content: '已按要求修改指定文件并完成验证。', toolCalls: [] }
      },
    })

    assert.equal(modelCalls, 3, scenario.label)
    assert.deepEqual(executions.map(({ name }) => name), ['write_file', 'read_file'], scenario.label)
    assert.deepEqual(result.artifactIds, [], scenario.label)
    assert.equal(result.text, '已按要求修改指定文件并完成验证。', scenario.label)
  }
})

test('a real in-place workspace HTML write does not publish a duplicate artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-html-revision-'))
  const targetPath = path.join(root, 'existing.html')
  const userId = 'local-revision-user-' + randomUUID()
  const sessionId = 'local-revision-session-' + randomUUID()
  const turnId = 'local-revision-turn-' + randomUUID()
  const promptPath = targetPath.replace(/\\/g, '/')
  const prompt = '继续修改现有原文件 ' + promptPath + '，只覆盖原文件，不要新建任何文件或 artifact。'
  fs.writeFileSync(targetPath, '<!doctype html><title>before</title>', 'utf8')
  createUser({ id: userId, email: userId + '@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Local revision artifact gate' })
  let modelCalls = 0
  try {
    const result = await runToolsLoop({
      job: {
        id: turnId,
        userId,
        sessionId,
        origin: 'chat',
        prompt,
        userPrompt: prompt,
      },
      step: { id: turnId, kind: 'chat' },
      messages: [{ role: 'user', content: prompt }],
      intentMode: 'execute',
      toolSpecs: SERVER_TOOL_SPECS,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      executeTool: async ({ name, args }) => {
        if (name === 'write_file') {
          fs.writeFileSync(targetPath, args.content, 'utf8')
          return {
            ok: true,
            path: targetPath,
            bytes: Buffer.byteLength(args.content),
            scope: 'local',
            changes: [{ path: targetPath, additions: 1, deletions: 1 }],
          }
        }
        if (name === 'read_file') {
          return {
            ok: true,
            path: targetPath,
            content: fs.readFileSync(targetPath, 'utf8'),
            truncated: false,
          }
        }
        assert.fail('unexpected tool: ' + name)
      },
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'overwrite-existing-html',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: targetPath,
                  content: '<!doctype html><title>after</title>',
                }),
              },
            }],
          }
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [{
              id: 'read-overwritten-html',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: targetPath }),
              },
            }],
          }
        }
        return { content: '已完成原文件修改和验证。', toolCalls: [] }
      },
    })

    assert.equal(modelCalls, 3)
    assert.equal(fs.readFileSync(targetPath, 'utf8'), '<!doctype html><title>after</title>')
    assert.deepEqual(result.artifactIds, [])
    assert.deepEqual(listTurnArtifacts({ userId, sessionId, turnId }), [])
    assert.deepEqual(fs.readdirSync(root), ['existing.html'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    getDb().prepare('DELETE FROM turn_artifacts WHERE user_id = ? AND session_id = ?').run(userId, sessionId)
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    getDb().prepare('DELETE FROM users WHERE id = ?').run(userId)
  }
})

test('a workspace-file request cannot silently fall back to a same-named managed artifact', async () => {
  const prompt = '继续修改刚才的原文件 qa-context-test.html，只允许修改这个现有原文件，不要新建任何文件或 artifact。'
  let modelCalls = 0
  let executions = 0
  let rejectionObserved = false
  const result = await runToolsLoop({
    job: {
      id: 'workspace-managed-store-mismatch',
      userId: INTENT_ARTIFACT_USER_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'workspace-managed-store-mismatch', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      rejectionObserved ||= messages.some((message) => (
        String(message.content || '').includes('workspace_target_managed_store_mismatch')
      ))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'wrong-managed-store-write',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: '.artifacts/qa-context-test.html',
                content: '<!doctype html><title>wrong target</title>',
              }),
            },
          }],
        }
      }
      return { content: '无法确认原文件位置。', toolCalls: [] }
    },
  })

  assert.equal(executions, 0)
  assert.equal(rejectionObserved, true)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
})

async function runRejectedExactWorkspaceMutation({
  label,
  name,
  args,
  approvalArgs = null,
}) {
  const prompt = '继续修改当前项目里的原文件 qa-context-test.html，只覆盖这个原文件，不要新建副本或 artifact。'
  let modelCalls = 0
  let executions = 0
  let approvals = 0
  const observedCodes = new Set()
  const result = await runToolsLoop({
    job: {
      id: `exact-workspace-target-${label}`,
      userId: INTENT_ARTIFACT_USER_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: `exact-workspace-target-${label}`, kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async () => {
      approvals += 1
      return { proceed: true, args: approvalArgs || args }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      for (const message of messages) {
        const content = String(message?.content || '')
        for (const code of [
          'workspace_target_managed_store_mismatch',
          'workspace_target_mismatch',
          'workspace_mutation_target_unproven',
        ]) {
          if (content.includes(code)) observedCodes.add(code)
        }
      }
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: `wrong-target-${label}`,
            function: { name, arguments: JSON.stringify(args) },
          }],
        }
      }
      return { content: '无法完成原文件修改。', toolCalls: [] }
    },
  })
  return { approvals, executions, observedCodes, result }
}

test('every filesystem mutation tool rejects sibling targets during an exact in-place revision', async () => {
  const originalPath = 'qa-context-test.html'
  const siblingPath = 'qa-context-test-copy.html'
  const scenarios = [
    {
      label: 'write-file',
      name: 'write_file',
      args: { path: siblingPath, content: '<!doctype html><title>copy</title>' },
    },
    {
      label: 'edit-file',
      name: 'edit_file',
      args: { path: siblingPath, old_string: 'before', new_string: 'after' },
    },
    {
      label: 'patch-file',
      name: 'patch_file',
      args: { path: siblingPath, start_line: 1, end_line: 1, replacement: 'after' },
    },
    {
      label: 'multi-edit',
      name: 'multi_edit',
      args: {
        edits: [
          { path: originalPath, oldText: 'before', newText: 'after' },
          { path: siblingPath, oldText: 'before', newText: 'after' },
        ],
      },
    },
    {
      label: 'apply-patch',
      name: 'apply_patch',
      args: {
        patch: [
          '*** Begin Patch',
          `*** Update File: ${originalPath}`,
          '@@',
          '-before',
          '+after',
          `*** Update File: ${siblingPath}`,
          '@@',
          '-before',
          '+after',
          '*** End Patch',
        ].join('\n'),
      },
    },
  ]

  for (const scenario of scenarios) {
    const outcome = await runRejectedExactWorkspaceMutation(scenario)
    assert.equal(outcome.executions, 0, scenario.label)
    assert.equal(outcome.approvals, 0, scenario.label)
    assert.equal(outcome.observedCodes.has('workspace_target_mismatch'), true, scenario.label)
    assert.equal(outcome.result.incomplete, true, scenario.label)
  }
})

test('command mutations reject wrong, managed-store, and unproven targets during an exact in-place revision', async () => {
  const scenarios = [
    {
      label: 'bash-sibling-output',
      name: 'bash_exec',
      args: { command: 'python write_html.py', expected_outputs: ['qa-context-test-copy.html'] },
      code: 'workspace_target_mismatch',
    },
    {
      label: 'run-command-managed-output',
      name: 'run_command',
      args: { command: 'python write_html.py', expected_outputs: ['.artifacts/qa-context-test.html'] },
      code: 'workspace_target_managed_store_mismatch',
    },
    {
      label: 'bash-unproven-output',
      name: 'bash_exec',
      args: { command: 'python write_html.py' },
      code: 'workspace_mutation_target_unproven',
    },
  ]

  for (const scenario of scenarios) {
    const outcome = await runRejectedExactWorkspaceMutation(scenario)
    assert.equal(outcome.executions, 0, scenario.label)
    assert.equal(outcome.approvals, 0, scenario.label)
    assert.equal(outcome.observedCodes.has(scenario.code), true, scenario.label)
    assert.equal(outcome.result.incomplete, true, scenario.label)
  }
})

test('approval-edited filesystem args are revalidated against the exact original target', async () => {
  const outcome = await runRejectedExactWorkspaceMutation({
    label: 'approval-edited-path',
    name: 'write_file',
    args: {
      path: 'qa-context-test.html',
      content: '<!doctype html><title>updated original</title>',
    },
    approvalArgs: {
      path: 'qa-context-test-copy.html',
      content: '<!doctype html><title>wrong copy</title>',
    },
  })

  assert.equal(outcome.approvals, 1)
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.observedCodes.has('workspace_target_mismatch'), true)
  assert.equal(outcome.result.incomplete, true)
})

test('approval-edited command outputs are revalidated against the exact original target', async () => {
  const outcome = await runRejectedExactWorkspaceMutation({
    label: 'approval-edited-command-output',
    name: 'bash_exec',
    args: {
      command: 'python write_html.py',
      expected_outputs: ['qa-context-test.html'],
    },
    approvalArgs: {
      command: 'python write_html.py',
      expected_outputs: ['qa-context-test-copy.html'],
    },
  })

  assert.equal(outcome.approvals, 1)
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.observedCodes.has('workspace_target_mismatch'), true)
  assert.equal(outcome.result.incomplete, true)
})

test('a command with an exact declared output may update and verify the requested original', async () => {
  const prompt = '继续修改当前项目里的原文件 qa-context-test.html，只覆盖这个原文件，不要新建副本或 artifact。'
  const targetPath = 'qa-context-test.html'
  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'exact-workspace-target-allowed-command',
      userId: INTENT_ARTIFACT_USER_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'exact-workspace-target-allowed-command', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args }) => {
      executed.push(name)
      if (name === 'bash_exec') {
        return {
          ok: true,
          exitCode: 0,
          changedPaths: [targetPath],
          verifiedOutputs: [{ path: targetPath, changed: true }],
        }
      }
      assert.equal(name, 'read_file')
      assert.equal(args.path, targetPath)
      return { ok: true, path: targetPath, content: '<!doctype html><title>verified</title>' }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'exact-command-write',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python write_html.py',
                expected_outputs: [targetPath],
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'exact-command-read-back',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: targetPath }),
            },
          }],
        }
      }
      return { content: '已修改并验证原文件。', toolCalls: [] }
    },
  })

  assert.deepEqual(executed, ['bash_exec', 'read_file'])
  assert.equal(modelCalls, 3)
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, '已修改并验证原文件。')
  assert.deepEqual(result.artifactIds, [])
})

function deliveredHtmlTurn({ prefix, artifactId, filename }) {
  const createCallId = `${prefix}-create`
  const deliveryCallId = `${prefix}-deliver`
  return [
    { role: 'user', content: `生成 ${filename}` },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: createCallId,
        function: {
          name: 'create_html_app',
          arguments: JSON.stringify({
            title: filename.replace(/\.html$/i, ''),
            html: `<!doctype html><html><body>${filename}</body></html>`,
          }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: createCallId,
      name: 'create_html_app',
      content: JSON.stringify({
        ok: true,
        artifactId,
        filename,
        url: `/api/artifacts/${filename}`,
      }),
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: deliveryCallId,
        function: {
          name: 'set_deliverables',
          arguments: JSON.stringify({ artifact_ids: [artifactId] }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: deliveryCallId,
      name: 'set_deliverables',
      content: JSON.stringify({ ok: true, deliveryArtifactIds: [artifactId] }),
    },
    { role: 'assistant', content: `${filename} 已生成。` },
  ]
}

test('only an adjacent delivered artifact can authorize an implicit revision', () => {
  const artifacts = findAdjacentDeliveredArtifacts(adjacentHtmlRevisionMessages())
  assert.deepEqual(artifacts, [{
    id: 'previous-html-artifact',
    type: 'html',
    filename: '产品网页.html',
    url: '/api/artifacts/previous-html-artifact',
    toolName: 'create_html_app',
  }])
  assert.deepEqual(
    [...allowedArtifactTools('这里不足，请修改一下', { priorArtifactTypes: artifacts.map((item) => item.type) })],
    ['create_html_app'],
  )
  for (const prompt of ['把配色改一下', '把这里改一下', '配色改一下', '换个配色']) {
    assert.deepEqual(
      [...allowedArtifactTools(prompt, { priorArtifactTypes: ['html'] })],
      ['create_html_app'],
      prompt,
    )
  }
  for (const prompt of [
    '背景颜色太浅了',
    '人物再大一点',
    '人物大一点',
    '按钮小一点',
    '标题居中',
    '这个按钮不好看',
    '把图片放到右边',
    '继续',
  ]) {
    assert.equal(isArtifactRevisionRequest(prompt), false, `${prompt}: no adjacent artifact context`)
    assert.equal(
      isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }),
      true,
      `${prompt}: adjacent artifact context`,
    )
    assert.deepEqual(
      [...allowedArtifactTools(prompt, { priorArtifactTypes: ['html'] })],
      ['create_html_app'],
      prompt,
    )
    assert.equal(
      resolveArtifactDeliveryTarget(prompt, { priorArtifacts: artifacts }),
      'managed_artifact',
      prompt,
    )
  }
  for (const prompt of [
    '是不是背景颜色太浅了？',
    '你觉得这个按钮不好看吗？',
    '不要把图片放到右边',
    '先不要继续',
    '为什么人物要再大一点？',
  ]) {
    assert.equal(
      isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }),
      false,
      prompt,
    )
    assert.equal(allowedArtifactTools(prompt, { priorArtifactTypes: ['html'] }).size, 0, prompt)
  }
  for (const [type, tool] of [
    ['pptx', 'create_pptx'],
    ['docx', 'create_docx'],
    ['xlsx', 'create_xlsx'],
    ['pdf', 'create_pdf'],
    ['image', 'generate_image'],
  ]) {
    assert.deepEqual(
      [...allowedArtifactTools('把这里改一下', { priorArtifactTypes: [type] })],
      [tool],
      type,
    )
  }
  assert.equal(allowedArtifactTools('请解释一下配色原则', { priorArtifactTypes: ['html'] }).size, 0)
  assert.equal(allowedArtifactTools('如何修改配色？', { priorArtifactTypes: ['html'] }).size, 0)
  assert.equal(allowedArtifactTools('修改是什么意思？', { priorArtifactTypes: ['html'] }).size, 0)
  assert.deepEqual([...allowedArtifactTools('请另做一份 PDF', { priorArtifactTypes: ['html'] })], ['create_pdf'])
})

test('keeping the original filename is an in-place revision, not a request for a copy', () => {
  for (const prompt of [
    '把刚才的原版文件直接修改，保留原文件名，不要新建版本',
    '直接修改当前文件并保留当前文件名',
    '直接修改当前文件，保留原文件的名称',
    '保留原文件 名，直接修改内容',
    'edit the original file and keep the original filename',
  ]) {
    assert.equal(resolveArtifactRevisionMode(prompt), 'replace_original', prompt)
  }
  assert.equal(
    resolveArtifactRevisionMode('不要修改原文件名，另建一个新版本'),
    'create_copy',
  )
})

for (const format of [
  { type: 'pptx', tool: 'create_pptx', filename: 'original-deck.pptx' },
  { type: 'docx', tool: 'create_docx', filename: 'original-document.docx' },
  { type: 'xlsx', tool: 'create_xlsx', filename: 'original-workbook.xlsx' },
  { type: 'pdf', tool: 'create_pdf', filename: 'original-report.pdf' },
  { type: 'html', tool: 'create_html_app', filename: 'original-page.html' },
  { type: 'image', tool: 'generate_image', filename: 'original-image.png' },
  { type: 'image', tool: 'render_pdf_pages', filename: 'original-rendered-page.png' },
]) {
  for (const mode of ['replace_original', 'create_copy']) {
    test(`${format.tool} ${mode} executes the matching generator with the correct target disposition`, async () => {
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const turnId = `${format.tool}-${mode}-${suffix}`
      const originalId = `original-${format.type}-${suffix}`
      const originalFilename = `original-${suffix}.${format.type === 'image' ? 'png' : format.type}`
      const nextId = mode === 'replace_original' ? originalId : `copy-${format.type}-${suffix}`
      const nextFilename = mode === 'replace_original'
        ? originalFilename
        : `copy-${suffix}.${format.type === 'image' ? 'png' : format.type}`
      const prompt = mode === 'replace_original'
        ? '直接修改原版，保留原文件名，不要新建版本'
        : '基于上一版另建一个新文件，保留原版'
      persistStubTurnArtifact({
        turnId: `seed-${turnId}`,
        id: originalId,
        filename: originalFilename,
        type: format.type,
      })
      const history = [
        ...deliveredArtifactMessages({
          prefix: `history-${turnId}`,
          tool: format.tool,
          artifactId: originalId,
          filename: originalFilename,
          type: format.type,
        }),
        { role: 'user', content: prompt },
      ]
      const executions = []
      let modelCalls = 0

      const result = await runToolsLoop({
        job: {
          id: turnId,
          userId: INTENT_ARTIFACT_USER_ID,
          sessionId: INTENT_ARTIFACT_SESSION_ID,
          origin: 'chat',
          prompt,
          userPrompt: prompt,
        },
        step: { id: turnId, kind: 'chat' },
        messages: history,
        intentMode: 'execute',
        toolSpecs: SERVER_TOOL_SPECS,
        enableToolHooks: false,
        requestToolApproval: async ({ args }) => ({ proceed: true, args }),
        executeTool: async ({ name, args }) => {
          executions.push({ name, args })
          assert.equal(name, format.tool)
          if (mode === 'replace_original') {
            assert.equal(args.replace_artifact_id, originalId)
            return {
              ok: true,
              artifactId: originalId,
              filename: originalFilename,
              type: format.type,
              url: `/api/artifacts/${originalFilename}`,
            }
          }
          assert.equal(String(args.replace_artifact_id || ''), '')
          return persistStubTurnArtifact({
            turnId,
            id: nextId,
            filename: nextFilename,
            type: format.type,
          })
        },
        runModel: async ({ tools }) => {
          modelCalls += 1
          const visible = nameOf(tools)
          for (const generator of ARTIFACT_GENERATOR_NAMES) {
            assert.equal(
              visible.includes(generator),
              generator === format.tool,
              `${format.tool} ${mode}: ${generator}`,
            )
          }
          if (modelCalls === 1) {
            return {
              content: '',
              toolCalls: [{
                id: `${turnId}-create`,
                type: 'function',
                function: {
                  name: format.tool,
                  arguments: JSON.stringify(validArtifactArgs(format.tool)),
                },
              }],
            }
          }
          if (modelCalls === 2) {
            return {
              content: '',
              toolCalls: [{
                id: `${turnId}-select`,
                type: 'function',
                function: {
                  name: 'set_deliverables',
                  arguments: JSON.stringify({ artifact_ids: [nextId] }),
                },
              }],
            }
          }
          return { content: '文件已通过工具生成并交付。', toolCalls: [] }
        },
      })

      assert.equal(modelCalls, 3)
      assert.equal(executions.length, 1)
      assert.deepEqual(result.artifactIds, [nextId])
      assert.deepEqual(result.deliveryArtifactIds, [nextId])
      assert.equal(result.text, '文件已通过工具生成并交付。')
    })
  }
}

test('an exact filename recovers a delivered artifact across one failed turn', () => {
  const messages = [
    ...adjacentHtmlRevisionMessages('把配色改一下'),
    { role: 'assistant', content: 'The previous revision failed.' },
    { role: 'user', content: '继续修改原版 产品网页.html，不要新建版本' },
  ]
  assert.deepEqual(findAdjacentDeliveredArtifacts(messages), [])
  assert.deepEqual(findExplicitlyReferencedDeliveredArtifacts(
    messages,
    '继续修改原版 产品网页.html，不要新建版本',
  ), [{
    id: 'previous-html-artifact',
    type: 'html',
    filename: '产品网页.html',
    url: '/api/artifacts/previous-html-artifact',
    toolName: 'create_html_app',
  }])
  assert.deepEqual(
    findExplicitlyReferencedDeliveredArtifacts(messages, '继续修改刚才的网页'),
    [],
  )
})

test('exact artifact references use complete filename and ID boundaries', () => {
  const artifactId = 'artifact-app-html'
  const base = deliveredHtmlTurn({ prefix: 'boundary', artifactId, filename: 'app.html' })
  const exactPrompt = '直接修改app.html的背景，不要新建版本'
  assert.deepEqual(
    findExplicitlyReferencedDeliveredArtifacts([...base, { role: 'user', content: exactPrompt }], exactPrompt)
      .map((artifact) => artifact.id),
    [artifactId],
  )
  for (const prompt of [
    '直接修改myapp.html，不要新建版本',
    '直接修改 app.htmlx，不要新建版本',
    '直接修改 artifact-app-html-copy，不要新建版本',
  ]) {
    assert.deepEqual(
      findExplicitlyReferencedDeliveredArtifacts([...base, { role: 'user', content: prompt }], prompt),
      [],
      prompt,
    )
  }
})

test('an exact older filename overrides the adjacent artifact before UI and checkpoint persistence', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const oldId = `older-html-${suffix}`
  const adjacentId = `adjacent-html-${suffix}`
  const oldFilename = `older-page-${suffix}.html`
  const adjacentFilename = `adjacent-page-${suffix}.html`
  const turnId = `older-file-revision-${suffix}`
  persistStubTurnArtifact({ turnId: `seed-old-${suffix}`, id: oldId, filename: oldFilename, type: 'html' })
  persistStubTurnArtifact({ turnId: `seed-new-${suffix}`, id: adjacentId, filename: adjacentFilename, type: 'html' })
  const prompt = `直接修改原版 ${oldFilename}，背景改成浅绿色，不要新建版本`
  const messages = [
    ...deliveredHtmlTurn({ prefix: `old-${suffix}`, artifactId: oldId, filename: oldFilename }),
    ...deliveredHtmlTurn({ prefix: `new-${suffix}`, artifactId: adjacentId, filename: adjacentFilename }),
    { role: 'user', content: prompt },
  ]
  const scheduledCalls = []
  const checkpoints = []
  let executionArgs = null
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: turnId, kind: 'chat' },
    messages,
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onToolCall: async (call) => scheduledCalls.push(JSON.parse(JSON.stringify(call))),
    saveCheckpoint: async (state) => {
      checkpoints.push(JSON.parse(JSON.stringify(state)))
      return true
    },
    executeTool: async ({ name, args }) => {
      assert.equal(name, 'create_html_app')
      executionArgs = args
      return {
        ok: true,
        artifactId: oldId,
        filename: oldFilename,
        url: `/api/artifacts/${oldFilename}`,
      }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: `replace-older-${suffix}`,
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Older page revised',
                html: '<!doctype html><html><body style="background:#c8f7c5">older</body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: `deliver-older-${suffix}`,
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [oldId] }),
            },
          }],
        }
      }
      return { content: '旧文件已原地修改。', toolCalls: [] }
    },
  })

  assert.equal(executionArgs?.replace_artifact_id, oldId)
  assert.notEqual(executionArgs?.replace_artifact_id, adjacentId)
  const scheduledCreate = scheduledCalls.find((call) => call.name === 'create_html_app')
  assert.equal(scheduledCreate?.args?.replace_artifact_id, oldId)
  const pending = checkpoints.find((state) => state.toolCalls?.some((call) => (
    call.name === 'create_html_app' && call.checkpointStatus === 'pending'
  )))
  const persistedCreate = pending?.toolCalls?.find((call) => call.name === 'create_html_app')
  assert.equal(persistedCreate?.args?.replace_artifact_id, oldId)
  assert.equal(JSON.parse(persistedCreate?.argumentsText || '{}').replace_artifact_id, oldId)
  const assistantCreate = pending?.messages?.findLast((message) => (
    message?.role === 'assistant'
      && message.tool_calls?.some((call) => call.function?.name === 'create_html_app')
  ))
  const assistantArgs = JSON.parse(
    assistantCreate?.tool_calls?.find((call) => call.function?.name === 'create_html_app')
      ?.function?.arguments || '{}',
  )
  assert.equal(assistantArgs.replace_artifact_id, oldId)
  assert.deepEqual(result.deliveryArtifactIds, [oldId])
})

test('a restored pending in-place call keeps normalized args synchronized before execution', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const artifactId = `restored-html-${suffix}`
  const filename = `restored-page-${suffix}.html`
  const turnId = `restored-revision-${suffix}`
  const createCallId = `restored-create-${suffix}`
  persistStubTurnArtifact({ turnId: `seed-restored-${suffix}`, id: artifactId, filename, type: 'html' })
  const prompt = `直接修改原版 ${filename}，保留原文件名，不要新建版本`
  const baseMessages = [
    ...deliveredHtmlTurn({ prefix: `restored-${suffix}`, artifactId, filename }),
    { role: 'user', content: prompt },
  ]
  const originalArgs = {
    title: 'Restored revision',
    html: '<!doctype html><html><body>restored</body></html>',
  }
  const checkpoint = {
    messages: [
      ...baseMessages,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: createCallId,
          type: 'function',
          function: {
            name: 'create_html_app',
            arguments: JSON.stringify(originalArgs),
          },
        }],
      },
    ],
    toolCalls: [{
      id: createCallId,
      name: 'create_html_app',
      args: originalArgs,
      argumentsText: JSON.stringify(originalArgs),
      parseError: null,
      checkpointStatus: 'pending',
      checkpointApprovalId: null,
    }],
    artifactIds: [],
    iterations: 0,
  }
  const checkpoints = []
  let executionArgs = null
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: turnId, kind: 'chat' },
    messages: baseMessages,
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoints.push(JSON.parse(JSON.stringify(state)))
      return true
    },
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args }) => {
      assert.equal(name, 'create_html_app')
      executionArgs = args
      return {
        ok: true,
        artifactId,
        filename,
        url: `/api/artifacts/${filename}`,
      }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: `restored-deliver-${suffix}`,
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [artifactId] }),
            },
          }],
        }
      }
      return { content: '恢复后已完成原地修改。', toolCalls: [] }
    },
  })

  assert.equal(executionArgs?.replace_artifact_id, artifactId)
  const executing = checkpoints.find((state) => state.toolCalls?.some((call) => (
    call.id === createCallId && call.checkpointStatus === 'executing'
  )))
  const persistedCall = executing?.toolCalls?.find((call) => call.id === createCallId)
  assert.equal(persistedCall?.args?.replace_artifact_id, artifactId)
  assert.equal(JSON.parse(persistedCall?.argumentsText || '{}').replace_artifact_id, artifactId)
  const persistedAssistant = executing?.messages?.findLast((message) => (
    message?.role === 'assistant' && message.tool_calls?.some((call) => call.id === createCallId)
  ))
  assert.equal(
    JSON.parse(persistedAssistant?.tool_calls?.find((call) => call.id === createCallId)?.function?.arguments || '{}')
      .replace_artifact_id,
    artifactId,
  )
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
})

for (const scenario of [
  {
    label: 'a non-empty wrong replacement ID is rejected instead of being silently retargeted',
    modelReplacementId: 'unauthorized-model-target',
    rewriteApproval: false,
  },
  {
    label: 'an approval-edited replacement ID is revalidated immediately before execution',
    modelReplacementId: null,
    rewriteApproval: true,
  },
]) {
  test(scenario.label, async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const artifactId = `guarded-html-${suffix}`
    const filename = `guarded-page-${suffix}.html`
    const turnId = `guarded-revision-${suffix}`
    persistStubTurnArtifact({ turnId: `seed-${suffix}`, id: artifactId, filename, type: 'html' })
    const prompt = `直接修改原版 ${filename}，不要新建版本`
    const messages = [
      ...deliveredHtmlTurn({ prefix: `guarded-${suffix}`, artifactId, filename }),
      { role: 'user', content: prompt },
    ]
    const outcomes = []
    let executions = 0
    let approvalCalls = 0

    await assert.rejects(
      runToolsLoop({
        job: {
          id: turnId,
          userId: INTENT_ARTIFACT_USER_ID,
          sessionId: INTENT_ARTIFACT_SESSION_ID,
          origin: 'chat',
          prompt,
          userPrompt: prompt,
        },
        step: { id: turnId, kind: 'chat' },
        messages,
        toolSpecs: SERVER_TOOL_SPECS,
        maxIters: 1,
        enableToolHooks: false,
        requestToolApproval: async ({ args }) => {
          approvalCalls += 1
          assert.equal(args.replace_artifact_id, artifactId)
          return {
            proceed: true,
            args: scenario.rewriteApproval
              ? { ...args, replace_artifact_id: 'unauthorized-approval-target' }
              : args,
          }
        },
        executeTool: async () => {
          executions += 1
          return { ok: true, artifactId }
        },
        onToolCompleted: async (outcome) => outcomes.push(outcome),
        runModel: async () => ({
          content: '',
          toolCalls: [{
            id: `guarded-create-${suffix}`,
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Guarded revision',
                html: '<!doctype html><html><body>guarded</body></html>',
                ...(scenario.modelReplacementId
                  ? { replace_artifact_id: scenario.modelReplacementId }
                  : {}),
              }),
            },
          }],
        }),
      }),
      (error) => error?.code === 'ARTIFACT_NOT_CREATED',
    )

    assert.equal(executions, 0)
    assert.equal(approvalCalls, scenario.rewriteApproval ? 1 : 0)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].result?.code, 'artifact_replacement_not_authorized')
  })
}

test('a terse adjacent webpage critique creates and delivers a new file without a skill', async () => {
  const currentPrompt = '这个按钮不好看'
  const nextArtifactId = `revision-html-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: `revision-turn-${nextArtifactId}`,
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt: currentPrompt,
      userPrompt: currentPrompt,
    },
    step: { id: `revision-turn-${nextArtifactId}`, kind: 'chat' },
    messages: adjacentHtmlRevisionMessages(currentPrompt),
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args }) => {
      assert.equal(name, 'create_html_app')
      assert.match(args.html, /font-size:12px/)
      return persistStubTurnArtifact({
        turnId: `revision-turn-${nextArtifactId}`,
        id: nextArtifactId,
        filename: `${nextArtifactId}.html`,
        type: 'html',
      })
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        assert.ok(tools.some((tool) => tool.function.name === 'create_html_app'))
        assert.ok(messages.some((message) => String(message.content || '').includes('[ADJACENT ARTIFACT REVISION CONTRACT]')))
        return {
          content: '',
          toolCalls: [{
            id: 'revision-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: '产品网页-修订版',
                html: '<!doctype html><html><body><main><button style="font-size:12px">开始</button></main></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'revision-delivery-call',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [nextArtifactId] }),
            },
          }],
        }
      }
      return { content: '已直接修改并生成新的网页文件。', toolCalls: [] }
    },
  })
  assert.deepEqual(result.artifactIds, [nextArtifactId])
  assert.deepEqual(result.deliveryArtifactIds, [nextArtifactId])
  assert.equal(result.text, '已直接修改并生成新的网页文件。')
})

test('chat project-check turn does not inherit artifact generators from an older Word request', async () => {
  const currentPrompt = 'Run only run_project_check and report whether the project tests pass.'
  let visibleNames = []
  let modelCalls = 0
  const executions = []

  const result = await runToolsLoop({
    job: {
      id: 'chat-project-check-after-word',
      userId: 'intent-user',
      origin: 'chat',
      prompt: currentPrompt,
      userPrompt: currentPrompt,
    },
    step: { id: 'chat-project-check-after-word', kind: 'chat' },
    messages: [
      { role: 'user', content: 'Create a Word document with the release notes.' },
      { role: 'assistant', content: 'The Word document is ready.' },
      { role: 'user', content: currentPrompt },
    ],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        visibleNames = nameOf(tools)
        return {
          content: '',
          toolCalls: [{
            id: 'project-check-only',
            type: 'function',
            function: { name: 'run_project_check', arguments: JSON.stringify({ check: 'test' }) },
          }],
        }
      }
      return { content: 'Project checks passed.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executions.push(name)
      return { ok: true, check: 'test', exitCode: 0, stdout: 'passed', stderr: '' }
    },
  })

  assert.ok(visibleNames.includes('run_project_check'))
  for (const name of ARTIFACT_GENERATOR_NAMES) {
    assert.equal(visibleNames.includes(name), false, `${name} leaked into a project-check-only turn`)
  }
  assert.deepEqual(executions, ['run_project_check'])
  assert.deepEqual(result.artifactIds, [])
})

for (const generatorName of ARTIFACT_GENERATOR_NAMES) {
  test(`chat project-check turn rejects forged ${generatorName} before execution`, async () => {
    const currentPrompt = 'Run only run_project_check and report whether the project tests pass.'
    const outcomes = []
    let attempted = false
    let executorCalls = 0

    await runToolsLoop({
      job: {
        id: `chat-forged-${generatorName}`,
        userId: 'intent-user',
        origin: 'chat',
        prompt: currentPrompt,
        userPrompt: currentPrompt,
      },
      step: { id: `chat-forged-${generatorName}`, kind: 'chat' },
      messages: [{ role: 'user', content: currentPrompt }],
      intentMode: 'execute',
      toolSpecs: SERVER_TOOL_SPECS,
      maxIters: 1,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async ({ toolChoice }) => {
        if (toolChoice === 'none' || attempted) return { content: 'The forged call was rejected.', toolCalls: [] }
        attempted = true
        return {
          content: '',
          toolCalls: [{
            id: `forged-${generatorName}`,
            type: 'function',
            function: {
              name: generatorName,
              arguments: JSON.stringify(forgedArtifactArgs(generatorName)),
            },
          }],
        }
      },
      executeTool: async () => {
        executorCalls += 1
        return { ok: true, artifactId: `unexpected-${generatorName}` }
      },
      onToolCompleted: async (outcome) => outcomes.push(outcome),
    })

    assert.equal(executorCalls, 0)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].result?.ok, false)
    assert.equal(outcomes[0].result?.code, 'artifact_tool_not_requested')
    assert.equal(outcomes[0].artifactId, null)
  })
}

for (const stepKind of ['plan', 'verify', 'finalize']) {
  test(`${stepKind} step neither exposes nor executes artifact generators from the original Word prompt`, async () => {
    const outcomes = []
    const executions = []
    let visibleNames = []
    let attempted = false

    await runToolsLoop({
      job: {
        id: `${stepKind}-word-scope`,
        userId: 'intent-user',
        origin: 'job',
        prompt: 'Create a Word document with the quarterly report.',
      },
      step: { id: `${stepKind}-word-scope`, kind: stepKind, input: { acceptance: [] } },
      messages: [{
        role: 'user',
        content: 'Original task: Create a Word document with the quarterly report. Inspect and report verification evidence only.',
      }],
      intentMode: 'execute',
      executionGuardMode: 'read_only_exploration',
      toolSpecs: SERVER_TOOL_SPECS,
      maxIters: 1,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async ({ tools, toolChoice }) => {
        if (toolChoice === 'none' || attempted) return { content: `${stepKind} complete.`, toolCalls: [] }
        attempted = true
        visibleNames = nameOf(tools)
        return {
          content: '',
          toolCalls: ['create_docx', 'generate_image'].map((name) => ({
            id: `${stepKind}-forged-${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(forgedArtifactArgs(name)) },
          })),
        }
      },
      executeTool: async ({ name }) => {
        executions.push(name)
        return { ok: true, artifactId: `unexpected-${stepKind}-${name}` }
      },
      onToolCompleted: async (outcome) => outcomes.push(outcome),
    })

    assert.ok(visibleNames.includes('run_project_check'))
    for (const name of ARTIFACT_GENERATOR_NAMES) {
      assert.equal(visibleNames.includes(name), false, `${name} leaked into the ${stepKind} step`)
    }
    assert.deepEqual(executions, [])
    assert.deepEqual(outcomes.map((outcome) => outcome.result?.code), [
      'artifact_tool_not_requested',
      'artifact_tool_not_requested',
    ])
    assert.ok(outcomes.every((outcome) => outcome.artifactId === null))
  })
}

test('verify checkpoint resume rejects pending artifact generators before execution', async () => {
  const currentPrompt = 'Original task: Create a Word document. Resume verification and report evidence only.'
  const pendingCalls = ['create_docx', 'generate_image'].map((name) => ({
    id: `checkpoint-${name}`,
    name,
    args: forgedArtifactArgs(name),
    argumentsText: JSON.stringify(forgedArtifactArgs(name)),
    parseError: null,
    checkpointStatus: 'pending',
    checkpointApprovalId: null,
  }))
  const checkpoint = {
    messages: [
      { role: 'user', content: currentPrompt },
      {
        role: 'assistant',
        content: null,
        tool_calls: pendingCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argumentsText },
        })),
      },
    ],
    toolCalls: pendingCalls,
    artifactIds: [],
    iterations: 0,
  }
  const outcomes = []
  let executorCalls = 0
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'verify-artifact-checkpoint',
      userId: 'intent-user',
      origin: 'job',
      prompt: 'Create a Word document.',
    },
    step: { id: 'verify-artifact-checkpoint', kind: 'verify', input: { acceptance: [] } },
    messages: [{ role: 'user', content: currentPrompt }],
    intentMode: 'execute',
    executionGuardMode: 'read_only_exploration',
    toolSpecs: SERVER_TOOL_SPECS,
    maxIters: 2,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async () => true,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async () => {
      executorCalls += 1
      return { ok: true, artifactId: 'unexpected-checkpoint-artifact' }
    },
    onToolCompleted: async (outcome) => outcomes.push(outcome),
    runModel: async ({ messages }) => {
      modelCalls += 1
      const codes = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).code)
      assert.deepEqual(codes, ['artifact_tool_not_requested', 'artifact_tool_not_requested'])
      return { content: 'Checkpoint artifact calls were rejected.', toolCalls: [] }
    },
  })

  assert.equal(executorCalls, 0)
  assert.equal(modelCalls, 1)
  assert.deepEqual(outcomes.map((outcome) => outcome.result?.code), [
    'artifact_tool_not_requested',
    'artifact_tool_not_requested',
  ])
  assert.ok(outcomes.every((outcome) => outcome.artifactId === null))
  assert.deepEqual(result.artifactIds, [])
})

test('reporting execution evidence is not mistaken for a DOCX request', () => {
  for (const prompt of [
    '请报告真实 exitCode；不要只口头说明。',
    '然后报告测试结果和 stdout。',
    '请报告当前状态与错误原因。',
    'Please report the actual exit code and test result.',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
    assert.equal(allowedArtifactTools(prompt).has('create_docx'), false, prompt)
  }

  for (const prompt of [
    '请生成一份测试报告',
    '写一份报告说明测试结果',
    'Create a report of the actual exit code',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, true, prompt)
  }
})

test('slash skill unlocks its matching artifact tool', () => {
  assert.equal(parseSkillIdFromPrompt('/ppt 讲讲量子计算'), 'ppt')
  for (const alias of ['htmlppt', 'axippt', 'ppt-master', 'guizang-ppt']) {
    assert.equal(parseSkillIdFromPrompt(`/${alias} 做演示`), 'ppt')
  }
  const names = nameOf(selectJobToolSpecs({ prompt: '/excel 汇总季度数据', skillId: 'excel' }))
  assert.ok(names.includes('create_xlsx'))
  assert.ok(!names.includes('create_pptx'))

  const webpageNames = nameOf(selectJobToolSpecs({
    prompt: '/webpage 帮我生成一个网页来介绍本地模型',
    skillId: 'webpage',
  }))
  assert.ok(webpageNames.includes('create_html_app'))
  assert.ok(!webpageNames.includes('create_pptx'))
})

test('slash artifact skills stay locked to one generator unless multiple file formats are explicit', () => {
  assert.deepEqual(
    detectArtifactIntent('/webpage build a website for a quarterly report'),
    { pptx: false, docx: false, xlsx: false, html: true, pdf: false, image: false },
  )
  assert.deepEqual(
    detectArtifactIntent('/doc create a report with a spreadsheet-style table'),
    { pptx: false, docx: true, xlsx: false, html: false, pdf: false, image: false },
  )
  assert.deepEqual(
    detectArtifactIntent('/ppt present the quarterly report'),
    { pptx: true, docx: false, xlsx: false, html: false, pdf: false, image: false },
  )
  assert.deepEqual(
    [...allowedArtifactTools('/webpage build a website and also export a Word document')].sort(),
    ['create_docx', 'create_html_app'],
  )
})

test('an existing-image gallery request completes after the HTML artifact without an image gate', async () => {
  const prompt = '"E:\\果"这个地方有很多人物图片，用这些人物图片你来写一个网站，确保该文件下的所有内容都被使用，我想在网站看这些，这样更方便，写到D盘'
  const executions = []
  const visibleToolNames = []
  const modelMessages = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'existing-image-gallery-html-only',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
    },
    step: { id: 'existing-image-gallery-html-only', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      assert.equal(name, 'create_html_app')
      return persistStubTurnArtifact({
        turnId: 'existing-image-gallery-html-only',
        id: 'existing-image-gallery-html',
        filename: '果-图片画廊.html',
        type: 'html',
      })
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      visibleToolNames.push(nameOf(tools))
      modelMessages.push(messages.map((message) => String(message.content || '')).join('\n'))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'create-existing-image-gallery',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: '果·图片画廊',
                html: '<!doctype html><html><body><main>人物图片画廊</main></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-existing-image-gallery',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['existing-image-gallery-html'] }),
            },
          }],
        }
      }
      return { content: '图片画廊网页已生成。', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.deepEqual(executions, ['create_html_app'])
  assert.deepEqual(result.artifactIds, ['existing-image-gallery-html'])
  assert.deepEqual(result.deliveryArtifactIds, ['existing-image-gallery-html'])
  assert.equal(result.text, '图片画廊网页已生成。')
  assert.ok(visibleToolNames.every((names) => names.includes('create_html_app')))
  assert.ok(visibleToolNames.every((names) => !names.includes('generate_image')))
  assert.ok(modelMessages.every((message) => !message.includes('must successfully call: generate_image')))
})

for (const scenario of [
  {
    prompt: '使用已有 budget.xlsx 制作一份 PPT 演示文稿',
    tool: 'create_pptx',
    type: 'pptx',
    filename: 'from-existing-workbook.pptx',
  },
  {
    prompt: '读取已有 report.pdf，生成 Word 文档',
    tool: 'create_docx',
    type: 'docx',
    filename: 'from-existing-pdf.docx',
  },
  {
    prompt: '基于现有 notes.docx 创建 Excel 工作簿',
    tool: 'create_xlsx',
    type: 'xlsx',
    filename: 'from-existing-document.xlsx',
  },
  {
    prompt: '把 Word 文档转成网页',
    tool: 'create_html_app',
    type: 'html',
    filename: 'from-existing-document.html',
  },
  {
    prompt: '把图片转成 PDF',
    tool: 'create_pdf',
    type: 'pdf',
    filename: 'from-existing-image.pdf',
  },
  {
    prompt: '把 PDF 转成图片',
    tool: 'render_pdf_pages',
    type: 'image',
    filename: 'from-existing-pdf.png',
  },
]) {
  test(`${scenario.tool} alone satisfies its input-to-output artifact contract`, async () => {
    const turnId = `single-artifact-contract-${scenario.tool}`
    const artifactId = `single-artifact-${scenario.tool}`
    const executions = []
    const modelContexts = []
    let modelCalls = 0

    const result = await runToolsLoop({
      job: {
        id: turnId,
        userId: INTENT_ARTIFACT_USER_ID,
        sessionId: INTENT_ARTIFACT_SESSION_ID,
        origin: 'chat',
        prompt: scenario.prompt,
        userPrompt: scenario.prompt,
      },
      step: { id: turnId, kind: 'chat' },
      messages: [{ role: 'user', content: scenario.prompt }],
      intentMode: 'execute',
      toolSpecs: SERVER_TOOL_SPECS,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      executeTool: async ({ name }) => {
        executions.push(name)
        assert.equal(name, scenario.tool)
        return persistStubTurnArtifact({
          turnId,
          id: artifactId,
          filename: scenario.filename,
          type: scenario.type,
        })
      },
      runModel: async ({ messages, tools }) => {
        modelCalls += 1
        const visible = nameOf(tools)
        modelContexts.push(messages.map((message) => String(message.content || '')).join('\n'))
        for (const generator of ARTIFACT_GENERATOR_NAMES) {
          assert.equal(visible.includes(generator), generator === scenario.tool, `${scenario.prompt}: ${generator}`)
        }
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `${turnId}-create`,
              function: {
                name: scenario.tool,
                arguments: JSON.stringify(validArtifactArgs(scenario.tool)),
              },
            }],
          }
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [{
              id: `${turnId}-select`,
              function: {
                name: 'set_deliverables',
                arguments: JSON.stringify({ artifact_ids: [artifactId] }),
              },
            }],
          }
        }
        return { content: '文件已生成并交付。', toolCalls: [] }
      },
    })

    assert.equal(modelCalls, 3)
    assert.deepEqual(executions, [scenario.tool])
    assert.deepEqual(result.artifactIds, [artifactId])
    assert.deepEqual(result.deliveryArtifactIds, [artifactId])
    assert.equal(result.text, '文件已生成并交付。')
    for (const otherTool of ARTIFACT_GENERATOR_NAMES.filter((name) => name !== scenario.tool)) {
      assert.ok(modelContexts.every((context) => (
        !context.includes(`must successfully call: ${otherTool}`)
      )), `${scenario.prompt}: completion guard required ${otherTool}`)
    }
  })
}

test('a real webpage and new-image request still blocks completion until both artifacts exist', async () => {
  const prompt = '生成图片并做网站'
  const executions = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'html-and-new-image-delivery',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
    },
    step: { id: 'html-and-new-image-delivery', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      return name === 'create_html_app'
        ? persistStubTurnArtifact({
            turnId: 'html-and-new-image-delivery',
            id: 'dual-html-artifact',
            filename: 'dual-delivery.html',
            type: 'html',
          })
        : persistStubTurnArtifact({
            turnId: 'html-and-new-image-delivery',
            id: 'dual-image-artifact',
            filename: 'dual-delivery.png',
            type: 'png',
          })
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const names = nameOf(tools)
      assert.equal(names.includes('create_html_app'), true)
      assert.equal(names.includes('generate_image'), true)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'dual-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Dual delivery',
                html: '<!doctype html><html><body><main>Dual delivery</main></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) return { content: '网站和图片都已完成。', toolCalls: [] }
      if (modelCalls === 3) {
        assert.ok(messages.some((message) => String(message.content || '').includes('generate_image')))
        return {
          content: '',
          toolCalls: [{
            id: 'dual-image-call',
            function: {
              name: 'generate_image',
              arguments: JSON.stringify({ prompt: 'A new hero image' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-dual-delivery',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({
                artifact_ids: ['dual-html-artifact', 'dual-image-artifact'],
              }),
            },
          }],
        }
      }
      return { content: '网站和新图片均已生成。', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 5)
  assert.deepEqual(executions, ['create_html_app', 'generate_image'])
  assert.deepEqual(result.artifactIds, ['dual-html-artifact', 'dual-image-artifact'])
  assert.deepEqual(result.deliveryArtifactIds, ['dual-html-artifact', 'dual-image-artifact'])
  assert.equal(result.text, '网站和新图片均已生成。')
})

test('text tool protocol from a local model becomes a real webpage artifact call', async () => {
  const deltas = []
  const executions = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'webpage-text-protocol',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt: '/webpage 帮我生成一个网页',
    },
    step: { id: 'webpage-text-protocol', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage 帮我生成一个网页' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name, args }) => {
      executions.push({ name, args })
      return persistStubTurnArtifact({
        turnId: 'webpage-text-protocol',
        id: 'html-artifact-1',
        filename: 'local-model.html',
        type: 'html',
      })
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '<tool_call>{"name":"create_html_app","arguments":{"title":"本地模型","html":"<!doctype html><html><body><main>完成</main></body></html>"}}</tool_call>',
          toolCalls: [],
        }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => message.role === 'tool' && message.name === 'create_html_app'))
        return {
          content: '',
          toolCalls: [{
            id: 'select-local-model-html',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['html-artifact-1'] }),
            },
          }],
        }
      }
      return { content: '网页已生成。', toolCalls: [] }
    },
  })

  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'create_html_app')
  assert.match(executions[0].args.html, /<main>完成<\/main>/)
  assert.deepEqual(result.artifactIds, ['html-artifact-1'])
  assert.deepEqual(result.deliveryArtifactIds, ['html-artifact-1'])
  assert.equal(result.text, '网页已生成。')
  assert.equal(deltas.join('').includes('<tool_call>'), false)
})

test('webpage delivery retries natural-language fallback until a real artifact exists', async () => {
  const deltas = []
  const executions = []
  const visibleToolNames = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'webpage-delivery-guard',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt: '/webpage build a product page',
    },
    step: { id: 'webpage-delivery-guard', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage build a product page' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name, args }) => {
      executions.push({ name, args })
      return persistStubTurnArtifact({
        turnId: 'webpage-delivery-guard',
        id: 'guarded-html-1',
        filename: 'guarded-product.html',
        type: 'html',
      })
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      visibleToolNames.push(tools.map((tool) => tool.function.name))
      if (modelCalls === 1) {
        return { content: 'Copy this HTML into a new file and save it as product.html.', toolCalls: [] }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => String(message.content || '').includes('[PERSISTED ARTIFACT DELIVERY REQUIRED]')))
        return {
          content: '',
          toolCalls: [{
            id: 'guarded-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Product',
                html: '<!doctype html><html><body><main>Product</main></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-guarded-html',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['guarded-html-1'] }),
            },
          }],
        }
      }
      return { content: 'The webpage is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 4)
  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'create_html_app')
  assert.deepEqual(result.artifactIds, ['guarded-html-1'])
  assert.deepEqual(result.deliveryArtifactIds, ['guarded-html-1'])
  assert.equal(result.text, 'The webpage is ready.')
  assert.equal(deltas.join(''), 'The webpage is ready.')
  assert.equal(visibleToolNames[0].includes('request_directory'), false)
})

test('webpage delivery rejects handoff prose disguised as HTML and accepts the corrected tool call', async () => {
  const executions = []
  let modelCalls = 0
  const fakeHtml = `<!doctype html><html><body><main><p>
    网页代码已生成。复制上面的完整代码，新建文件并粘贴保存为 product.html，然后双击用浏览器打开。
  </p></main></body></html>`
  const realHtml = '<!doctype html><html><body><main><h1>Product</h1><section><p>Fast and reliable.</p></section></main></body></html>'

  const result = await runToolsLoop({
    job: {
      id: 'webpage-invalid-html-retry',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt: '/webpage build a product page',
    },
    step: { id: 'webpage-invalid-html-retry', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage build a product page' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args }) => {
      executions.push({ name, html: args.html })
      try {
        validateHtmlArtifactSource(args.html)
      } catch (error) {
        return { ok: false, code: 'invalid_html_artifact', error: error.message }
      }
      return persistStubTurnArtifact({
        turnId: 'webpage-invalid-html-retry',
        id: 'real-html-artifact',
        filename: 'validated-product.html',
        type: 'html',
      })
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'fake-html-call',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Product', html: fakeHtml }) },
          }],
        }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => (
          message.role === 'tool' && String(message.content || '').includes('delivery instructions')
        )))
        return {
          content: '',
          toolCalls: [{
            id: 'real-html-call',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Product', html: realHtml }) },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-real-html',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['real-html-artifact'] }),
            },
          }],
        }
      }
      return { content: 'The real webpage is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 4)
  assert.deepEqual(executions.map(({ name }) => name), ['create_html_app', 'create_html_app'])
  assert.deepEqual(result.artifactIds, ['real-html-artifact'])
  assert.deepEqual(result.deliveryArtifactIds, ['real-html-artifact'])
  assert.equal(result.text, 'The real webpage is ready.')
})

test('webpage slash skill does not require a docx for quarterly report content', async () => {
  const executions = []
  let modelCalls = 0
  const prompt = '/webpage build a website for a quarterly report'
  const result = await runToolsLoop({
    job: {
      id: 'webpage-quarterly-report',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
    },
    step: { id: 'webpage-quarterly-report', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      return persistStubTurnArtifact({
        turnId: 'webpage-quarterly-report',
        id: 'quarterly-html',
        filename: 'quarterly-report.html',
        type: 'html',
      })
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'quarterly-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Quarterly report',
                html: '<!doctype html><html><body><main>Quarterly report</main></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-quarterly-html',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['quarterly-html'] }),
            },
          }],
        }
      }
      return { content: 'The quarterly report website is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.deepEqual(executions, ['create_html_app'])
  assert.deepEqual(result.artifactIds, ['quarterly-html'])
  assert.deepEqual(result.deliveryArtifactIds, ['quarterly-html'])
  assert.equal(result.text, 'The quarterly report website is ready.')
})

test('a multi-file request without a slash skill still requires every requested artifact', async () => {
  const executions = []
  let modelCalls = 0
  const prompt = 'Create a Word document and export an Excel spreadsheet'
  const result = await runToolsLoop({
    job: {
      id: 'multi-artifact-request',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
    },
    step: { id: 'multi-artifact-request', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      const filename = name === 'create_docx' ? 'summary.docx' : 'summary.xlsx'
      return persistStubTurnArtifact({
        turnId: 'multi-artifact-request',
        id: `${name}-artifact`,
        filename,
        type: name === 'create_docx' ? 'docx' : 'xlsx',
      })
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'multi-docx-call',
              function: {
                name: 'create_docx',
                arguments: JSON.stringify({ title: 'Summary', paragraphs: [{ text: 'Summary' }] }),
              },
            },
            {
              id: 'multi-xlsx-call',
              function: {
                name: 'create_xlsx',
                arguments: JSON.stringify({ title: 'Summary', sheets: [{ name: 'Data', rows: [['Item'], ['Value']] }] }),
              },
            },
          ],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-multi-artifacts',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({
                artifact_ids: ['create_docx-artifact', 'create_xlsx-artifact'],
              }),
            },
          }],
        }
      }
      return { content: 'Both files are ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.deepEqual(executions.sort(), ['create_docx', 'create_xlsx'])
  assert.deepEqual(result.artifactIds.sort(), ['create_docx-artifact', 'create_xlsx-artifact'])
  assert.deepEqual(result.deliveryArtifactIds.sort(), ['create_docx-artifact', 'create_xlsx-artifact'])
  assert.equal(result.text, 'Both files are ready.')
})

for (const delivery of [
  { label: 'HTML', skillId: 'webpage', prompt: '/webpage build a product page' },
  { label: 'PPTX', skillId: 'ppt', prompt: '/ppt build a product deck' },
  { label: 'DOCX', skillId: 'doc', prompt: '/doc build a product brief' },
  { label: 'XLSX', skillId: 'excel', prompt: '/excel build a product table' },
  { label: 'PDF', skillId: 'pdf', prompt: '/pdf build a product report' },
  { label: 'image', skillId: 'image', prompt: '/image create a product hero image' },
]) {
  test(`${delivery.label} delivery fails explicitly instead of completing with a fake preview`, async () => {
    await assert.rejects(
      runToolsLoop({
        job: { id: `${delivery.skillId}-delivery-failure`, userId: 'intent-user', origin: 'chat', prompt: delivery.prompt },
        step: { id: `${delivery.skillId}-delivery-failure`, kind: 'chat' },
        messages: [{ role: 'user', content: delivery.prompt }],
        skillId: delivery.skillId,
        toolSpecs: SERVER_TOOL_SPECS,
        maxIters: 2,
        enableToolHooks: false,
        runModel: async () => ({ content: 'The requested file is ready. Save this answer locally.', toolCalls: [] }),
      }),
      (error) => error?.code === 'ARTIFACT_NOT_CREATED',
    )
  })
}

test('an image artifact cannot satisfy a webpage delivery requirement', async () => {
  const deltas = []
  const executions = []
  let modelCalls = 0
  const prompt = '/webpage build a product page and also create a hero image'
  const result = await runToolsLoop({
    job: {
      id: 'webpage-image-bypass',
      userId: INTENT_ARTIFACT_USER_ID,
      sessionId: INTENT_ARTIFACT_SESSION_ID,
      origin: 'chat',
      prompt,
    },
    step: { id: 'webpage-image-bypass', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name }) => {
      executions.push(name)
      return name === 'generate_image'
        ? persistStubTurnArtifact({
            turnId: 'webpage-image-bypass',
            id: 'image-artifact',
            filename: 'hero.png',
            type: 'png',
          })
        : persistStubTurnArtifact({
            turnId: 'webpage-image-bypass',
            id: 'html-artifact',
            filename: 'image-bypass-product.html',
            type: 'html',
          })
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'hero-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'hero' }) } }],
        }
      }
      if (modelCalls === 2) return { content: 'The webpage is ready.', toolCalls: [] }
      if (modelCalls === 3) {
        assert.ok(messages.some((message) => String(message.content || '').includes('create_html_app')))
        return {
          content: '',
          toolCalls: [{
            id: 'html-after-image',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({ title: 'Product', html: '<!doctype html><html><body><main>Product</main></body></html>' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-image-and-html',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: ['image-artifact', 'html-artifact'] }),
            },
          }],
        }
      }
      return { content: 'The real webpage is ready.', toolCalls: [] }
    },
  })

  assert.deepEqual(executions, ['generate_image', 'create_html_app'])
  assert.deepEqual(result.artifactIds, ['image-artifact', 'html-artifact'])
  assert.deepEqual(result.deliveryArtifactIds, ['image-artifact', 'html-artifact'])
  assert.equal(modelCalls, 5)
  assert.equal(result.text, 'The real webpage is ready.')
  assert.equal(deltas.join(''), 'The real webpage is ready.')
})

test('text tool protocol ids stay unique across model iterations', async () => {
  const executions = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'local-text-turn', userId: 'intent-user', origin: 'chat', prompt: '搜索两次并总结' },
    step: { id: 'local-text-step', kind: 'chat' },
    messages: [{ role: 'user', content: '搜索两次并总结' }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args, toolCallId, idempotencyKey }) => {
      executions.push({ name, args, toolCallId, idempotencyKey })
      return { ok: true, results: [] }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls <= 2) {
        return {
          content: `<tool_call>{"name":"web_search","arguments":{"query":"round-${modelCalls}"}}</tool_call>`,
          toolCalls: [],
        }
      }
      return { content: '两轮搜索均已完成。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '两轮搜索均已完成。')
  assert.equal(executions.length, 2)
  assert.deepEqual(executions.map((entry) => entry.toolCallId), [
    'text-tool-local-text-turn-i1-c1',
    'text-tool-local-text-turn-i2-c1',
  ])
  assert.equal(new Set(executions.map((entry) => entry.idempotencyKey)).size, 2)
  assert.match(executions[0].idempotencyKey, /text-tool-local-text-turn-i1-c1$/)
  assert.match(executions[1].idempotencyKey, /text-tool-local-text-turn-i2-c1$/)
})

test('environment flags cannot disable the artifact safety gate', () => {
  const prev = process.env.JOB_ARTIFACT_TOOL_GATE
  process.env.JOB_ARTIFACT_TOOL_GATE = 'off'
  try {
    const names = nameOf(selectJobToolSpecs({ prompt: '修一个 bug' }))
    assert.equal(names.includes('create_pptx'), false)
    assert.equal(names.includes('create_docx'), false)
    assert.equal(names.includes('create_xlsx'), false)
  } finally {
    if (prev === undefined) delete process.env.JOB_ARTIFACT_TOOL_GATE
    else process.env.JOB_ARTIFACT_TOOL_GATE = prev
  }
})

test('hallucinated PPT calls are rejected before any executor runs', async () => {
  let modelCalls = 0
  let executorCalls = 0
  let toolResult
  await runToolsLoop({
    job: { id: 'no-ppt', userId: 'intent-user', prompt: '修复自动生成 PPT 的问题' },
    step: { id: 'no-ppt-step' },
    messages: [{ role: 'user', content: '不要生成 PPT，只修复问题' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{ id: 'bad-ppt', name: 'create_pptx', arguments: '{"title":"wrong","slides":[]}' }] }
      }
      toolResult = messages.find((message) => message.role === 'tool')
      return { content: '已拒绝未授权产物并继续处理原任务。', toolCalls: [] }
    },
    executeTool: async () => {
      executorCalls += 1
      return { ok: true }
    },
  })
  assert.equal(executorCalls, 0)
  assert.equal(JSON.parse(toolResult.content).code, 'artifact_tool_not_requested')
})

// ── 意图判定 ─────────────────────────────────────────────────────────

test('ppt intent suppresses the looser docx keywords', () => {
  const intent = detectArtifactIntent('生成 PPT 并导出')
  assert.equal(intent.pptx, true)
  assert.equal(intent.docx, false, '「导出」不该在已有 pptx 意图时再触发 docx')
  assert.deepEqual(detectArtifactIntent('Make a PPT report'), {
    pptx: true, docx: false, xlsx: false, html: false, pdf: false, image: false,
  })
  assert.deepEqual(detectArtifactIntent('做一份 PPT 汇报'), {
    pptx: true, docx: false, xlsx: false, html: false, pdf: false, image: false,
  })
  assert.deepEqual(detectArtifactIntent('同时生成 PPT 以及 Word 文档'), {
    pptx: true, docx: true, xlsx: false, html: false, pdf: false, image: false,
  })
  assert.equal(shouldCompileDocx('生成 PPT 并导出'), false)
})

test('artifact expectation is false for plain code work', () => {
  assert.equal(expectsFileArtifact('把登录接口的 500 错误修掉'), false)
  assert.equal(allowedArtifactTools('把登录接口的 500 错误修掉').size, 0)
})

test('prebuilt tool specs do not short-circuit intent re-evaluation', async () => {
  let visibleNames = []
  let modelCalls = 0
  await runToolsLoop({
    job: { id: 'intent-recheck', userId: 'intent-user', prompt: '先分析数据' },
    step: { id: 'intent-step' },
    messages: [{ role: 'user', content: '改为整理成 Word 文档并下载' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ tools }) => {
      modelCalls += 1
      visibleNames = nameOf(tools)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'intent-docx',
            function: {
              name: 'create_docx',
              arguments: JSON.stringify({ title: 'Analysis', paragraphs: [{ text: 'done' }] }),
            },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: true,
      artifactId: 'intent-docx-artifact',
      filename: 'analysis.docx',
      url: '/api/artifacts/analysis.docx',
    }),
  })
  assert.ok(visibleNames.includes('create_docx'))
  assert.ok(!visibleNames.includes('create_pptx'))
})

// ── finalize 三源对账 ────────────────────────────────────────────────

test('final output flags failed steps instead of claiming success', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'execute', status: 'failed', title: '重启服务', output: { text: '' } },
    ],
  })
  assert.equal(output.complete, false)
  assert.ok(output.issues.length > 0)
  assert.match(output.summary, /部分完成/)
})

test('final output flags verification text that admits failure', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'verify', status: 'completed', output: { text: '回归测试未通过，仍有错误' } },
    ],
  })
  assert.equal(output.complete, false)
  assert.match(output.text, /未达成项/)
})

test('final output stays clean when everything really passed', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'verify', status: 'completed', output: { text: '回归测试通过' } },
    ],
  })
  assert.equal(output.complete, true)
  assert.equal(output.issues.length, 0)
})

// ★ 回归:verify 提示词会把「完成标准」原样回显，里面含有
//   「没有已知阻塞问题」这类否定式表述。早期版本用裸词匹配「阻塞问题」，
//   把每一个正常任务都误判成「部分完成」。
test('echoed acceptance criteria do not count as verification failure', () => {
  const output = buildFinalOutput({
    prompt: '修复项目 bug 并运行测试',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '已修复' } },
      {
        kind: 'verify',
        status: 'completed',
        output: {
          text: [
            '原始任务：修复项目 bug 并运行测试',
            '现在进入验证与修正阶段。检查此前产出是否真正满足任务。',
            '完成标准：',
            '- 结果可直接使用且没有已知阻塞问题',
            '- 相关检查或测试通过',
            '',
            '验收结论：已运行测试，全部通过。',
          ].join('\n'),
        },
      },
    ],
  })
  assert.equal(output.complete, true, `不该被误判：${output.issues.join('；')}`)
})

// ★ 回归:finalize 步骤在计算自己的输出时状态仍是 running，
//   不能把它自己算成「未走到完成状态」的步骤。
test('in-flight finalize step does not count itself as unfinished', () => {
  const output = buildFinalOutput({
    prompt: '修复项目 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '已修复' } },
      { kind: 'verify', status: 'completed', output: { text: '测试通过' } },
      { kind: 'finalize', status: 'running', output: {} },
    ],
  })
  assert.equal(output.complete, true, `不该被误判：${output.issues.join('；')}`)
})
