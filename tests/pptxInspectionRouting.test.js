import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import PptxGenJS from 'pptxgenjs'
import { closeDb } from '../server/db.js'
import { FS_SHELL_TOOL_SPECS, readFileTool } from '../server/adapters/fsShellTools.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopHeuristics.js'
import { buildRuntimeCapabilityBlock } from '../server/services/runtimeCapabilities.js'
import { PRESENTATION_PROMPT_POLICY, PRESENTATION_VISUAL_POLICY } from '../shared/presentationPromptPolicy.js'

const tempParent = fs.realpathSync(os.tmpdir())
const root = fs.mkdtempSync(path.join(tempParent, 'gugo-pptx-read-routing-'))
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace)
const isolatedEnv = { WORKSPACE_ROOT: workspace, WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHARED_TRUSTED: '1' }
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]))
Object.assign(process.env, isolatedEnv)

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(path.dirname(fs.realpathSync(root)), tempParent)
  assert.ok(path.basename(root).startsWith('gugo-pptx-read-routing-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const findTool = (specs, name) => specs.find((spec) => spec.function.name === name).function

test('the actual exposed read_file catalog advertises existing bounded, read-only PPTX inspection', () => {
  const native = findTool(FS_SHELL_TOOL_SPECS, 'read_file')
  const exposed = findTool(SERVER_TOOL_SPECS, 'read_file')
  assert.equal(exposed.description, native.description)
  assert.match(exposed.description, /DOCX\/PPTX\/XLSX/)
  assert.match(exposed.description, /formatValidated=true/)
  assert.match(exposed.description, /5MB/)
  assert.match(exposed.description, /不要用 pdf_info\/pdf_text/)
  assert.match(exposed.description, /不证明视觉布局/)
  assert.match(exposed.description, /不写入或修改文件/)
})

test('shell authoring guidance exempts read-only verification without weakening changed-output checks', () => {
  const shell = findTool(SERVER_TOOL_SPECS, 'bash_exec')
  assert.match(shell.description, /仅当本次命令创建或修改文件时/)
  assert.match(shell.description, /只读验证也应省略或传 \[\]/)
  assert.match(shell.description, /不得 touch 或修改内容来制造验证成功/)
  assert.match(shell.parameters.properties.expected_outputs.description, /不要列入被检查但未改变的输入文件/)
  assert.match(PRESENTATION_PROMPT_POLICY, /omit expected_outputs or pass \[\]/)
  assert.match(PRESENTATION_PROMPT_POLICY, /do not list the unchanged file being inspected/)
  assert.match(PRESENTATION_PROMPT_POLICY, /Never touch, rewrite, or change file content merely/)
})

test('PPT verification routes the exact final file to its real reader and preserves visual-verification limits', () => {
  assert.match(PRESENTATION_VISUAL_POLICY, /After generation or renaming, use an available read_file on the exact final \.pptx path/)
  assert.match(PRESENTATION_VISUAL_POLICY, /Require formatValidated=true/)
  assert.match(PRESENTATION_VISUAL_POLICY, /ok=true alone is not enough/)
  assert.match(PRESENTATION_VISUAL_POLICY, /pdf_info and pdf_text inspect PDF, never PPTX/)
  assert.match(PRESENTATION_VISUAL_POLICY, /do not prove visual layout/)
  const readSpec = findTool(SERVER_TOOL_SPECS, 'read_file')
  const available = buildRuntimeCapabilityBlock({ toolSpecs: [{ function: readSpec }] })
  assert.match(available, /Office inspection: read_file/)
  assert.match(available, /local files up to 5 MB/)
  assert.match(available, /read-only, not visual layout verification/)
  assert.doesNotMatch(buildRuntimeCapabilityBlock({ toolSpecs: [{ function: { name: 'list_directory' } }] }), /Office inspection:/)
})

test('real read_file extracts and validates native PPTX content without changing its bytes or mtime', async () => {
  const deck = new PptxGenJS()
  deck.addSlide().addText('生成链路验证', { x: 1, y: 1, w: 7, h: 1 })
  deck.addSlide().addText('方案 A：快速草稿。方案 B：验证后交付。', { x: 1, y: 1, w: 7, h: 2 })
  const bytes = Buffer.from(await deck.write({ outputType: 'nodebuffer' }))
  const target = path.join(workspace, 'final.pptx')
  fs.writeFileSync(target, bytes)
  const before = fs.statSync(target)
  const namesBefore = fs.readdirSync(workspace)
  const result = await readFileTool({ path: target })
  assert.equal(result.ok, true)
  assert.equal(result.formatValidated, true)
  assert.equal(result.extractionStatus, 'text')
  assert.match(result.content, /\[slide1\]/)
  assert.match(result.content, /生成链路验证/)
  assert.match(result.content, /\[slide2\]/)
  assert.match(result.content, /方案 A：快速草稿。方案 B：验证后交付。/)
  assert.deepEqual(fs.readFileSync(target), bytes)
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs)
  assert.deepEqual(fs.readdirSync(workspace), namesBefore)
})

test('existing PPTX inspection remains bounded and distinguishes readable files from valid Office structure', async () => {
  fs.writeFileSync(path.join(workspace, 'invalid.pptx'), 'not a presentation')
  const invalid = await readFileTool({ path: 'invalid.pptx' })
  assert.equal(invalid.ok, true)
  assert.equal(invalid.formatValidated, false)
  assert.equal(invalid.extractionStatus, 'invalid')
  assert.ok(invalid.formatValidationCode)
  fs.writeFileSync(path.join(workspace, 'oversized.pptx'), Buffer.alloc(5 * 1024 * 1024 + 1))
  await assert.rejects(() => readFileTool({ path: 'oversized.pptx' }), (error) => error.statusCode === 413)
  const outside = path.join(root, 'outside.pptx')
  fs.writeFileSync(outside, 'outside authorized workspace')
  await assert.rejects(() => readFileTool({ path: outside }), (error) => error.statusCode === 403)
})
