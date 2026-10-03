import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowedArtifactTools,
  detectArtifactIntent,
  isArtifactRevisionRequest,
  resolveArtifactDeliveryTargets,
} from '../server/services/artifactIntent.js'

const artifactTools = {
  pptx: 'create_pptx',
  docx: 'create_docx',
  xlsx: 'create_xlsx',
  html: 'create_html_app',
  pdf: 'create_pdf',
  image: 'generate_image',
}

test('an explicit PPT remake request works across feedback and command clauses', () => {
  for (const prompt of [
    '这个ppt太丑了，重新做一个，要前沿未来科技风',
    '这个 PPT 太丑了。重新做一个，做成未来科技风。',
    '这个 PPT 不符合要求；请重新制作一份。',
    '这个 PPT 有问题，重新做一个。',
    '这个 PPT 太丑了，重做一个，要前沿未来科技风。',
    'This PPT is too ugly; please redo it in a futuristic style.',
    'This slide deck looks dated. Remake it from scratch.',
    'This PPT has issues. Redo it.',
    'Redo this PPT in a futuristic style.',
    'Remake the PowerPoint with a futuristic theme.',
    '请重新做一个“PPT”，要科技风。',
  ]) {
    assert.equal(detectArtifactIntent(prompt).pptx, true, prompt)
    assert.equal(isArtifactRevisionRequest(prompt), true, prompt)
    assert.deepEqual([...allowedArtifactTools(prompt)], ['create_pptx'], prompt)
    assert.deepEqual(
      [...allowedArtifactTools(prompt, { priorArtifactTypes: ['pptx', 'image'] })],
      ['create_pptx'],
      `${prompt}: only the named deliverable is requested`,
    )
  }
})

test('unnamed remake requests inherit only an already authorized artifact type', () => {
  for (const prompt of [
    '重新做一个，要前沿未来科技风',
    '请重新制作一份',
    '重新生成一版',
    '再做一个',
    'Remake it from scratch.',
    'Recreate the previous version with a cleaner theme.',
    'Please regenerate it with larger text.',
    'I want you to redo it with a cleaner theme.',
    'Please redesign the layout.',
  ]) {
    assert.deepEqual([...allowedArtifactTools(prompt)], [], `${prompt}: no prior artifact`)
    for (const [type, tool] of Object.entries(artifactTools)) {
      assert.deepEqual(
        [...allowedArtifactTools(prompt, { priorArtifactTypes: [type] })],
        [tool],
        `${type}: ${prompt}`,
      )
    }
  }
})

test('named redo requests stay format-specific for other deliverables', () => {
  for (const [prompt, tool] of [
    ['这个 Word 文档太乱了，重新制作一份。', 'create_docx'],
    ['这个 Excel 工作簿不符合要求，重新做一个。', 'create_xlsx'],
    ['这个网页太丑了，重新做一个。', 'create_html_app'],
    ['这份 PDF 太丑了，重新制作一份。', 'create_pdf'],
    ['这张图片太丑了，重新生成一张。', 'generate_image'],
    ['This Word document looks dated. Recreate it.', 'create_docx'],
    ['This spreadsheet looks dated. Rebuild it.', 'create_xlsx'],
    ['This webpage is too ugly. Redesign it.', 'create_html_app'],
    ['This PDF is unreadable. Regenerate it.', 'create_pdf'],
    ['This image is too dark. Remake it.', 'generate_image'],
  ]) {
    assert.deepEqual([...allowedArtifactTools(prompt)], [tool], prompt)
  }
})

test('denials and discussions cannot turn remake wording into artifact authorization', () => {
  for (const prompt of [
    '这个ppt太丑了，不要重新做，只解释设计问题。',
    '这个 PPT 太丑了，先不要重做，也不要生成文件。',
    'This PPT is ugly. Do not redo it.',
    'This PPT is ugly; do not remake it.',
    '不需要重做这个 PPT',
    'No need to redo this PPT.',
    'I did not ask you to redo this PPT.',
    'This PPT is too ugly. Explain how to redo it; do not create any files.',
    '如何重新做这个 PPT？只提供建议，不生成文件。',
    '请分析这个PPT为什么很丑，告诉我怎么重新做。',
    '解释重新做一个 PPT 的提示词识别逻辑',
    '修复重新制作 PPT 的代码逻辑',
    'Redo the PPT parser.',
    '这个 PPT 解析器有问题，重新做一个。',
    'Explain how to redo this PPT.',
    'How should I remake this PPT?',
    '这个 PPT 太丑了，重新做一个的代码示例怎么写？',
    '这个 PPT 太丑了，重新做一个，但不要生成任何文件，只在聊天中讨论。',
  ]) {
    for (const options of [{}, { priorArtifactTypes: ['pptx'] }]) {
      assert.deepEqual([...allowedArtifactTools(prompt, options)], [], prompt)
    }
    assert.equal(isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }), false, prompt)
  }
})

test('quoted and fenced remake instructions are reference material, not authorization', () => {
  for (const prompt of [
    '用户说“这个ppt太丑了，重新做一个”，请解释这句话。',
    '用户说“这个PPT太丑了，重做一个”，请解释这句话。',
    '日志写着 "This PPT is too ugly, redo it"; explain this error.',
    'Read this quote: "Redo this PPT".',
    '> 这个 PPT 太丑了，重新做一个\n只分析这句话。',
    '```text\nRedo this PPT\n```\nExplain the prompt only.',
    "'重新做一个'这句话是什么意思？",
  ]) {
    assert.equal(isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }), false, prompt)
    assert.deepEqual([...allowedArtifactTools(prompt, { priorArtifactTypes: ['pptx'] })], [], prompt)
  }
})

test('redo recognition keeps input, workspace, and additional-format boundaries', () => {
  assert.deepEqual(
    [...allowedArtifactTools('这个 PPT 太丑了，重新做一个。不要生成图片。')],
    ['create_pptx'],
  )
  assert.deepEqual(
    [...allowedArtifactTools('读取 PPT 后，重新做一个网站')],
    ['create_html_app'],
  )
  const local = resolveArtifactDeliveryTargets('请重新制作 D:\\work\\slides.pptx', {
    priorArtifactTypes: ['pptx'],
  })
  assert.equal(local.target, 'workspace_file')
  assert.deepEqual(local.managedArtifactTypes, [])
})
