import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

const workspace = path.join(process.env.APP_DATA_DIR, 'readonly-office')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'
fs.mkdirSync(workspace, { recursive: true })

const { readFileTool } = await import('../server/adapters/fsFileTools.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')

async function sourceDocument() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Section one</w:t></w:r></w:p><w:p><w:r><w:t>Section two</w:t></w:r></w:p></w:body></w:document>')
  zip.file('word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
  const file = path.join(workspace, 'source.docx')
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
  return file
}

for (const prompt of [
  '只读操作：读取 source.docx 的前两段，最后用文字总结。不要创建或改动任何文件。',
  '先读取 source.docx 的前两段，稍后生成新的 output.docx。',
]) {
  test(`source validation warnings do not consume deliverable retries: ${prompt}`, async () => {
    const file = await sourceDocument()
    const before = fs.readFileSync(file)
    const reads = []
    let calls = 0
    const result = await runToolsLoop({
      job: { id: `readonly-office-${prompt.length}`, userId: null, origin: 'chat', prompt },
      approvalPrincipal: trustedInternalLoopPrincipal(),
      step: { id: 'read-office-step', kind: 'chat' },
      messages: [{ role: 'user', content: prompt }],
      toolSpecs: [SERVER_TOOL_SPECS.find((spec) => spec.function?.name === 'read_file')],
      maxIters: 3,
      enableToolHooks: false,
      runModel: async () => {
        calls += 1
        return calls <= 2 ? { content: '', toolCalls: [{ id: `read-${calls}`, type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: file, offset: calls - 1, limit: 1 }) } }] }
          : { content: 'Section one and Section two.', toolCalls: [] }
      },
      executeTool: async ({ args }) => {
        const read = await readFileTool(args)
        reads.push(read)
        return read
      },
    })
    assert.equal(reads.length, 2)
    assert.deepEqual(reads.map((read) => read.content), ['Section one', 'Section two'])
    for (const read of reads) {
      assert.equal(read.ok, true)
      assert.equal(read.formatValidationPolicyBlocked, true, 'the output safety policy remains enforced')
    }
    assert.notEqual(result.reason, 'artifact_format_policy_blocked')
    if (prompt.startsWith('只读')) {
      assert.notEqual(result.incomplete, true)
      assert.match(result.text, /Section one and Section two/)
      assert.notEqual(result.missingRequirements?.includes('deliverable_artifact'), true)
    }
    assert.deepEqual(fs.readFileSync(file), before, 'reading never mutates the input document')
  })
}
