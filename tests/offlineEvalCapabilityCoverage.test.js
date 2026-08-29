import assert from 'node:assert/strict'
import test from 'node:test'

import { discoverOfflineEvalSuites } from './helpers/offlineEvalHarness.js'

const GLOBAL_MINIMUM_TASK_SCENARIOS = 3

// This registry is intentionally independent from suite discovery. The exact-set
// assertion below makes a newly discovered suite fail until its task-level
// coverage contract is reviewed and registered here.
const OFFLINE_EVAL_SUITE_CONTRACTS = Object.freeze({
  capability: {
    minimumCases: 15,
    requiredCategories: [
      'approval',
      'checkpoint',
      'completion',
      'core',
      'identity',
      'policy',
      'recovery',
      'retry',
      'stream-integrity',
      'tools',
      'validation',
    ],
    coverageSignals: [
      ['CAP-01', 'core'],
      ['CAP-02', 'tools'],
      ['CAP-03', 'tools'],
      ['SAFE-01', 'validation'],
      ['SAFE-02', 'validation'],
      ['SAFE-03', 'approval'],
      ['SAFE-04', 'approval'],
      ['SAFE-05', 'identity'],
      ['SAFE-06', 'policy'],
      ['SAFE-07', 'policy'],
      ['REL-01', 'checkpoint'],
      ['REL-02', 'retry'],
      ['REL-03', 'stream-integrity'],
      ['REL-04', 'recovery'],
      ['REL-05', 'completion'],
    ],
  },
  'code-mode': {
    minimumCases: 3,
    requiredCategories: ['task-completion', 'authority-boundary', 'resource-boundary'],
    coverageSignals: [
      ['CODE-01', 'task-completion'],
      ['CODE-02', 'authority-boundary'],
      ['CODE-03', 'resource-boundary'],
    ],
  },
  'codex-app-server': {
    minimumCases: 4,
    requiredCategories: [
      'agent-loop-consumer',
      'privacy-default',
      'task-completion',
      'trust-boundary',
    ],
    coverageSignals: [
      ['APP-01', 'privacy-default'],
      ['APP-02', 'task-completion'],
      ['APP-03', 'trust-boundary'],
      ['APP-04', 'agent-loop-consumer'],
    ],
  },
  'compaction-fidelity': {
    minimumCases: 5,
    requiredCategories: ['compaction-fidelity'],
    coverageSignals: [
      ['tool-round-boundary-stays-paired', 'compaction-fidelity'],
      ['summary-and-tail-carry-task-facts-forward', 'compaction-fidelity'],
      ['outbound-view-respects-message-budget', 'compaction-fidelity'],
      ['unbalanced-tool-chain-refused', 'compaction-fidelity'],
      ['mechanical-fallback-summary-always-present', 'compaction-fidelity'],
    ],
  },
  'compaction-port': {
    minimumCases: 3,
    requiredCategories: ['boundary', 'runtime', 'prompt'],
    coverageSignals: [
      ['CMP-01', 'boundary'],
      ['CMP-02', 'runtime'],
      ['CMP-03', 'prompt'],
    ],
  },
  'final-answer-evidence': {
    minimumCases: 3,
    requiredCategories: ['task-completion', 'incomplete-boundary', 'evidence-integrity'],
    coverageSignals: [
      ['ANSWER-01', 'task-completion'],
      ['ANSWER-02', 'incomplete-boundary'],
      ['ANSWER-03', 'evidence-integrity'],
    ],
  },
  lsp: {
    minimumCases: 3,
    requiredCategories: ['task-completion', 'routing-boundary', 'provider-recovery'],
    coverageSignals: [
      ['LSP-01', 'task-completion'],
      ['LSP-02', 'routing-boundary'],
      ['LSP-03', 'provider-recovery'],
    ],
  },
  'native-model-providers': {
    minimumCases: 3,
    requiredCategories: ['anthropic-task', 'gemini-task', 'provider-boundary'],
    coverageSignals: [
      ['PROVIDER-01', 'anthropic-task'],
      ['PROVIDER-02', 'gemini-task'],
      ['PROVIDER-03', 'provider-boundary'],
    ],
  },
  'outbound-network': {
    minimumCases: 4,
    requiredCategories: [
      'task-completion',
      'ssrf-boundary',
      'redirect-boundary',
      'url-policy',
    ],
    coverageSignals: [
      ['NET-01', 'task-completion'],
      ['NET-02', 'ssrf-boundary'],
      ['NET-03', 'redirect-boundary'],
      ['NET-04', 'url-policy'],
    ],
  },
  'plugin-revocation': {
    minimumCases: 3,
    requiredCategories: ['cleanup', 'retry', 'multi-part'],
    coverageSignals: [
      ['REV-01', 'cleanup'],
      ['REV-02', 'retry'],
      ['REV-03', 'multi-part'],
    ],
  },
  'reasoning-retention': {
    minimumCases: 3,
    requiredCategories: ['reasoning-retention'],
    coverageSignals: [
      ['reasoning-survives-tool-call-checkpoint', 'reasoning-retention'],
      ['blank-reasoning-never-persists', 'reasoning-retention'],
      ['reasoning-stays-out-of-tool-results', 'reasoning-retention'],
    ],
  },
  'shell-guard': {
    minimumCases: 5,
    requiredCategories: ['shell-guard'],
    coverageSignals: [
      ['adversarial-payloads-intercepted', 'shell-guard'],
      ['benign-dev-commands-pass', 'shell-guard'],
      ['destructive-baseline-still-holds', 'shell-guard'],
      ['path-syntax-guard-rejects-unresolvable-paths', 'shell-guard'],
      ['read-only-classifier-stays-conservative', 'shell-guard'],
    ],
  },
  'subagent-provider': {
    minimumCases: 3,
    requiredCategories: ['boundary', 'fallback', 'fail-closed'],
    coverageSignals: [
      ['SUBP-01', 'boundary'],
      ['SUBP-02', 'fallback'],
      ['SUBP-03', 'fail-closed'],
    ],
  },
})

test('every discovered offline eval suite has a reviewed task-level coverage contract', async () => {
  const suites = await discoverOfflineEvalSuites()
  const byId = new Map(suites.map((suite) => [suite.id, suite]))
  const discoveredSuiteIds = [...byId.keys()].sort()
  const registeredSuiteIds = Object.keys(OFFLINE_EVAL_SUITE_CONTRACTS).sort()

  assert.deepEqual(
    discoveredSuiteIds,
    registeredSuiteIds,
    'offline eval discovery and coverage contracts must contain exactly the same suite IDs',
  )

  for (const [suiteId, contract] of Object.entries(OFFLINE_EVAL_SUITE_CONTRACTS)) {
    const suite = byId.get(suiteId)
    assert.ok(
      Number.isInteger(contract.minimumCases)
        && contract.minimumCases >= GLOBAL_MINIMUM_TASK_SCENARIOS,
      `${suiteId} coverage contract must require at least ${GLOBAL_MINIMUM_TASK_SCENARIOS} task scenarios`,
    )
    assert.ok(
      suite.cases.length >= contract.minimumCases,
      `${suiteId} must retain at least ${contract.minimumCases} task scenarios`,
    )
    assert.ok(
      Array.isArray(contract.requiredCategories) && contract.requiredCategories.length > 0,
      `${suiteId} coverage contract must declare required categories`,
    )
    assert.equal(
      new Set(contract.requiredCategories).size,
      contract.requiredCategories.length,
      `${suiteId} coverage contract categories must be unique`,
    )
    assert.ok(
      Array.isArray(contract.coverageSignals)
        && contract.coverageSignals.length >= GLOBAL_MINIMUM_TASK_SCENARIOS,
      `${suiteId} coverage contract must bind at least ${GLOBAL_MINIMUM_TASK_SCENARIOS} scenario signals`,
    )

    const casesById = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase]))
    const signalIds = new Set()
    for (const signal of contract.coverageSignals) {
      assert.ok(
        Array.isArray(signal) && signal.length === 2,
        `${suiteId} has an invalid coverage signal`,
      )
      const [caseId, expectedCategory] = signal
      assert.equal(signalIds.has(caseId), false, `${suiteId} repeats coverage signal ${caseId}`)
      signalIds.add(caseId)
      const evalCase = casesById.get(caseId)
      assert.ok(evalCase, `${suiteId} is missing coverage signal ${caseId}`)
      assert.equal(
        evalCase.category,
        expectedCategory,
        `${suiteId}/${caseId} must retain category ${expectedCategory}`,
      )
    }

    assert.deepEqual(
      [...signalIds].sort(),
      [...casesById.keys()].sort(),
      `${suiteId} must register every discovered task scenario as a coverage signal`,
    )

    const categories = new Set(suite.cases.map((evalCase) => evalCase.category))
    assert.deepEqual(
      [...categories].sort(),
      [...contract.requiredCategories].sort(),
      `${suiteId} discovered categories and reviewed coverage categories must match exactly`,
    )
    for (const category of contract.requiredCategories) {
      assert.ok(
        contract.coverageSignals.some(([, signalCategory]) => signalCategory === category),
        `${suiteId} category ${category} must be anchored by a coverage signal`,
      )
    }
  }
})
