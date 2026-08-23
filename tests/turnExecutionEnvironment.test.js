import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinSpec } from '../server/services/toolRegistry.js'

import {
  assertTurnExecutionEnvironmentCompatible,
  createTurnExecutionEnvironmentSnapshot,
  normalizeTurnExecutionEnvironmentSnapshot,
  TURN_EXECUTION_ENVIRONMENT_MISSING,
  TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID,
  TURN_MODEL_BINDING_DRIFT,
  TURN_PERMISSION_CONTEXT_DRIFT,
  TURN_POLICY_CONTEXT_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  TURN_TOOL_CATALOG_DRIFT,
  TURN_TOOL_IMPLEMENTATION_DRIFT,
} from '../server/services/turnExecutionEnvironment.js'

const readSpec = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}

const DIGEST_A = `sha256-${'a'.repeat(64)}`
const DIGEST_B = `sha256-${'b'.repeat(64)}`
const TOOL_IMPLEMENTATIONS_A = Object.freeze({
  version: 1,
  builtinRevision: DIGEST_A,
  connectorRevision: null,
  mcpTools: [],
})

function runtimePluginState(releaseId, contentDigest = DIGEST_A) {
  return {
    pluginId: 'local-transformer',
    enabled: true,
    activeReleaseId: releaseId,
    activeReleaseDigestVersion: 1,
    activeReleaseContentDigest: contentDigest,
  }
}

function workspaceTrust({
  rootPath = 'D:/workspace',
  trustScope = 'persistent',
  configShell = true,
  effectiveShell = true,
  effectiveGit = true,
} = {}) {
  return {
    rootPath,
    trusted: true,
    available: true,
    trustRootPath: rootPath,
    trustScope,
    inherited: false,
    trustedAt: 10,
    updatedAt: 10,
    config: {
      present: true,
      valid: true,
      loaded: true,
      blocked: false,
      path: `${rootPath}/.gugo/config.json`,
      sourceRoot: rootPath,
      permissions: {
        fileSystem: true,
        fileSystemWrite: true,
        shell: configShell,
        git: true,
        gitMutation: false,
      },
    },
    global: {
      fileSystem: true,
      fileSystemWrite: true,
      shell: true,
      git: true,
      gitMutation: false,
    },
    effective: {
      fileSystem: true,
      fileSystemWrite: true,
      shell: effectiveShell,
      git: effectiveGit,
      gitMutation: false,
    },
  }
}

function snapshot(overrides = {}) {
  return createTurnExecutionEnvironmentSnapshot({
    modelName: 'local-model',
    modelProviderId: 'provider-local',
    modelConfigRevision: 3,
    approvalMode: 'normal',
    toolsConfig: { enabled: ['read_file'], disabled: [] },
    toolSpecs: [readSpec],
    toolImplementations: TOOL_IMPLEMENTATIONS_A,
    fileAccess: {
      projectDirectory: 'D:/workspace',
      defaultOutputDirectory: 'D:/workspace/output',
      grants: [],
      workspace: { enabled: false },
      runtime: { localCodeExecutionEnabled: true },
    },
    runtimePlugins: [],
    runtimePluginStates: [],
    ...overrides,
  })
}

test('turn execution environment snapshot is deterministic across input ordering', () => {
  const left = snapshot({ toolsConfig: { enabled: ['write_file', 'read_file'], disabled: [] } })
  const right = snapshot({ toolsConfig: { enabled: ['read_file', 'write_file'], disabled: [] } })
  assert.equal(left.fingerprint, right.fingerprint)
  const compatible = assertTurnExecutionEnvironmentCompatible(left, right)
  assert.deepEqual(compatible, right)
  assert.notEqual(compatible, right)
  assert.equal(Object.isFrozen(compatible), true)
  assert.equal(Object.isFrozen(compatible.toolCatalog[0].spec.function.parameters.properties.path), true)
})

test('chat-only mode is pinned into the model execution fingerprint', () => {
  const agent = snapshot({
    modelMode: 'agent',
    toolsConfig: { enabled: [], disabled: [] },
    toolSpecs: [],
  })
  const chatOnly = snapshot({
    modelMode: 'chat_only',
    toolsConfig: { enabled: [], disabled: [] },
    toolSpecs: [],
  })

  assert.equal(agent.model.mode, undefined)
  assert.equal(chatOnly.model.mode, 'chat_only')
  assert.notEqual(agent.components.model, chatOnly.components.model)
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(chatOnly, agent),
    (error) => error?.code === TURN_MODEL_BINDING_DRIFT
      && error?.unsafeToReplay === true,
  )
  assert.deepEqual(normalizeTurnExecutionEnvironmentSnapshot(chatOnly), chatOnly)
})

test('turn execution environment rejects permission and tool catalog drift', () => {
  const expected = snapshot()
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({ approvalMode: 'bypass' })),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT && error?.retryable === false,
  )
  const changedSpec = structuredClone(readSpec)
  changedSpec.function.description = 'Read a file with changed behavior contract'
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({ toolSpecs: [changedSpec] })),
    (error) => error?.code === TURN_TOOL_CATALOG_DRIFT && error?.unsafeToReplay === true,
  )
})

test('turn execution environment rejects implementation drift when tool schema is unchanged', () => {
  const expected = snapshot()
  const changed = snapshot({
    toolImplementations: {
      ...TOOL_IMPLEMENTATIONS_A,
      builtinRevision: DIGEST_B,
    },
  })
  assert.deepEqual(expected.toolCatalog, changed.toolCatalog)
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, changed),
    (error) => error?.code === TURN_TOOL_IMPLEMENTATION_DRIFT
      && error?.retryable === false
      && error?.unsafeToReplay === true,
  )
})

test('turn execution environment pins runtime policy provenance without volatile generations', () => {
  const builtinPolicy = {
    id: 'builtin.harness-policy',
    owner: 'builtin',
    version: '0.11.31',
    revision: 1,
    releaseDigest: null,
    generation: 1,
    source: 'registry_default',
  }
  const expected = snapshot({ policy: builtinPolicy })
  const sameBinding = snapshot({ policy: { ...builtinPolicy, generation: 99 } })
  assert.equal(expected.components.policy, sameBinding.components.policy)
  assert.doesNotThrow(() => assertTurnExecutionEnvironmentCompatible(expected, sameBinding))

  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(
      expected,
      snapshot({ policy: { ...builtinPolicy, revision: 2 } }),
    ),
    (error) => error?.code === TURN_POLICY_CONTEXT_DRIFT
      && error?.retryable === false
      && error?.unsafeToReplay === true,
  )

  const pluginPolicy = {
    id: 'plugin.policy.strict',
    owner: 'strict-policy-plugin',
    version: '1.0.0',
    revision: 4,
    releaseDigest: DIGEST_A,
    source: 'project_config',
  }
  const pluginExpected = snapshot({ policy: pluginPolicy })
  for (const policy of [
    { ...pluginPolicy, owner: 'other-plugin' },
    { ...pluginPolicy, releaseDigest: DIGEST_B },
  ]) {
    assert.throws(
      () => assertTurnExecutionEnvironmentCompatible(pluginExpected, snapshot({ policy })),
      (error) => error?.code === TURN_POLICY_CONTEXT_DRIFT,
    )
  }
})

test('turn execution environment pins immutable runtime plugin releases', () => {
  const runtimePlugins = [{
    id: 'local-transformer',
    version: '1.0.0',
    state: 'active',
    requires: [],
    contributes: ['tool:plugin_local_transformer'],
  }]
  const expected = snapshot({
    runtimePlugins,
    runtimePluginStates: [runtimePluginState('release-a')],
  })
  const changed = snapshot({
    runtimePlugins,
    runtimePluginStates: [runtimePluginState('release-b', DIGEST_B)],
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, changed),
    (error) => error?.code === TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  )
  const digestDrift = snapshot({
    runtimePlugins,
    runtimePluginStates: [runtimePluginState('release-a', DIGEST_B)],
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, digestDrift),
    (error) => error?.code === TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  )
  assert.deepEqual(expected.runtimePlugins.map((plugin) => ({
    releaseId: plugin.releaseId,
    digestVersion: plugin.digestVersion,
    contentDigest: plugin.contentDigest,
  })), [{ releaseId: 'release-a', digestVersion: 1, contentDigest: DIGEST_A }])
  const unpinned = snapshot({ runtimePlugins, runtimePluginStates: [] })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(unpinned, unpinned),
    (error) => error?.code === TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  )
})

test('verified directory authorization cannot waive approval mode or tool schema drift', () => {
  const directoryAuthorization = {
    type: 'directory_authorization',
    approved: true,
    path: 'D:/authorized',
    access_mode: 'read_write',
    resource_type: 'directory',
    grant_id: 'grant-1',
    authorization_scope: 'persistent',
    paused_sequence: 7,
  }
  const expected = snapshot({
    approvalMode: 'normal',
    toolsConfig: { enabled: [], disabled: [] },
  })
  const authorizedFileAccess = {
    projectDirectory: 'D:/authorized',
    defaultOutputDirectory: 'D:/authorized',
    grants: [{
      id: 'grant-1',
      path: 'D:/authorized',
      resourceType: 'directory',
      accessMode: 'read_write',
      scope: 'persistent',
      available: true,
    }],
    workspace: { enabled: false },
    runtime: { localCodeExecutionEnabled: true },
  }
  const directoryTools = [
    'list_directory', 'read_file', 'write_file', 'edit_file',
    'apply_patch', 'patch_file', 'bash_exec', 'run_command',
  ]
  const approvalDrift = snapshot({
    approvalMode: 'bypass',
    toolsConfig: { enabled: directoryTools, disabled: [] },
    fileAccess: authorizedFileAccess,
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, approvalDrift, { directoryAuthorization }),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )

  const changedSpec = structuredClone(readSpec)
  changedSpec.function.description = 'Changed during directory authorization'
  const schemaDrift = snapshot({
    toolsConfig: { enabled: directoryTools, disabled: [] },
    toolSpecs: [changedSpec],
    fileAccess: authorizedFileAccess,
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, schemaDrift, { directoryAuthorization }),
    (error) => error?.code === TURN_TOOL_CATALOG_DRIFT,
  )
})

test('stored snapshots recompute every component and root fingerprint before use', () => {
  const expected = snapshot()
  const toolTamper = structuredClone(expected)
  toolTamper.toolCatalog[0].spec.function.description = 'tampered after checkpoint persistence'
  assert.equal(normalizeTurnExecutionEnvironmentSnapshot(toolTamper), null)
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(toolTamper, expected),
    (error) => error?.code === TURN_EXECUTION_ENVIRONMENT_MISSING,
  )

  const componentTamper = structuredClone(expected)
  componentTamper.components.toolCatalog = '0'.repeat(64)
  assert.equal(normalizeTurnExecutionEnvironmentSnapshot(componentTamper), null)

  const rootTamper = structuredClone(expected)
  rootTamper.fingerprint = 'f'.repeat(64)
  assert.equal(normalizeTurnExecutionEnvironmentSnapshot(rootTamper), null)

  const storedNameTamper = structuredClone(expected)
  storedNameTamper.toolCatalog[0].name = 'write_file'
  assert.equal(normalizeTurnExecutionEnvironmentSnapshot(storedNameTamper), null)
})

test('tool projection rejects cycles, excessive depth and oversized schemas', () => {
  const cyclicSpec = structuredClone(readSpec)
  cyclicSpec.function.parameters.circular = cyclicSpec
  assert.throws(
    () => snapshot({ toolSpecs: [cyclicSpec] }),
    (error) => error?.code === TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID
      && error?.unsafeToReplay === true,
  )

  let deeplyNested = { type: 'string' }
  for (let depth = 0; depth < 70; depth += 1) deeplyNested = { nested: deeplyNested }
  const deepSpec = structuredClone(readSpec)
  deepSpec.function.parameters.properties.deep = deeplyNested
  assert.throws(
    () => snapshot({ toolSpecs: [deepSpec] }),
    (error) => error?.code === TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID,
  )

  const oversizedSpec = structuredClone(readSpec)
  oversizedSpec.function.description = 'x'.repeat(2 * 1024 * 1024)
  assert.throws(
    () => snapshot({ toolSpecs: [oversizedSpec] }),
    (error) => error?.code === TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID,
  )
})

test('workspace trust, config and effective shell/git capabilities are replay permissions', () => {
  const trust = workspaceTrust()
  const fileAccess = {
    allFilesEnabled: false,
    bypassEnabled: false,
    projectDirectory: 'D:/workspace',
    defaultOutputDirectory: 'D:/workspace/output',
    grants: [{
      id: 'workspace-grant',
      path: 'D:/workspace',
      resourceType: 'directory',
      accessMode: 'read_write',
      scope: 'persistent',
      available: true,
    }],
    workspace: {
      enabled: true,
      path: 'D:/workspace',
      sharedTrusted: false,
      requiresUserGrant: true,
      trust,
    },
    trustedWorkspaces: [trust],
    runtime: {
      platform: 'win32',
      hostFileSystem: true,
      localCodeExecutionEnabled: true,
    },
  }
  const expected = snapshot({ fileAccess })
  assert.equal(expected.fileAccess.workspace.trust.config.permissions.shell, true)
  assert.equal(expected.fileAccess.workspace.trust.effective.git, true)

  const configDriftTrust = workspaceTrust({ configShell: false, effectiveShell: false })
  const configDrift = snapshot({
    fileAccess: {
      ...fileAccess,
      workspace: { ...fileAccess.workspace, trust: configDriftTrust },
      trustedWorkspaces: [configDriftTrust],
    },
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, configDrift),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )

  const gitDriftTrust = workspaceTrust({ effectiveGit: false })
  const gitDrift = snapshot({
    fileAccess: {
      ...fileAccess,
      workspace: { ...fileAccess.workspace, trust: gitDriftTrust },
      trustedWorkspaces: [gitDriftTrust],
    },
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, gitDrift),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )

  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({
      fileAccess: { ...fileAccess, bypassEnabled: true },
    })),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )
})

test('directory upgrade is bound to the exact pause, grant, path, mode and scope', () => {
  const readWriteTools = [
    'list_directory', 'read_file', 'write_file', 'edit_file',
    'apply_patch', 'patch_file', 'bash_exec', 'run_command',
  ]
  const readOnlyTools = ['list_directory', 'read_file']
  const expected = snapshot({ toolsConfig: { enabled: [], disabled: [] } })
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: 'D:/authorized',
    access_mode: 'read_write',
    resource_type: 'directory',
    grant_id: 'grant-1',
    authorization_scope: 'persistent',
    paused_sequence: 9,
  }
  const grant = {
    id: 'grant-1',
    path: 'D:/authorized',
    resourceType: 'directory',
    accessMode: 'read_write',
    scope: 'persistent',
    available: true,
  }
  const authorizedFileAccess = {
    projectDirectory: 'D:/authorized',
    defaultOutputDirectory: 'D:/authorized',
    grants: [grant],
    workspace: { enabled: false },
    runtime: { localCodeExecutionEnabled: true },
  }
  const current = snapshot({
    toolsConfig: { enabled: readWriteTools, disabled: [] },
    fileAccess: authorizedFileAccess,
  })
  assert.equal(
    assertTurnExecutionEnvironmentCompatible(expected, current, {
      directoryAuthorization: resolution,
    }).fingerprint,
    current.fingerprint,
  )

  for (const directoryAuthorization of [
    { ...resolution, grant_id: 'grant-other' },
    { ...resolution, authorization_scope: 'session' },
    { ...resolution, path: 'D:/other' },
    { ...resolution, paused_sequence: undefined },
  ]) {
    assert.throws(
      () => assertTurnExecutionEnvironmentCompatible(expected, current, { directoryAuthorization }),
      (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
    )
  }

  const readOnlyResolution = {
    ...resolution,
    access_mode: 'read_only',
  }
  const exactReadOnly = snapshot({
    toolsConfig: { enabled: readOnlyTools, disabled: [] },
    fileAccess: {
      ...authorizedFileAccess,
      projectDirectory: 'D:/workspace',
      defaultOutputDirectory: 'D:/workspace/output',
      grants: [{ ...grant, accessMode: 'read_only' }],
    },
  })
  assert.doesNotThrow(() => assertTurnExecutionEnvironmentCompatible(expected, exactReadOnly, {
    directoryAuthorization: readOnlyResolution,
  }))

  const broaderGrant = snapshot({
    toolsConfig: { enabled: readOnlyTools, disabled: [] },
    fileAccess: {
      ...authorizedFileAccess,
      projectDirectory: 'D:/workspace',
      defaultOutputDirectory: 'D:/workspace/output',
      grants: [grant],
    },
  })
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, broaderGrant, {
      directoryAuthorization: readOnlyResolution,
    }),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )

  const unrelatedGrant = {
    id: 'unrelated',
    path: 'D:/unrelated',
    resourceType: 'directory',
    accessMode: 'read_only',
    scope: 'session',
    available: true,
  }
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({
      toolsConfig: { enabled: readWriteTools, disabled: [] },
      fileAccess: { ...authorizedFileAccess, grants: [grant, unrelatedGrant] },
    }), { directoryAuthorization: resolution }),
    (error) => error?.code === TURN_PERMISSION_CONTEXT_DRIFT,
  )
})

test('directory authorization permits only canonical schemas for its exact capability set', () => {
  const expected = snapshot({
    toolsConfig: { enabled: [], disabled: [] },
  })
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: 'D:/authorized',
    access_mode: 'read_write',
    resource_type: 'directory',
    grant_id: 'grant-1',
    authorization_scope: 'persistent',
    paused_sequence: 11,
  }
  const fileAccess = {
    projectDirectory: 'D:/authorized',
    defaultOutputDirectory: 'D:/authorized',
    grants: [{
      id: 'grant-1',
      path: 'D:/authorized',
      resourceType: 'directory',
      accessMode: 'read_write',
      scope: 'persistent',
      available: true,
    }],
    workspace: { enabled: false },
    runtime: { localCodeExecutionEnabled: true },
  }
  const enabled = [
    'list_directory', 'read_file', 'write_file', 'edit_file',
    'apply_patch', 'patch_file', 'bash_exec', 'run_command',
  ]
  const canonicalWrite = getBuiltinSpec('write_file')
  const allowed = snapshot({
    toolsConfig: { enabled, disabled: [] },
    toolSpecs: [readSpec, canonicalWrite],
    fileAccess,
  })
  assert.doesNotThrow(() => assertTurnExecutionEnvironmentCompatible(expected, allowed, {
    directoryAuthorization: resolution,
  }))

  const alteredWrite = structuredClone(canonicalWrite)
  alteredWrite.function.description = 'not the server-pinned schema'
  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({
      toolsConfig: { enabled, disabled: [] },
      toolSpecs: [readSpec, alteredWrite],
      fileAccess,
    }), { directoryAuthorization: resolution }),
    (error) => error?.code === TURN_TOOL_CATALOG_DRIFT,
  )

  assert.throws(
    () => assertTurnExecutionEnvironmentCompatible(expected, snapshot({
      toolsConfig: { enabled, disabled: [] },
      toolSpecs: [readSpec, getBuiltinSpec('git_status')],
      fileAccess,
    }), { directoryAuthorization: resolution }),
    (error) => error?.code === TURN_TOOL_CATALOG_DRIFT,
  )
})
