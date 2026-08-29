import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-runtime-plugin-policy-'))
process.env.APP_DATA_DIR = TMP_DIR
process.env.GUGO_LOAD_DOTENV = '0'

const {
  acquireRuntimePolicy,
  getActiveRuntimePolicyProvenance,
  listEffectiveRuntimeCapabilityBindings,
  prepareRuntimeCapabilitySnapshot,
} = await import('../server/core/runtimeCapabilityHost.js')
const {
  getRuntimePlugin,
  registerPlugin,
  unregisterPlugin,
} = await import('../server/plugins/pluginRegistry.js')
const {
  releaseApproval,
  requestApproval,
  revalidateToolPermission,
} = await import('../server/services/approvalGate.js')
const {
  decideApproval,
  listPendingApprovals,
} = await import('../server/services/approvalStore.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const BUILTIN_POLICY_ID = 'builtin.harness-policy'
const POLICY_DIGEST = `sha256-${'c'.repeat(64)}`

function manifest(id, contributes) {
  return {
    id,
    name: id,
    version: '3.2.1',
    integrity: POLICY_DIGEST,
    contributes,
  }
}

function policyId(pluginId) {
  return `plugin.${pluginId}.policy`
}

function policyAdapter(classify) {
  return Object.freeze({ contractVersion: 1, classify })
}

function registerPolicy(context, pluginId, classify, overrides = {}) {
  return context.policies.register(policyAdapter(classify), {
    id: policyId(pluginId),
    replaces: BUILTIN_POLICY_ID,
    priority: 100,
    ...overrides,
  })
}

function policyBinding() {
  return listEffectiveRuntimeCapabilityBindings()
    .find((entry) => entry.binding === 'policy:policy') || null
}

async function waitForPendingApproval(userId, { tries = 200 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const [approval] = listPendingApprovals({ userId, status: 'pending' })
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for pending approval')
}

test.before(async () => {
  await prepareRuntimeCapabilitySnapshot({
    env: {
      APP_DATA_DIR: TMP_DIR,
      GUGO_LOAD_DOTENV: '0',
    },
  })
})

test.after(() => {
  closeDb()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

test('runtime plugin policy replaces executable classification, exposes provenance, and restores builtin', async () => {
  const pluginId = 'bound-policy-plugin'
  const builtinLease = acquireRuntimePolicy()
  let receivedRequest = null
  await registerPlugin(manifest(pluginId, [`policy:${policyId(pluginId)}`]), (context) => {
    registerPolicy(context, pluginId, (request) => {
      receivedRequest = request
      return { decision: 'ask', risk: 'medium', reason: 'plugin review' }
    }, { revision: 7 })
  })

  let pluginLease
  try {
    const selected = policyBinding()
    assert.equal(selected?.id, policyId(pluginId))
    assert.equal(selected?.owner, pluginId)
    assert.equal(selected?.version, '3.2.1')
    assert.equal(selected?.revision, 7)
    assert.equal(selected?.releaseDigest, POLICY_DIGEST)
    assert.equal(selected?.replaces, BUILTIN_POLICY_ID)
    assert.equal(builtinLease.classify({
      toolName: 'read_file',
      args: { path: 'README.md' },
      options: { origin: 'job' },
    }).failure.code, 'RUNTIME_POLICY_BINDING_STALE')

    pluginLease = acquireRuntimePolicy()
    assert.deepEqual(pluginLease.provenance, {
      id: policyId(pluginId),
      owner: pluginId,
      version: '3.2.1',
      revision: 7,
      releaseDigest: POLICY_DIGEST,
      generation: selected.generation,
      source: 'registry_default',
    })
    const result = pluginLease.classify({
      toolName: 'write_file',
      args: { path: 'report.txt', content: 'local' },
      options: { origin: 'job', permissionMode: 'normal' },
    })
    assert.deepEqual(result, { decision: 'ask', risk: 'medium', reason: 'plugin review' })
    assert.equal(Object.isFrozen(receivedRequest), true)
    assert.equal(Object.isFrozen(receivedRequest.args), true)
    assert.equal(getActiveRuntimePolicyProvenance()?.id, policyId(pluginId))
  } finally {
    await unregisterPlugin(pluginId)
  }

  assert.equal(pluginLease.classify({
    toolName: 'read_file',
    args: {},
    options: {},
  }).failure.code, 'RUNTIME_POLICY_BINDING_STALE')
  assert.equal(policyBinding()?.id, BUILTIN_POLICY_ID)
  assert.equal(getActiveRuntimePolicyProvenance()?.owner, 'builtin')
  assert.equal(acquireRuntimePolicy().classify({
    toolName: 'read_file',
    args: { path: 'README.md' },
    options: { origin: 'job' },
  }).decision, 'allow')
})

test('runtime policy allow cannot waive run_code per-call human approval', async () => {
  const pluginId = 'run-code-allow-policy-plugin'
  const session = issueTestSession({
    email: `runtime-policy-run-code-${process.pid}@example.com`,
  })
  const jobId = `runtime-policy-run-code-job-${process.pid}`
  const args = { code: 'return 6 * 7', description: 'Calculate an answer' }
  createJob({ id: jobId, userId: session.userId, title: 'run_code policy guard', prompt: 'test' })
  setApprovalMode({ userId: session.userId, mode: 'bypass' })

  await registerPlugin(manifest(pluginId, [`policy:${policyId(pluginId)}`]), (context) => {
    registerPolicy(context, pluginId, () => ({
      decision: 'allow',
      risk: 'low',
      reason: 'plugin attempted to waive approval',
    }))
  })

  const controller = new AbortController()
  let pending
  try {
    const preApprovalCheck = revalidateToolPermission({
      userId: session.userId,
      origin: 'job',
      toolName: 'run_code',
      args,
      allowAsk: false,
    })
    assert.equal(preApprovalCheck.proceed, false)
    assert.equal(preApprovalCheck.approvalRequired, true)

    const terminalPermissionRevalidation = revalidateToolPermission({
      userId: session.userId,
      origin: 'job',
      toolName: 'run_code',
      args,
      allowAsk: true,
    })
    assert.equal(terminalPermissionRevalidation.proceed, true)

    pending = requestApproval({
      userId: session.userId,
      origin: 'job',
      jobId,
      toolName: 'run_code',
      args,
      mode: 'unattended',
      signal: controller.signal,
    })
    const approval = await waitForPendingApproval(session.userId)
    assert.equal(approval.toolName, 'run_code')
    assert.equal(approval.risk, 'high')
    assert.equal(decideApproval({
      userId: session.userId,
      id: approval.id,
      decision: 'approve',
    }).ok, true)
    releaseApproval(approval.id)

    const result = await pending
    pending = null
    assert.equal(result.proceed, true)
    assert.equal(result.approvalId, approval.id)
  } finally {
    controller.abort()
    if (pending) await pending
    await unregisterPlugin(pluginId)
  }

  assert.equal(policyBinding()?.id, BUILTIN_POLICY_ID)
})

test('plugin policy registration rejects undeclared, malformed, implicit, and low-priority replacements without residue', async () => {
  const attempts = [
    {
      id: 'undeclared-policy-plugin',
      contributes: [],
      setup(context, id) {
        registerPolicy(context, id, () => ({ decision: 'deny' }))
      },
      code: 'PLUGIN_CONTRIBUTION_UNDECLARED',
    },
    {
      id: 'malformed-policy-plugin',
      setup(context, id) {
        context.policies.register({ contractVersion: 1 }, {
          id: policyId(id),
          replaces: BUILTIN_POLICY_ID,
          priority: 100,
        })
      },
      code: 'RUNTIME_POLICY_ADAPTER_INVALID',
    },
    {
      id: 'implicit-policy-plugin',
      setup(context, id) {
        context.policies.register(policyAdapter(() => ({ decision: 'deny' })), {
          id: policyId(id),
          priority: 100,
        })
      },
      code: 'PLUGIN_POLICY_REPLACEMENT_REQUIRED',
    },
    {
      id: 'low-priority-policy-plugin',
      setup(context, id) {
        registerPolicy(context, id, () => ({ decision: 'deny' }), { priority: 0 })
      },
      code: 'PLUGIN_POLICY_REPLACEMENT_PRIORITY_INVALID',
    },
  ]
  for (const attempt of attempts) {
    const contributes = attempt.contributes ?? [`policy:${policyId(attempt.id)}`]
    await assert.rejects(
      registerPlugin(manifest(attempt.id, contributes), (context) => attempt.setup(context, attempt.id)),
      (error) => error?.code === attempt.code,
    )
    assert.equal(getRuntimePlugin(attempt.id), null)
    assert.equal(policyBinding()?.id, BUILTIN_POLICY_ID)
  }
})

test('active plugin policy exceptions, async returns, and invalid decisions remain executable fail-closed', async () => {
  const cases = [
    ['throwing-policy-plugin', () => { throw new Error('private policy failure') }, 'RUNTIME_POLICY_EXECUTION_FAILED'],
    ['async-policy-plugin', async () => ({ decision: 'allow' }), 'RUNTIME_POLICY_EXECUTION_FAILED'],
    ['invalid-result-policy-plugin', () => ({ decision: 'pass' }), 'RUNTIME_POLICY_RESULT_INVALID'],
  ]
  for (const [pluginId, classify, failureCode] of cases) {
    await registerPlugin(manifest(pluginId, [`policy:${policyId(pluginId)}`]), (context) => {
      registerPolicy(context, pluginId, classify)
    })
    try {
      const result = acquireRuntimePolicy().classify({
        toolName: 'write_file',
        args: { path: 'report.txt' },
        options: { origin: 'job' },
      })
      assert.equal(result.decision, 'deny')
      assert.equal(result.risk, 'high')
      assert.equal(result.failure.code, failureCode)
      assert.doesNotMatch(result.reason, /private policy failure/u)
    } finally {
      await unregisterPlugin(pluginId)
    }
    assert.equal(policyBinding()?.id, BUILTIN_POLICY_ID)
  }
})
