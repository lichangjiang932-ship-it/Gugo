import test from 'node:test'
import assert from 'node:assert/strict'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

function spec(name) {
  const value = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(value, `missing tool spec: ${name}`)
  return value
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

test('three probe-only batches force execution and block variant probe scripts', async () => {
  const outputPath = 'D:\\destok\\filled-answer.pdf'
  const observedRequests = []
  const executed = []
  const checkpoints = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'execution-convergence-probe-job',
      userId: null,
      origin: 'chat',
      prompt: `Create ${outputPath} with Python and verify the generated file.`,
    },
    step: { id: 'execution-convergence-probe-step', kind: 'chat' },
    messages: [{ role: 'user', content: `Create ${outputPath} with Python and verify it.` }],
    intentMode: 'execute',
    toolSpecs: [spec('write_file'), spec('bash_exec'), spec('read_file')],
    maxIters: 9,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if ([1, 3, 4].includes(modelCalls)) {
        const path = modelCalls === 1
          ? 'inspect_pdf.py'
          : modelCalls === 3
            ? 'inspect_layout.py'
            : 'inspect_header.py'
        if (modelCalls === 4) {
          const systemText = messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n')
          assert.match(systemText, /\[EXECUTION CONVERGENCE REQUIRED\]/)
        }
        return {
          content: '',
          toolCalls: [toolCall(`write-${path}`, 'write_file', {
            path,
            content: 'import fitz\nprint(fitz.VersionBind)\n',
          })],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [toolCall('run-inspect-pdf', 'bash_exec', { command: 'python inspect_pdf.py' })],
        }
      }
      if (modelCalls === 5) {
        const blocked = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(blocked.code, 'execution_convergence_probe_blocked')
        return {
          content: '',
          toolCalls: [toolCall('generate-filled-pdf', 'bash_exec', {
            command: 'python create_filled_pdf.py',
            expected_outputs: [outputPath],
          })],
        }
      }
      if (modelCalls === 6) {
        return {
          content: '',
          toolCalls: [toolCall('verify-filled-pdf', 'read_file', { path: outputPath })],
        }
      }
      if (modelCalls === 7) {
        return {
          content: '',
          toolCalls: [toolCall('verify-filled-pdf-layout', 'bash_exec', {
            command: 'python verify_pdf_layout.py',
          })],
        }
      }
      return { content: 'The PDF was generated and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(`${name}:${args.path || args.command}`)
      if (name === 'write_file') return { ok: true, path: args.path, bytes: args.content.length }
      if (name === 'read_file') {
        return {
          ok: true,
          path: args.path,
          content: 'Task 1 answer',
          mimeType: 'application/pdf',
          extractionStatus: 'text',
        }
      }
      if (args.command.includes('create_filled_pdf.py')) {
        return { ok: true, exitCode: 0, stdout: 'created', changedPaths: [outputPath] }
      }
      if (args.command.includes('verify_pdf_layout.py')) {
        return { ok: true, exitCode: 0, stdout: 'PDF_LAYOUT_VERIFICATION_OK\n' }
      }
      return { ok: true, exitCode: 0, stdout: 'PyMuPDF 1.26' }
    },
  })

  assert.equal(result.text, 'The PDF was generated and verified.')
  assert.equal(modelCalls, 8)
  assert.equal(executed.some((item) => item.includes('inspect_header.py')), false)
  assert.deepEqual(executed, [
    'write_file:inspect_pdf.py',
    'bash_exec:python inspect_pdf.py',
    'write_file:inspect_layout.py',
    'bash_exec:python create_filled_pdf.py',
    `read_file:${outputPath}`,
    'bash_exec:python verify_pdf_layout.py',
  ])
  assert.equal(observedRequests.length, 8)
  assert.equal(checkpoints.at(-1).completionGuards.executionConvergence.interventions, 1)
  assert.equal(checkpoints.at(-1).completionGuards.executionConvergence.interventionActive, false)
})

test('convergence recognizes repeated installs despite command argument variation', async () => {
  const executed = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'execution-convergence-install-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create result.txt after checking the Python environment, then verify the file.',
    },
    step: { id: 'execution-convergence-install-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt and verify it.' }],
    intentMode: 'execute',
    toolSpecs: [spec('write_file'), spec('bash_exec'), spec('read_file')],
    maxIters: 9,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [toolCall('install-fitz-first', 'bash_exec', {
            command: 'python -m pip install fitz',
          })],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [toolCall('check-fitz-version', 'bash_exec', {
            command: 'python -c "import fitz; print(fitz.__version__)"',
          })],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [toolCall('write-inspect-dependency', 'write_file', {
            path: 'inspect_dependency.py',
            content: 'import fitz\n',
          })],
        }
      }
      if (modelCalls === 4) {
        assert.ok(messages.findLast((message) => (
          message.role === 'system'
          && String(message.content).includes('[EXECUTION CONVERGENCE REQUIRED]')
        )))
        return {
          content: '',
          toolCalls: [toolCall('install-fitz-again', 'bash_exec', {
            command: 'pip install --upgrade fitz',
          })],
        }
      }
      if (modelCalls === 5) {
        const blocked = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        assert.equal(blocked.code, 'execution_convergence_install_blocked')
        return {
          content: '',
          toolCalls: [toolCall('write-result-after-probes', 'write_file', {
            path: 'result.txt',
            content: 'done',
          })],
        }
      }
      if (modelCalls === 6) {
        return {
          content: '',
          toolCalls: [toolCall('verify-result-after-probes', 'read_file', { path: 'result.txt' })],
        }
      }
      return { content: 'Created and verified result.txt.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(`${name}:${args.path || args.command}`)
      if (name === 'write_file') return { ok: true, path: args.path, bytes: args.content.length }
      if (name === 'read_file') return { ok: true, path: args.path, content: 'done' }
      return { ok: true, exitCode: 0, stdout: 'ok' }
    },
  })

  assert.equal(result.text, 'Created and verified result.txt.')
  assert.equal(executed.filter((item) => item.includes('pip install')).length, 1)
  assert.equal(executed.some((item) => item === 'write_file:result.txt'), true)
})

test('read-only planning never activates execution convergence', async () => {
  const observedRequests = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'read-only-convergence-job',
      userId: null,
      origin: 'chat',
      prompt: 'Implement the project fix after reviewing the relevant source files.',
    },
    step: { id: 'read-only-convergence-step', kind: 'plan' },
    messages: [{ role: 'user', content: 'Implement the project fix after reviewing the source.' }],
    executionGuardMode: 'read_only_exploration',
    toolSpecs: [spec('read_file')],
    maxIters: 6,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls <= 4) {
        return {
          content: '',
          toolCalls: [toolCall(`planning-read-${modelCalls}`, 'read_file', {
            path: `src/file-${modelCalls}.js`,
          })],
        }
      }
      return { content: 'Planning review complete.', toolCalls: [] }
    },
    executeTool: async ({ args }) => ({
      ok: true,
      path: args.path,
      content: 'export default true',
    }),
  })

  assert.equal(result.text, 'Planning review complete.')
  const systemText = observedRequests
    .flatMap((messages) => messages)
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.doesNotMatch(systemText, /\[EXECUTION CONVERGENCE REQUIRED\]/)
})
