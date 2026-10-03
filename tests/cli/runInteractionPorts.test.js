import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'

import { createRunInteractionPorts } from '../../bin/cli/runInteractionPorts.js'

function ttyStreams(lines = '') {
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const chunks = []
  const diagnostics = new Writable({
    write(chunk, _encoding, done) { chunks.push(String(chunk)); done() },
  })
  diagnostics.isTTY = true
  if (lines) stdin.push(lines)
  return {
    stdin,
    diagnostics,
    text: () => chunks.join(''),
    write(line) { stdin.push(line) },
  }
}

test('one factory supplies every port a headless turn needs', () => {
  const { stdin, diagnostics } = ttyStreams()
  const ports = createRunInteractionPorts({ stdin, diagnostics })
  assert.deepEqual(
    Object.keys(ports).sort(),
    ['onApproval', 'onDirectoryRequest', 'onSideEffectRecovery'],
  )
  for (const [name, port] of Object.entries(ports)) {
    assert.equal(typeof port, 'function', `${name} must be callable`)
  }
})

test('the approval port approves on y and denies otherwise', async () => {
  for (const [answer, expected] of [['y\n', 'approve'], ['yes\n', 'approve'], ['n\n', 'deny'], ['\n', 'deny'], ['maybe\n', 'deny']]) {
    const io = ttyStreams(answer)
    const ports = createRunInteractionPorts({ stdin: io.stdin, diagnostics: io.diagnostics })
    const decision = await ports.onApproval({
      payload: { toolName: 'write_file', args: { path: 'a.txt' } },
    })
    assert.equal(decision.decision, expected, `answer ${JSON.stringify(answer)}`)
    assert.match(io.text(), /\[approval\] tool=write_file/u)
  }
})

test('an aborted signal denies without prompting', async () => {
  const io = ttyStreams('y\n')
  const controller = new AbortController()
  controller.abort()
  const ports = createRunInteractionPorts({ stdin: io.stdin, diagnostics: io.diagnostics, signal: controller.signal })
  assert.deepEqual(await ports.onApproval({ payload: { toolName: 'write_file' } }), { decision: 'deny' })
  assert.equal(io.text(), '', 'no prompt is shown for an aborted turn')
})

test('approval and the recovery prompts all read from the same terminal', async () => {
  // Input is written after each prompt appears, which is how a terminal
  // behaves. (Pre-buffering both lines would be lost: each prompt creates its
  // own readline, so a line that arrives before the interface exists is
  // dropped. The interactive session avoids that with its queue-based reader.)
  const io = ttyStreams()
  const ports = createRunInteractionPorts({ stdin: io.stdin, diagnostics: io.diagnostics })
  const recoveryPromise = ports.onSideEffectRecovery({
    record: { toolName: 'bash_exec', toolCallId: 'c1', turnId: 't1', sessionId: 's1', argsDigest: 'abc' },
  })
  io.write('1\n')
  const recovery = await recoveryPromise
  // The recovery prompt maps "1" to "verified not performed", i.e. failed.
  assert.equal(recovery.resolution, 'failed')
  assert.equal(recovery.verificationConfirmed, true)
  assert.equal(recovery.confirmToolCallId, 'c1')
  assert.match(io.text(), /\[recovery\] tool="bash_exec"/u)

  const approvalPromise = ports.onApproval({ payload: { toolName: 'bash_exec', args: {} } })
  io.write('y\n')
  assert.equal((await approvalPromise).decision, 'approve')
})
