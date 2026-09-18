import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  COMPLETION_POLICIES,
  COMPLETION_POLICY_IDS,
  COMPLETION_POLICY_SCHEMA_VERSION,
  COMPLETION_POLICY_VERSION,
  completionPolicyAttempts,
  completionPolicyById,
  completionPolicyDiagnostics,
  completionPolicyForStateKey,
  completionPolicyStateKeys,
  describeCompletionPolicies,
  exhaustedCompletionPolicies,
  restoreCompletionPolicyState,
} from '../server/services/loop/completionPolicy.js'
import {
  MAX_ARTIFACT_DELIVERY_RETRIES,
  MAX_DIRECTORY_RESUME_RETRIES,
  MAX_DELIVERABLE_SELECTION_RETRIES,
  MAX_EXECUTION_EVIDENCE_RETRIES,
  MAX_LOCAL_HTML_DELIVERY_RETRIES,
  MAX_MUTATION_VERIFICATION_RETRIES,
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  MAX_SOURCE_HANDOFF_RETRIES,
} from '../server/services/loop/heuristics/constants.js'

const LOOP_ROOT = path.join(process.cwd(), 'server', 'services', 'loop')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

function loopSource() {
  return walk(LOOP_ROOT)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
}

const EXPECTED_LIMITS = Object.freeze({
  artifactDeliveryRetries: MAX_ARTIFACT_DELIVERY_RETRIES,
  executionEvidenceRetries: MAX_EXECUTION_EVIDENCE_RETRIES,
  directoryResumeRetries: MAX_DIRECTORY_RESUME_RETRIES,
  mutationVerificationRetries: MAX_MUTATION_VERIFICATION_RETRIES,
  pdfLayoutVerificationRetries: MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  deliverableSelectionRetries: MAX_DELIVERABLE_SELECTION_RETRIES,
  sourceHandoffRetries: MAX_SOURCE_HANDOFF_RETRIES,
  localHtmlDeliveryRetries: MAX_LOCAL_HTML_DELIVERY_RETRIES,
})

test('completion policy definitions are unique, versioned and fully described', () => {
  assert.equal(COMPLETION_POLICY_SCHEMA_VERSION, 1)
  assert.equal(new Set(COMPLETION_POLICY_IDS).size, COMPLETION_POLICIES.length)
  for (const policy of COMPLETION_POLICIES) {
    assert.match(policy.id, /^[a-z][a-z0-9_]*$/u, policy.id)
    assert.equal(typeof policy.scope, 'string')
    assert.ok(policy.scope.length > 0, `${policy.id} needs a scope`)
    assert.ok(policy.resetOn.length > 0, `${policy.id} needs a documented reset condition`)
    assert.ok(policy.onExhausted.length > 0, `${policy.id} needs an exhaustion behavior`)
    if (policy.active) {
      assert.ok(Number.isSafeInteger(policy.limit) && policy.limit > 0, `${policy.id} limit`)
    } else {
      assert.equal(policy.limit, null, `${policy.id} inactive policy must not declare a limit`)
    }
  }
  const stateKeys = completionPolicyStateKeys()
  assert.equal(new Set(stateKeys).size, stateKeys.length, 'state keys must be unique')
})

test('active policy limits match the real runtime constants', () => {
  for (const [stateKey, limit] of Object.entries(EXPECTED_LIMITS)) {
    const policy = completionPolicyForStateKey(stateKey)
    assert.ok(policy, `no policy for ${stateKey}`)
    assert.equal(policy.limit, limit, `${stateKey} limit drifted from the runtime constant`)
    assert.equal(policy.active, true)
  }
  assert.equal(COMPLETION_POLICIES.filter((policy) => policy.active).length, 8)
  // The compatibility-only field must stay readable but inactive.
  const reasoning = completionPolicyById('execution_reasoning')
  assert.equal(reasoning.stateKey, 'executionReasoningRetries')
  assert.equal(reasoning.active, false)
})

test('every policy state key is persisted in the execution checkpoint', () => {
  const serializer = readFileSync(
    path.join(LOOP_ROOT, 'runtime-initializeExecution.js'),
    'utf8',
  )
  assert.ok(
    serializer.includes('completionPolicyVersion: COMPLETION_POLICY_VERSION'),
    'the checkpoint must record the completion policy version',
  )
  for (const stateKey of completionPolicyStateKeys()) {
    assert.ok(
      serializer.includes(`${stateKey}:`),
      `${stateKey} is not serialized in completionGuards`,
    )
  }
})

test('every active policy has a real increment site, and a reset site unless monotonic', () => {
  const source = loopSource()
  const monotonic = []
  for (const policy of COMPLETION_POLICIES.filter((entry) => entry.active)) {
    assert.ok(
      source.includes(`${policy.stateKey} += 1`),
      `${policy.id} has no increment site for ${policy.stateKey}`,
    )
    if (policy.monotonic === true) {
      monotonic.push(policy.id)
      continue
    }
    assert.ok(
      new RegExp(`${policy.stateKey} = (?:0|Math\\.max)`, 'u').test(source),
      `${policy.id} has no reset site for ${policy.stateKey}`,
    )
  }
  // Monotonic counters are deliberate: pin them so a new one is a reviewed change.
  assert.deepEqual(monotonic.sort(), ['directory_resume', 'execution_evidence', 'source_handoff'])
})

test('describeCompletionPolicies is a pure boundary projection', () => {
  const empty = describeCompletionPolicies()
  assert.equal(empty.length, COMPLETION_POLICIES.length)
  for (const entry of empty) assert.equal(entry.attempts, 0)

  // Missing, negative and non-numeric attempts read as zero without throwing.
  const partial = describeCompletionPolicies({
    executionEvidenceRetries: undefined,
    mutationVerificationRetries: -3,
    pdfLayoutVerificationRetries: 'x',
  })
  for (const entry of partial.filter((value) => value.stateKey !== 'localHtmlDeliveryRetries')) {
    assert.ok(entry.attempts >= 0)
  }

  const limit = MAX_MUTATION_VERIFICATION_RETRIES
  const boundary = (attempts) => describeCompletionPolicies({ mutationVerificationRetries: attempts })
    .find((entry) => entry.id === 'mutation_verification')

  assert.deepEqual(
    { attempts: boundary(limit - 1).attempts, remaining: boundary(limit - 1).remaining, exhausted: boundary(limit - 1).exhausted },
    { attempts: limit - 1, remaining: 1, exhausted: false },
  )
  assert.deepEqual(
    { attempts: boundary(limit).attempts, remaining: boundary(limit).remaining, exhausted: boundary(limit).exhausted },
    { attempts: limit, remaining: 0, exhausted: true },
  )
  assert.equal(boundary(limit + 5).exhausted, true, 'above the limit stays exhausted')
})

test('inactive compatibility policies are never reported as exhausted', () => {
  const state = { executionReasoningRetries: 99 }
  const entry = describeCompletionPolicies(state)
    .find((value) => value.id === 'execution_reasoning')
  assert.equal(entry.exhausted, false)
  assert.deepEqual(exhaustedCompletionPolicies(state), [])
})

test('legacy checkpoints upgrade to the versioned policy state without resetting counts', () => {
  const legacy = { mutationVerificationRetries: 2, localHtmlDeliveryRetries: 4 }
  const restored = restoreCompletionPolicyState(legacy)
  assert.equal(restored.version, COMPLETION_POLICY_VERSION)
  assert.equal(restored.sourceVersion, 0)
  assert.equal(restored.legacy, true)
  assert.equal(restored.counters.mutationVerificationRetries, 2)
  assert.equal(restored.counters.localHtmlDeliveryRetries, 4)
  // Missing legacy fields default to zero instead of inheriting ambient values.
  assert.equal(restored.counters.executionEvidenceRetries, 0)
  assert.equal(completionPolicyAttempts(legacy, 'sourceHandoffRetries'), 0)
  // A stored count above the limit stays exhausted after restore.
  assert.deepEqual(
    exhaustedCompletionPolicies({ mutationVerificationRetries: 7 }).sort(),
    ['mutation_verification'],
  )
})

test('a versioned checkpoint restores deterministically and matches a continuous run', () => {
  const persisted = {
    completionPolicyVersion: COMPLETION_POLICY_VERSION,
    artifactDeliveryRetries: 1,
    mutationVerificationRetries: 2,
    executionEvidenceRetries: 1,
  }
  const first = describeCompletionPolicies(restoreCompletionPolicyState(persisted).counters)
  const second = describeCompletionPolicies(restoreCompletionPolicyState(persisted).counters)
  assert.deepEqual(first, second)
  const continuous = describeCompletionPolicies(persisted)
  assert.deepEqual(first, continuous, 'resume and continuous completion state must agree')
})

test('completionPolicyDiagnostics reports only exercised policies in wire shape', () => {
  assert.deepEqual(completionPolicyDiagnostics({}), [])
  const diagnostics = completionPolicyDiagnostics({
    mutationVerificationRetries: 2,
    localHtmlDeliveryRetries: 1,
  })
  assert.deepEqual(diagnostics, [
    { id: 'mutation_verification', attempts: 2, limit: MAX_MUTATION_VERIFICATION_RETRIES, exhausted: true },
    { id: 'local_html_delivery', attempts: 1, limit: MAX_LOCAL_HTML_DELIVERY_RETRIES, exhausted: false },
  ])
  // Wire shape only: no stateKey/active/remaining fields leak into the event.
  for (const entry of diagnostics) {
    assert.deepEqual(Object.keys(entry).sort(), ['attempts', 'exhausted', 'id', 'limit'])
  }
})

test('an unknown future completion policy version fails closed', () => {
  for (const bad of [2, 99, '2']) {
    assert.throws(
      () => restoreCompletionPolicyState({ completionPolicyVersion: bad }),
      (error) => error?.code === 'COMPLETION_POLICY_VERSION_UNSUPPORTED'
        && error?.retryable === false,
      `version ${String(bad)} must fail closed`,
    )
  }
  for (const malformed of ['abc', -1, 1.5]) {
    assert.throws(
      () => restoreCompletionPolicyState({ completionPolicyVersion: malformed }),
      (error) => error?.code === 'COMPLETION_POLICY_VERSION_UNSUPPORTED',
      `malformed version ${String(malformed)} must fail closed`,
    )
  }
  // Absent and empty versions are the legacy shape, not an error.
  for (const legacy of [undefined, null, '']) {
    assert.equal(restoreCompletionPolicyState({ completionPolicyVersion: legacy }).legacy, true)
  }
})
