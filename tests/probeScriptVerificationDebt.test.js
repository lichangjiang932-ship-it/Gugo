import test from 'node:test'
import assert from 'node:assert/strict'

import { recordMutationEvidence } from '../server/services/loop/runtime-recordMutationEvidence.js'
import { isProbeLikeCall, isProductiveExecutionOutcome } from '../server/services/loop/heuristics/executionRecovery.js'
import { isCommandExecutionTool } from '../server/services/loop/heuristics/commandCapabilities.js'
import {
  isMutationExecutionCall,
  normalizeMutationTarget,
} from '../server/services/loop/heuristics/mutationClassification.js'
import { extractMutationTargets } from '../server/services/loop/heuristics/deletionTargets.js'

// A probe-named script used to be exploration whatever it did. After a real,
// verified edit, the model could write probe_render.py with file-writing code
// and run it: the run created no verification debt, so the earlier "verified"
// state still let the turn finish over writes nothing had checked. Whether a
// probe is exempt now depends on what the script is, not on its name.

function state() {
  return {
    d: { extractMutationTargets, isCommandExecutionTool, isMutationExecutionCall, isProbeLikeCall },
    executionConvergenceEnabled: true,
    executionScope: {},
    mutatingProbeScripts: new Set(),
    requestedMutationContract: { record: () => false },
    // The runtime's helper resolves the command's arguments against cwd; a
    // literal mention of the script is what matters here.
    commandReferencesTarget: (call, target) => String(call?.args?.command || '').includes(target),
  }
}

function record(s, call, result = { ok: true }) {
  const execution = { semanticControlCall: false, productiveExecution: isProductiveExecutionOutcome(call, result, null, {}) }
  return recordMutationEvidence(s, { result, artifactId: null }, call, true, execution)
}

const write = (content) => ({ name: 'write_file', args: { path: 'probe_render.py', content } })
const run = { name: 'run_command', args: { command: 'python probe_render.py' } }

test('running a probe script the model wrote with file-writing code counts as a mutation', () => {
  const s = state()
  assert.equal(record(s, write("open('src/app.js', 'w').write('x')\n")), false, 'writing the probe itself is not product work')
  assert.deepEqual([...s.mutatingProbeScripts], [normalizeMutationTarget('probe_render.py')])
  assert.equal(record(s, run, { ok: true, exitCode: 0, stdout: 'done' }), true)
  assert.equal(s.mutationExecutionObserved, true)
})

test('a read-only probe script the model wrote stays exploration', () => {
  const s = state()
  record(s, write('import fitz\nprint(fitz.VersionBind)\n'))
  assert.equal(s.mutatingProbeScripts.size, 0)
  assert.equal(record(s, run, { ok: true, exitCode: 0, stdout: 'PyMuPDF' }), false)
})

test('rewriting a probe as read-only lifts it; an edit of unknown body does not', () => {
  const s = state()
  record(s, write("open('out.txt', 'w').write('x')\n"))
  record(s, write("print('safe')\n"))
  assert.equal(s.mutatingProbeScripts.size, 0)
  record(s, { name: 'edit_file', args: { path: 'probe_render.py', old_string: 'a', new_string: 'b' } })
  assert.equal(s.mutatingProbeScripts.size, 1, 'an edit cannot be shown harmless')
})

test('an executor report of changed files is evidence even for a probe-named command', () => {
  const s = state()
  assert.equal(record(s, run, { ok: true, exitCode: 0, stdout: 'done', changedPaths: ['src/app.js'] }), true)
  // An authoritative empty report still leaves an unrelated probe alone.
  assert.equal(record(state(), run, { ok: true, exitCode: 0, stdout: 'done', changedPaths: [] }), false)
})
