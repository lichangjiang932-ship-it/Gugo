import test from 'node:test'
import assert from 'node:assert/strict'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

function spec(name) {
  const value = SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  assert.ok(value, `missing server tool spec: ${name}`)
  return value
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function normalized(value) {
  return String(value).replaceAll('\\', '/')
}

test('a workspace-root relative deletion needs a complete list_directory(".") before it is verified', async () => {
  const target = '_run_pdf.py'
  let modelCalls = 0
  let directoryLists = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'root-relative-delete-verification-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create a temporary root script, remove it, and verify its absence.',
    },
    step: { id: 'root-relative-delete-verification-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Create a temporary root script, remove it, and verify its absence.',
    }],
    intentMode: 'execute',
    toolSpecs: [spec('write_file'), spec('bash_exec'), spec('list_directory')],
    maxIters: 6,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [toolCall('write-root-script', 'write_file', {
            path: target,
            content: 'print("temporary")',
          })],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [toolCall('delete-root-script', 'bash_exec', {
            command: `del /q "${target}"`,
            cwd: '.',
          })],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [toolCall('list-root-truncated', 'list_directory', { path: '.' })],
        }
      }
      if (modelCalls === 4) {
        assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
        assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [target])
        return {
          content: '',
          toolCalls: [toolCall('list-root-complete', 'list_directory', { path: '.' })],
        }
      }
      assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [])
      return { content: 'The temporary root script was removed and verified.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file') return { ok: true, path: target }
      if (name === 'bash_exec') return { ok: true, exitCode: 0, cwd: '.' }
      directoryLists += 1
      return {
        ok: true,
        path: '.',
        total: 0,
        truncated: directoryLists === 1,
        entries: [],
      }
    },
  })

  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 5)
  assert.equal(directoryLists, 2)
  assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [])
})

async function runLiteralDeletionScenario({ label, command, cwd, target, parent }) {
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: `literal-delete-${label}-job`,
      userId: null,
      origin: 'chat',
      prompt: 'Delete the exact temporary path and verify its absence.',
    },
    step: { id: `literal-delete-${label}-step`, kind: 'chat' },
    messages: [{ role: 'user', content: 'Delete the exact temporary path and verify its absence.' }],
    intentMode: 'execute',
    toolSpecs: [spec('bash_exec'), spec('list_directory')],
    maxIters: 4,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [toolCall(`delete-${label}`, 'bash_exec', { command, cwd })],
        }
      }
      if (modelCalls === 2) {
        assert.deepEqual(
          checkpoint?.completionGuards?.pendingDeletionTargets,
          [normalized(target)],
          label,
        )
        return {
          content: '',
          toolCalls: [toolCall(`verify-${label}`, 'list_directory', { path: parent })],
        }
      }
      return { content: 'The exact path was deleted and verified.', toolCalls: [] }
    },
    executeTool: async ({ name }) => (
      name === 'bash_exec'
        ? { ok: true, exitCode: 0, cwd }
        : { ok: true, path: parent, total: 0, truncated: false, entries: [] }
    ),
  })

  assert.equal(result.incomplete, undefined, label)
  assert.equal(modelCalls, 3, label)
  assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [], label)
}

test('literal Unix rm, unlink, and rmdir deletions are tracked until their parent listing is complete', async () => {
  const cwd = '/workspace'
  const scenarios = [
    {
      label: 'unix-rm',
      command: 'rm -f "tmp-rm.txt"',
      target: `${cwd}/tmp-rm.txt`,
    },
    {
      label: 'unix-unlink',
      command: 'unlink -- "tmp-unlink.txt"',
      target: `${cwd}/tmp-unlink.txt`,
    },
    {
      label: 'unix-rmdir',
      command: 'rmdir -p "tmp-dir"',
      target: `${cwd}/tmp-dir`,
    },
  ]

  for (const scenario of scenarios) {
    await runLiteralDeletionScenario({ ...scenario, cwd, parent: cwd })
  }
})

test('literal direct and wrapped PowerShell Remove-Item deletions require complete parent evidence', async () => {
  const cwd = 'C:\\workspace'
  const directTarget = `${cwd}\\tmp-direct.txt`
  const wrappedTarget = `${cwd}\\tmp wrapper.txt`
  const scenarios = [
    {
      label: 'powershell-direct',
      command: `Remove-Item -LiteralPath '${directTarget}' -Force`,
      target: directTarget,
    },
    {
      label: 'powershell-wrapper',
      command: `pwsh -NoProfile -Command "Remove-Item -LiteralPath '${wrappedTarget}' -Force"`,
      target: wrappedTarget,
    },
  ]

  for (const scenario of scenarios) {
    await runLiteralDeletionScenario({ ...scenario, cwd, parent: cwd })
  }
})

test('dynamic, wildcard, parent-traversal, and compound deletes stay conservatively workspace-scoped', async () => {
  const target = 'cleanup.tmp'
  const scenarios = [
    { label: 'unix-variable', command: 'rm -f "$TARGET"' },
    { label: 'unix-wildcard', command: 'rm -f "*.tmp"' },
    { label: 'unix-parent', command: 'rm -f "../cleanup.tmp"' },
    { label: 'unix-compound', command: `rm -f "${target}" && echo done` },
    { label: 'powershell-variable', command: 'Remove-Item -LiteralPath $target -Force' },
    { label: 'powershell-wildcard', command: "Remove-Item -LiteralPath '*.tmp' -Force" },
    {
      label: 'powershell-compound',
      command: `Remove-Item -LiteralPath '${target}'; Write-Output done`,
    },
  ]

  for (const scenario of scenarios) {
    let modelCalls = 0
    let checkpoint = null
    const result = await runToolsLoop({
      job: {
        id: `unsafe-delete-${scenario.label}-job`,
        userId: null,
        origin: 'chat',
        prompt: 'Create a temporary file, delete it, and finish only after verification.',
      },
      step: { id: `unsafe-delete-${scenario.label}-step`, kind: 'chat' },
      messages: [{
        role: 'user',
        content: 'Create a temporary file, delete it, and finish only after verification.',
      }],
      intentMode: 'execute',
      toolSpecs: [spec('write_file'), spec('bash_exec')],
      maxIters: 4,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [toolCall(`write-${scenario.label}`, 'write_file', {
              path: target,
              content: 'temporary',
            })],
          }
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [toolCall(`delete-${scenario.label}`, 'bash_exec', {
              command: scenario.command,
              cwd: '.',
            })],
          }
        }
        return { content: 'Cleanup completed.', toolCalls: [] }
      },
      executeTool: async ({ name }) => (
        name === 'write_file'
          ? { ok: true, path: target }
          : { ok: true, exitCode: 0, cwd: '.' }
      ),
    })

    assert.equal(result.incomplete, true, scenario.label)
    assert.equal(result.reason, 'post_mutation_verification_missing', scenario.label)
    assert.ok(
      (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(target),
      scenario.label,
    )
    assert.ok(
      (checkpoint?.completionGuards?.pendingMutationTargets || []).includes('<workspace>'),
      scenario.label,
    )
    assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [], scenario.label)
  }
})
