import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PREVIEW_TOOL_SPECS, executePreviewTool } from '../server/services/previewTools.js'

const WORKSPACE = 'D:/work/app'

/** Stands in for the window: it answers with whatever the test staged. */
function fakeWindow(answers) {
  const seen = []
  const requestFacts = async ({ ops }) => {
    seen.push(ops)
    const answer = typeof answers === 'function' ? answers(ops) : answers
    return answer || { ok: false, code: 'PREVIEW_FACTS_TIMEOUT', error: 'no window' }
  }
  return { requestFacts, seen }
}

test('the preview tool family is one coherent set of schemas', () => {
  const specs = PREVIEW_TOOL_SPECS
  assert.deepEqual(specs.map((spec) => spec.function.name).sort(), [
    'preview_click',
    'preview_get_console_logs',
    'preview_inspect_dom',
    'preview_navigate',
    'preview_screenshot',
    'preview_start_server',
    'preview_stop_server',
    'preview_type',
  ])
  // Every one of them tells the model it answers the same way.
  for (const spec of specs) {
    assert.equal(spec.type, 'function')
    assert.equal(spec.function.parameters.type, 'object')
  }
})

test('a conversation without a project cannot preview anything', async () => {
  const result = await executePreviewTool('preview_screenshot', {}, { userId: 'u1', workspaceRoot: '' })
  assert.equal(result.ok, true)
  assert.equal(result.success, false)
  assert.match(result.error, /还没有绑定项目目录/)
})

test('a screenshot comes back as the image the model can look at', async () => {
  const window = fakeWindow({ ok: true, results: [{ kind: 'screenshot', ok: true, width: 800, height: 600, dataUrl: 'data:image/png;base64,cG5n' }] })
  const result = await executePreviewTool('preview_screenshot', {}, { userId: 'u1', workspaceRoot: WORKSPACE, requestFacts: window.requestFacts })
  assert.equal(result.success, true)
  assert.equal(result.output, 'screenshot 800x600')
  assert.deepEqual(result.image, { data: 'cG5n', mimeType: 'image/png' })
  assert.deepEqual(window.seen, [[{ kind: 'screenshot' }]])
})

test('the console read reports errors and warnings, and says when it is quiet', async () => {
  const quiet = fakeWindow({ ok: true, results: [{ kind: 'console', ok: true, entries: [] }] })
  const empty = await executePreviewTool('preview_get_console_logs', {}, { workspaceRoot: WORKSPACE, requestFacts: quiet.requestFacts })
  assert.equal(empty.success, true)
  assert.match(empty.output, /no console output/)
  assert.equal(empty.errors, 0)

  const noisy = fakeWindow({
    ok: true,
    results: [{
      kind: 'console',
      ok: true,
      entries: [
        { level: 'error', message: 'Failed to load chunk' },
        { level: 'warning', message: 'deprecated' },
        { level: 'info', message: 'hmr connected' },
      ],
    }],
  })
  const read = await executePreviewTool('preview_get_console_logs', {}, { workspaceRoot: WORKSPACE, requestFacts: noisy.requestFacts })
  assert.equal(read.count, 3)
  assert.equal(read.errors, 2)
  assert.match(read.output, /\[error\] Failed to load chunk/)
})

test('a click or a type that matched nothing is a failure with a reason', async () => {
  const missing = fakeWindow({ ok: true, results: [{ kind: 'click', ok: true, result: JSON.stringify({ ok: false, reason: 'not-found', selector: '#go' }) }] })
  const failed = await executePreviewTool('preview_click', { selector: '#go' }, { workspaceRoot: WORKSPACE, requestFacts: missing.requestFacts })
  assert.equal(failed.success, false)
  assert.equal(failed.ok, true, 'the call itself succeeded: the page answered')
  assert.match(failed.error, /没有匹配 #go 的元素/)

  const clicked = fakeWindow({ ok: true, results: [{ kind: 'click', ok: true, result: JSON.stringify({ ok: true, selector: '#go', tag: 'button' }) }] })
  const done = await executePreviewTool('preview_click', { selector: '#go' }, { workspaceRoot: WORKSPACE, requestFacts: clicked.requestFacts })
  assert.equal(done.success, true)

  const typed = fakeWindow({ ok: true, results: [{ kind: 'type', ok: true, result: JSON.stringify({ ok: true, value: 'hello' }) }] })
  const filled = await executePreviewTool('preview_type', { selector: '#name', text: 'hello' }, { workspaceRoot: WORKSPACE, requestFacts: typed.requestFacts })
  assert.equal(filled.success, true)
  assert.deepEqual(typed.seen, [[{ kind: 'type', selector: '#name', text: 'hello' }]])
})

test('inspecting the DOM reads the page, or one element of it', async () => {
  const summary = { ok: true, results: [{ kind: 'dom', ok: true, result: JSON.stringify({ title: 'Gugo', headings: [] }) }] }
  const page = fakeWindow(summary)
  const read = await executePreviewTool('preview_inspect_dom', {}, { workspaceRoot: WORKSPACE, requestFacts: page.requestFacts })
  assert.equal(read.success, true)
  assert.match(read.output, /"title":"Gugo"/)
  assert.deepEqual(page.seen, [[{ kind: 'dom' }]])

  const scoped = fakeWindow({ ok: true, results: [{ kind: 'dom', ok: true, result: JSON.stringify({ found: true, selector: '.card' }) }] })
  await executePreviewTool('preview_inspect_dom', { selector: '.card' }, { workspaceRoot: WORKSPACE, requestFacts: scoped.requestFacts })
  assert.deepEqual(scoped.seen, [[{ kind: 'dom', selector: '.card' }]])

  const absent = fakeWindow({ ok: true, results: [{ kind: 'dom', ok: true, result: JSON.stringify({ found: false, selector: '.nope' }) }] })
  const missingElement = await executePreviewTool('preview_inspect_dom', { selector: '.nope' }, { workspaceRoot: WORKSPACE, requestFacts: absent.requestFacts })
  assert.equal(missingElement.success, false)
  assert.match(missingElement.error, /没有匹配 .nope 的元素/)
})

test('the preview opens the address it was given, and refuses anything that is not a page', async () => {
  const window = fakeWindow({ ok: true, results: [{ kind: 'navigate', ok: true }] })
  const local = await executePreviewTool('preview_navigate', { url: 'http://localhost:5173/app' }, { workspaceRoot: WORKSPACE, requestFacts: window.requestFacts })
  assert.equal(local.success, true)
  assert.deepEqual(window.seen, [[{ kind: 'navigate', url: 'http://localhost:5173/app' }]])

  // An outside address reaches the page only because the approval policy asked
  // about it first (see approvalPolicy); the tool does not re-decide that, but it
  // does refuse what no browser should open.
  const external = await executePreviewTool('preview_navigate', { url: 'https://example.com/docs' }, { workspaceRoot: WORKSPACE, requestFacts: window.requestFacts })
  assert.equal(external.success, true)
  assert.deepEqual(window.seen[1], [{ kind: 'navigate', url: 'https://example.com/docs' }])

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
    const refused = await executePreviewTool('preview_navigate', { url }, { workspaceRoot: WORKSPACE, requestFacts: window.requestFacts })
    assert.equal(refused.success, false, url)
    assert.match(refused.error, /只接受 http\(s\) 地址/)
  }
  assert.equal(window.seen.length, 2, 'nothing but the two pages reached the window')
})

test('when no panel answers, the tool says so instead of pretending', async () => {
  const silent = fakeWindow(null)
  const result = await executePreviewTool('preview_screenshot', {}, { workspaceRoot: WORKSPACE, requestFacts: silent.requestFacts })
  assert.equal(result.ok, true)
  assert.equal(result.success, false)
  assert.match(result.error, /no window|没有回应/)
})

test('the server tools drive the project, and stopping an idle preview is not an error', async () => {
  // A real workspace with a real launch.json: the store is what these two tools
  // are thin wrappers over (its own behaviour is covered in previewServerRoutes).
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-tools-'))
  try {
    const stopped = await executePreviewTool('preview_stop_server', {}, { workspaceRoot: workspace })
    assert.equal(stopped.success, true)
    assert.match(stopped.output, /was not running/)

    for (const args of [{}, { url: '' }]) {
      const result = await executePreviewTool('preview_navigate', args, { workspaceRoot: workspace, requestFacts: fakeWindow(null).requestFacts })
      assert.equal(result.success, false)
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
