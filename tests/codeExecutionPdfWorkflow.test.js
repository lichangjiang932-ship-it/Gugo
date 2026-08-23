import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-code-execution-pdf-'))
process.env.APP_DATA_DIR = path.join(workspace, '.app-data')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { createInitialState } = await import('../src/store/appStateBootstrap.js')
const { buildServerToolsConfig } = await import('../src/pages/ChatSplit/serverTurnFlow.js')
const { dispatchFsShellTool } = await import('../server/adapters/fsShellTools.js')
const { closeDb } = await import('../server/db.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')

const INTERNAL_APPROVAL_PRINCIPAL = trustedInternalLoopPrincipal()

function toolSpec(name) {
  const spec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(spec, `missing server tool spec: ${name}`)
  return spec
}

test.after(() => {
  closeDb()
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('code execution is advertised by default for a writable local-file workflow', async () => {
  const state = createInitialState()
  assert.equal(
    state.toolsConfig.bash_exec,
    true,
    'bash_exec is a core capability and must not start disabled in a new chat',
  )

  const clientConfig = buildServerToolsConfig(state.toolsConfig, {
    paths: [workspace],
    accessMode: 'read_write',
    resources: [{ path: workspace, resourceType: 'directory' }],
  })
  assert.ok(clientConfig.enabled.includes('bash_exec'))
  assert.equal(clientConfig.disabled.includes('bash_exec'), false)

  const resolved = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: SERVER_TOOL_SPECS,
    toolsConfig: clientConfig,
    enabledConnectorTools: [],
    webSearchReady: false,
  })
  assert.ok(
    resolved.some((spec) => spec?.function?.name === 'bash_exec'),
    'the model-facing tool set must contain bash_exec after local write authorization',
  )
})

test('absolute PDF edit and PNG generation reject a fake blocker, execute code, declare outputs, and verify both files', async () => {
  const pdfPath = path.join(workspace, '雅思写作最新答题纸.pdf')
  const pngPath = path.join(workspace, '雅思写作最新答题纸-task1.png')
  const scriptPath = path.join(workspace, 'render-task1.cjs')
  fs.writeFileSync(pdfPath, '%PDF-1.4\nBT (Old placeholder) Tj ET\n%%EOF', 'latin1')
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs')",
    'const [pdfPath, pngPath] = process.argv.slice(2)',
    "const pdf = ['%PDF-1.4', 'BT', '(Task 1 essay written by real code execution.) Tj', 'ET', '%%EOF'].join('\\n')",
    "fs.writeFileSync(pdfPath, Buffer.from(pdf, 'latin1'))",
    "fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))",
  ].join('\n'), 'utf8')

  const command = `node ${path.basename(scriptPath)} ${pdfPath} ${pngPath}`
  const specs = ['bash_exec', 'read_file', 'request_clarification'].map(toolSpec)
  const executed = []
  let shellArgs = null
  let modelCalls = 0

  const result = await runToolsLoop({
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    job: {
      id: 'absolute-pdf-to-png-code-execution',
      userId: null,
      origin: 'chat',
      prompt: `请直接把 Task 1 作文写入绝对路径 ${pdfPath}，并生成 PNG 预览 ${pngPath}。`,
    },
    step: { id: 'absolute-pdf-to-png-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `请直接把 Task 1 作文写入绝对路径 ${pdfPath}，并生成 PNG 预览 ${pngPath}。`,
    }],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 8,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const availableNames = tools.map((item) => item.function.name)
      assert.ok(availableNames.includes('bash_exec'), 'bash_exec must remain visible on every model round')

      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'false-code-execution-blocker',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: JSON.stringify({
                blocker_kind: 'missing_info',
                question: '我的当前工具集不包含代码执行能力（如 bash_exec），因此无法直接修改 PDF 文件或生成 PNG 图像。您希望我改为编写脚本吗？',
              }),
            },
          }],
        }
      }

      if (modelCalls === 2) {
        const denial = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(denial.code, 'clarification_capability_contradicted')
        assert.deepEqual(denial.availableTools, ['bash_exec'])
        return {
          content: '',
          toolCalls: [{
            id: 'execute-pdf-to-png-transform',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command,
                cwd: workspace,
                expected_outputs: [pdfPath, pngPath],
              }),
            },
          }],
        }
      }

      if (modelCalls === 3) {
        const shellResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(shellResult.ok, true)
        assert.equal(shellResult.exitCode, 0)
        assert.equal(shellResult.unverifiedOutputs.length, 0)
        assert.equal(shellResult.verifiedOutputs.length, 2)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-written-pdf',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: pdfPath }) },
          }],
        }
      }

      if (modelCalls === 4) {
        const pdfResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(pdfResult.ok, true)
        assert.equal(pdfResult.extractionStatus, 'text')
        assert.match(pdfResult.content, /Task 1 essay written by real code execution/)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-generated-png',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: pngPath }) },
          }],
        }
      }

      if (modelCalls === 5) {
        const pngResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(pngResult.ok, true)
        assert.ok(pngResult.size > 0)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-pdf-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python "verify_pdf_layout.py"',
                cwd: workspace,
              }),
            },
          }],
        }
      }

      if (modelCalls === 6) {
        const layoutResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(layoutResult.ok, true)
        assert.match(layoutResult.stdout, /PDF_LAYOUT_VERIFICATION_OK/)
        return { content: 'PDF 已写入，PNG 已生成，两个输出均已验证。', toolCalls: [] }
      }

      throw new Error(`unexpected model call: ${modelCalls}`)
    },
    executeTool: async ({ name, args, signal }) => {
      executed.push(name)
      assert.notEqual(name, 'request_clarification', 'the contradicted clarification must never pause execution')
      if (name === 'bash_exec' && String(args.command).includes('verify_pdf_layout.py')) {
        return {
          ok: true,
          exitCode: 0,
          stdout: 'PDF_LAYOUT_VERIFICATION_OK\n',
          stderr: '',
          changedPaths: [],
        }
      }
      if (name === 'bash_exec') shellArgs = structuredClone(args)
      return dispatchFsShellTool(name, args, { userId: null, signal })
    },
  })

  assert.equal(result.text, 'PDF 已写入，PNG 已生成，两个输出均已验证。')
  assert.equal(result.paused, undefined)
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed, ['bash_exec', 'read_file', 'read_file', 'bash_exec'])
  assert.deepEqual(shellArgs.expected_outputs, [pdfPath, pngPath])
  assert.ok(path.isAbsolute(shellArgs.expected_outputs[0]))
  assert.ok(path.isAbsolute(shellArgs.expected_outputs[1]))
  assert.match(fs.readFileSync(pdfPath, 'latin1'), /Task 1 essay written by real code execution/)
  assert.deepEqual([...fs.readFileSync(pngPath).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})

test('PDF layout work preserves an explicit Task 1 target and cannot finish before an independent layout validator passes', async () => {
  const pdfPath = path.join(workspace, 'task1-layout-output.pdf')
  const pngPath = path.join(workspace, 'task1-layout-page-1.png')
  const prompt = [
    `Write the supplied essay only into the Writing Task 1 pages of ${pdfPath}.`,
    `Render the completed page to ${pngPath}; keep every Writing Task 2 page unchanged.`,
  ].join(' ')
  const specs = ['bash_exec', 'read_file'].map(toolSpec)
  const executed = []
  let modelCalls = 0
  let sawLayoutGuard = false

  const result = await runToolsLoop({
    approvalPrincipal: INTERNAL_APPROVAL_PRINCIPAL,
    job: {
      id: 'task1-layout-verification-contract',
      userId: null,
      origin: 'chat',
      prompt,
    },
    step: { id: 'task1-layout-verification-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 10,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n')

      if (modelCalls === 1) {
        assert.match(systemText, /\[PDF LAYOUT EXECUTION CONTRACT\]/)
        assert.match(systemText, /authoritative requested section is Writing Task 1|explicitly selected Writing Task 1/i)
        assert.match(systemText, /never switch to another task, section, or page/i)
        assert.match(systemText, /verify_pdf_layout\.py/)
        assert.match(systemText, /do not call browser_open_url with a local file:\/\//i)
        assert.match(systemText, /browser tools accept only http\/https/i)
        return {
          content: '',
          toolCalls: [{
            id: 'generate-task1-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python "generate_pdf.py"',
                cwd: workspace,
                expected_outputs: [pdfPath, pngPath],
              }),
            },
          }],
        }
      }

      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'read-generated-task1-pdf',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: pdfPath }) },
            },
            {
              id: 'read-generated-task1-png',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: pngPath }) },
            },
          ],
        }
      }

      if (modelCalls === 3) {
        return { content: 'The PDF and PNG exist, so the task is complete.', toolCalls: [] }
      }

      if (modelCalls === 4) {
        assert.match(systemText, /\[PDF LAYOUT VERIFICATION REQUIRED\]/)
        assert.match(systemText, /authoritative requested section is Writing Task 1/i)
        assert.match(systemText, /existence and byte reads do not verify/i)
        assert.match(systemText, /do not use browser_open_url for local file:\/\//i)
        sawLayoutGuard = true
        return {
          content: '',
          toolCalls: [{
            id: 'validate-task1-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python "verify_pdf_layout.py"',
                cwd: workspace,
              }),
            },
          }],
        }
      }

      if (modelCalls === 5) {
        return { content: 'Writing Task 1 was generated and independently layout-verified.', toolCalls: [] }
      }

      throw new Error(`unexpected model call: ${modelCalls}`)
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args: structuredClone(args) })
      if (name === 'read_file') {
        return args.path === pdfPath
          ? {
              ok: true,
              path: pdfPath,
              mimeType: 'application/pdf',
              extractionStatus: 'text',
              content: 'Writing Task 1 essay text',
            }
          : { ok: true, path: pngPath, mimeType: 'image/png', size: 128, content: '' }
      }
      if (String(args.command).includes('verify_pdf_layout.py')) {
        return {
          ok: true,
          exitCode: 0,
          stdout: 'target pages: 1,2\nPDF_LAYOUT_VERIFICATION_OK\n',
          stderr: '',
          changedPaths: [],
        }
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: 'generated',
        stderr: '',
        changedPaths: [pdfPath, pngPath],
        verifiedOutputs: [
          { path: pdfPath, status: 'created' },
          { path: pngPath, status: 'created' },
        ],
        unverifiedOutputs: [],
      }
    },
  })

  assert.equal(sawLayoutGuard, true)
  assert.equal(result.text, 'Writing Task 1 was generated and independently layout-verified.')
  assert.deepEqual(executed.map((call) => call.name), [
    'bash_exec',
    'read_file',
    'read_file',
    'bash_exec',
  ])
})
