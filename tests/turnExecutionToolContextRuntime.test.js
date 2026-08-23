import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnExecutionToolContextRuntime } from '../server/services/turnExecutionToolContextRuntime.js'

function spec(name) {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  }
}

function namesOf(specs) {
  return specs.map((entry) => entry.function.name)
}

function writableFileAccess() {
  return {
    grants: [{
      id: 'workspace-grant',
      resourceType: 'directory',
      accessMode: 'read_write',
      available: true,
    }],
    runtime: { localCodeExecutionEnabled: true },
  }
}

test('chat-only context never discovers or advertises tools', async () => {
  let approvalReads = 0
  let fileAccessReads = 0
  let resolverCalls = 0
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => {
      approvalReads += 1
      return 'plan'
    },
    readFileAccessStatus: () => {
      fileAccessReads += 1
      return writableFileAccess()
    },
    resolveToolSpecs: async () => {
      resolverCalls += 1
      return [spec('write_file')]
    },
  })

  const context = await runtime.resolve({
    userId: 'chat-only-user',
    content: 'Answer without tools.',
    modelMode: 'chat_only',
    toolsConfig: { enabled: ['write_file'], disabled: ['read_file'] },
    intentMode: 'execute',
    promptContextSkillIds: ['prompt-skill'],
    fallbackSkillIds: ['fallback-skill'],
    baseToolSpecs: [spec('write_file')],
  })

  assert.equal(approvalReads, 1)
  assert.equal(fileAccessReads, 0)
  assert.equal(resolverCalls, 0)
  assert.equal(context.normalizedModelMode, 'chat_only')
  assert.equal(context.chatOnlyMode, true)
  assert.equal(context.effectiveIntentMode, 'answer')
  assert.deepEqual(context.effectiveToolsConfig, { enabled: [], disabled: [] })
  assert.deepEqual(context.resolvedToolSpecs, [])
  assert.deepEqual(context.toolResolutionDecision, {
    version: 1,
    eligibleToolNames: [],
    excludedTools: [],
    discoveryIssues: [],
  })
  assert.deepEqual(context.effectiveSkillIds, ['prompt-skill'])
  assert.equal(context.activeSkillId, 'prompt-skill')
  assert.equal(context.currentApprovalMode, 'plan')
  assert.equal(context.effectiveApprovalMode, 'plan')
  assert.equal(context.modelToolFileAccessStatus, undefined)
})

test('host projection removes write and shell schemas returned by a plan-mode resolver', async () => {
  const baseToolSpecs = [
    spec('read_file'),
    spec('write_file'),
    spec('bash_exec'),
    spec('request_directory'),
  ]
  let resolverInput = null
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => 'plan',
    readFileAccessStatus: writableFileAccess,
    resolveToolSpecs: async (input) => {
      resolverInput = input
      input.onDecision({
        version: 7,
        excludedTools: [],
        discoveryIssues: [],
      })
      return baseToolSpecs
    },
  })

  const context = await runtime.resolve({
    userId: 'plan-user',
    content: 'Inspect this workspace.',
    modelMode: 'agent',
    intentMode: 'plan',
    baseToolSpecs,
  })

  assert.equal(resolverInput.permissionMode, 'plan')
  assert.deepEqual(namesOf(context.resolvedToolSpecs), ['read_file', 'request_directory'])
  assert.deepEqual(context.toolResolutionDecision.eligibleToolNames, [
    'read_file',
    'request_directory',
  ])
  for (const name of ['write_file', 'bash_exec']) {
    assert.ok(context.toolResolutionDecision.excludedTools.some((entry) => (
      entry.name === name
        && entry.stage === 'permission'
        && entry.reason === 'permission_mode_plan'
    )), name)
  }
  assert.equal(context.toolResolutionDecision.version, 7)
})

test('unreadable file access fails closed before tools reach the loop', async () => {
  const baseToolSpecs = [spec('request_directory'), spec('read_file'), spec('write_file')]
  let resolverFileAccess = 'unset'
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => 'normal',
    readFileAccessStatus: () => { throw new Error('authorization store unavailable') },
    resolveToolSpecs: async (input) => {
      resolverFileAccess = input.fileAccessStatus
      return baseToolSpecs
    },
  })

  const context = await runtime.resolve({
    userId: 'closed-user',
    content: 'Read a local file.',
    baseToolSpecs,
  })

  assert.equal(resolverFileAccess, null)
  assert.equal(context.modelToolFileAccessStatus, null)
  assert.deepEqual(namesOf(context.resolvedToolSpecs), ['request_directory'])
  for (const name of ['read_file', 'write_file']) {
    assert.ok(context.toolResolutionDecision.excludedTools.some((entry) => (
      entry.name === name
        && entry.stage === 'permission'
        && entry.reason === 'workspace_authorization_required'
    )), name)
  }
})

test('directory resume restores only the frozen checkpoint catalog and respects disabled tools', async () => {
  const readFile = spec('read_file')
  const listDirectory = spec('list_directory')
  const writeFile = spec('write_file')
  const bashExec = spec('bash_exec')
  const injected = spec('plugin_after_checkpoint')
  let resolverBaseNames = null
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => 'normal',
    readFileAccessStatus: writableFileAccess,
    resolveToolSpecs: async (input) => {
      resolverBaseNames = namesOf(input.baseSpecs)
      input.onDecision({ version: 1, excludedTools: [], discoveryIssues: [] })
      return [...input.baseSpecs, injected]
    },
  })

  const context = await runtime.resolve({
    userId: 'directory-resume-user',
    content: 'Continue in the authorized directory.',
    intentMode: 'auto',
    toolsConfig: { enabled: [], disabled: ['write_file'] },
    resumeResolution: {
      type: 'directory_authorization',
      approved: true,
      access_mode: 'read_write',
    },
    restoredCheckpointState: {
      approvalMode: 'normal',
      executionEnvironment: {
        toolCatalog: [{ name: 'read_file', spec: readFile }],
      },
    },
    baseToolSpecs: [spec('request_directory')],
    directoryAuthorizationToolSpecs: [listDirectory, readFile, writeFile, bashExec],
  })

  assert.deepEqual(resolverBaseNames, ['read_file', 'list_directory', 'write_file', 'bash_exec'])
  assert.equal(context.effectiveIntentMode, 'execute')
  assert.equal(context.effectiveToolsConfig.disabled.includes('write_file'), true)
  assert.equal(context.effectiveToolsConfig.enabled.includes('write_file'), false)
  assert.deepEqual(namesOf(context.resolvedToolSpecs), ['read_file', 'list_directory', 'bash_exec'])
  assert.ok(context.toolResolutionDecision.excludedTools.some((entry) => (
    entry.name === 'plugin_after_checkpoint'
      && entry.reason === 'directory_authorization_catalog_frozen'
  )))
  assert.ok(context.toolResolutionDecision.excludedTools.some((entry) => (
    entry.name === 'write_file' && entry.reason === 'tool_disabled'
  )))
})

test('checkpoint and current approval modes keep their distinct precedence', async () => {
  let approvalReads = 0
  let resolverPermissionMode = null
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => {
      approvalReads += 1
      return 'plan'
    },
    readFileAccessStatus: writableFileAccess,
    resolveToolSpecs: async (input) => {
      resolverPermissionMode = input.permissionMode
      return input.baseSpecs
    },
  })

  const context = await runtime.resolve({
    userId: 'approval-user',
    content: 'Resume with the persisted approval mode.',
    approvalMode: 'bypass',
    restoredCheckpointState: { approvalMode: 'normal' },
    promptContextSkillIds: [],
    fallbackSkillIds: ['fallback-skill'],
    baseToolSpecs: [spec('request_directory')],
  })

  assert.equal(approvalReads, 1)
  assert.equal(context.currentApprovalMode, 'bypass')
  assert.equal(context.effectiveApprovalMode, 'normal')
  assert.equal(resolverPermissionMode, 'normal')
  assert.deepEqual(context.effectiveSkillIds, ['fallback-skill'])
  assert.equal(context.activeSkillId, 'fallback-skill')
})

test('resolver failure records discovery loss and still applies the host projection', async () => {
  const baseToolSpecs = [spec('read_file'), spec('write_file'), spec('request_directory')]
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => 'plan',
    readFileAccessStatus: writableFileAccess,
    resolveToolSpecs: async () => { throw new Error('discovery failed') },
  })

  const context = await runtime.resolve({
    userId: 'resolver-failure-user',
    content: 'Inspect the workspace.',
    baseToolSpecs,
  })

  assert.deepEqual(namesOf(context.resolvedToolSpecs), ['read_file', 'request_directory'])
  assert.deepEqual(context.toolResolutionDecision.discoveryIssues, [
    { source: 'tool_resolution', reason: 'discovery_failed' },
  ])
  assert.ok(context.toolResolutionDecision.excludedTools.some((entry) => (
    entry.name === 'write_file'
      && entry.stage === 'permission'
      && entry.reason === 'permission_mode_plan'
  )))
})
