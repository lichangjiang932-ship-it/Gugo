import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

function quoted(value, limit = 1000) {
  return JSON.stringify(String(value ?? '').slice(0, limit))
}

function ask(rl, prompt, signal) {
  if (signal?.aborted || rl.closed) return Promise.resolve('')
  return new Promise((resolveAnswer) => {
    let settled = false
    const finish = (answer = '') => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      rl.removeListener('close', close)
      resolveAnswer(String(answer).trim())
    }
    const close = () => finish('')
    const abort = () => { finish(''); rl.close() }
    rl.once('close', close)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    rl.question(prompt, finish)
  })
}

function recoveryEvidence(record) {
  const evidence = record.evidence || {}
  const lines = [
    `[recovery] tool=${quoted(record.toolName)} call=${quoted(record.toolCallId)}`,
    `Task: ${quoted(record.turnId)}; session: ${quoted(record.sessionId)}`,
    `Arguments digest: ${quoted(record.argsDigest)}`,
  ]
  if (record.failure && typeof record.failure === 'object') {
    lines.push(`Recorded failure: ${quoted(record.failure.code)} ${quoted(record.failure.message)}`)
  }
  for (const field of ['targetSummary', 'changedPaths', 'artifactIds']) {
    for (const value of (Array.isArray(evidence[field]) ? evidence[field] : []).slice(0, 12)) {
      lines.push(`${field}: ${quoted(value)}`)
    }
  }
  for (const output of (Array.isArray(evidence.verifiedOutputs) ? evidence.verifiedOutputs : []).slice(0, 12)) {
    const safe = { path: output.path, sha256: output.sha256, size: output.size, artifactId: output.artifactId }
    lines.push(`verifiedOutput: ${JSON.stringify(safe)}`)
  }
  lines.push('The operation may already have happened. Inspect the real target before choosing an outcome.')
  return `${lines.join('\n')}\n`
}

/** Terminal-only presentation; the host owns validation, grants and recovery writes. */
export function createRunRecoveryPrompts(input, diagnostics, {
  signal = null, createInterfaceImpl = createInterface,
} = {}) {
  const withPrompt = async (operation) => {
    if (signal?.aborted) return null
    const rl = createInterfaceImpl({ input, output: diagnostics })
    try { return await operation(rl) } finally { rl.close() }
  }
  return {
    onDirectoryRequest: ({ request, workspace, canonicalizeDirectory }) => withPrompt(async (rl) => {
      const requested = String(request.suggested_path || request.suggestedPath || '').trim()
      const chosen = requested || await ask(rl, '[directory] Absolute directory path (empty = defer): ', signal)
      if (!chosen || signal?.aborted) return { approved: false }
      const selectedPath = await canonicalizeDirectory(resolve(workspace, chosen))
      if (signal?.aborted) return { approved: false }
      const accessMode = request.access_mode || request.accessMode || 'read_only'
      diagnostics.write(`[directory] path=${quoted(selectedPath)} access=${quoted(accessMode)}\n`)
      diagnostics.write(`Purpose: ${quoted(request.purpose || request.why || request.question)}\n`)
      diagnostics.write('Scope: this CLI run only / 仅本次 CLI 运行；不会修改账户设置。\n')
      const answer = await ask(rl, 'Allow this exact directory and access mode? [y/N] ', signal)
      return { approved: /^y(?:es)?$/i.test(answer), path: selectedPath, accessMode }
    }),
    onSideEffectRecovery: ({ record }) => withPrompt(async (rl) => {
      diagnostics.write(recoveryEvidence(record))
      diagnostics.write('This records an inspected outcome, not permission to blindly replay an unknown operation.\n')
      const choice = await ask(rl,
        '[recovery] 1 = 已核实未发生，继续 / verified not performed; 2 = 已核实完成，不重复 / verified completed; Enter = 暂不处理 / defer: ',
        signal)
      const resolution = choice === '1' ? 'failed' : choice === '2' ? 'committed' : null
      if (!resolution || signal?.aborted) return { resolution: 'defer' }
      return { resolution, verificationConfirmed: true, confirmToolCallId: record.toolCallId }
    }),
  }
}
