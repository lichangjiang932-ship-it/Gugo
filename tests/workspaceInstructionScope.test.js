import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { closeDb, createUser } from '../server/db.js'
import { readFileTool } from '../server/adapters/fsShellTools.js'
import {
  getProjectDirectory,
  getScopedTurnProjectDirectory,
  grantLocalPath,
  resolveTurnProjectDirectory,
  withTurnProjectDirectory,
} from '../server/services/localFileAccessService.js'
import {
  prepareBackgroundPromptContext,
  prepareTurnPromptContext,
} from '../server/services/turnPromptContext.js'
import { createTurnSchedulingRuntime } from '../server/services/turnSchedulingRuntime.js'
import { setWorkspaceTrust } from '../server/services/workspaceTrustService.js'
import {
  clearWorkspaceInstructionsCache,
  readWorkspaceInstructions,
} from '../server/services/workspaceInstructions.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-instruction-scope-'))
const alice = 'instructions-alice'
const bob = 'instructions-bob'
for (const userId of [alice, bob]) createUser({ id: userId, email: `${userId}@example.test` })

function project(name, marker) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory)
  if (marker) fs.writeFileSync(path.join(directory, 'AGENTS.md'), marker)
  return fs.realpathSync(directory)
}

const deployment = project('deployment', 'DEPLOYMENT_RULE_ONLY')
const projectB = project('project-b', 'PROJECT_B_RULE_ONLY')
const projectC = project('project-c', 'PROJECT_C_RULE_ONLY')
const emptyProject = project('empty-project')
const env = { WORKSPACE_ROOT: deployment, WORKSPACE_FS_ENABLED: '1', AGENT_INJECT_ENABLED: '0' }
for (const [userId, rootPath] of [[alice, projectB], [alice, projectC], [bob, projectC]]) {
  grantLocalPath({ userId, rootPath, accessMode: 'read_write' })
  setWorkspaceTrust({ userId, rootPath, trusted: true, confirmation: 'TRUST_WORKSPACE_CONFIG' })
}

test.after(() => {
  clearWorkspaceInstructionsCache()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

const promptDependencies = {
  prepareSkillsForPrompt: () => [],
  prepareSkillCatalogForPrompt: () => [],
  prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
  buildSessionsBlock: () => null,
  renderRuntimePromptBlocks: () => ({ blocks: [], errors: [] }),
  logWarn: (_scope, message) => assert.fail(message),
}

function contextInstructions(prepare, userId, settings = env) {
  const prepared = prepare({ userId, sessionId: 'scope-session', env: settings }, promptDependencies)
  return prepared.messages.filter((message) => message.content.startsWith('# Workspace Instructions'))
}

function assertContextRoot(userId, marker, settings = env) {
  for (const prepare of [prepareTurnPromptContext, prepareBackgroundPromptContext]) {
    const messages = contextInstructions(prepare, userId, settings)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].content, `# Workspace Instructions\n\nSource: AGENTS.md\n\n${marker}`)
  }
}

test('the scope-only getter requires the exact caller and performs no filesystem grant discovery', (t) => {
  t.mock.method(fs, 'existsSync', () => assert.fail('scope lookup must not scan saved grants'))
  assert.equal(getScopedTurnProjectDirectory({ userId: alice }), null)
  withTurnProjectDirectory({ userId: alice, projectDirectory: projectB }, () => {
    assert.equal(getScopedTurnProjectDirectory({ userId: alice }), projectB)
    for (const userId of [bob, null, undefined, '', ' ']) {
      assert.equal(getScopedTurnProjectDirectory({ userId }), null)
    }
  })
  withTurnProjectDirectory({ projectDirectory: projectB }, () => {
    assert.equal(getScopedTurnProjectDirectory(), null)
    assert.equal(getScopedTurnProjectDirectory({ userId: alice }), null)
  })
  assert.equal(getScopedTurnProjectDirectory({ userId: alice }), null)
})

test('scheduled main and background subagent prompts read the same authorized project as file tools', async () => {
  const active = new Map()
  let observed = false
  let released = false
  const resolved = resolveTurnProjectDirectory({ userId: alice, workspacePath: projectB })
  const schedule = createTurnSchedulingRuntime({
    active,
    scheduling: new Set(),
    leaseReleaseRetries: new Set(),
    isClosing: () => false,
    acquireLease: async () => ({
      controller: new AbortController(),
      release: async () => { released = true },
    }),
    runWithProjectDirectory: withTurnProjectDirectory,
    executeTurn: async () => {
      const file = await readFileTool({ userId: alice, path: 'AGENTS.md' })
      assert.equal(file.content, 'PROJECT_B_RULE_ONLY')
      assertContextRoot(alice, file.content)
      await Promise.resolve()
      assertContextRoot(alice, file.content)
      observed = true
    },
  })
  assert.equal(await schedule({ userId: alice, sessionId: 'scoped-turn', turnId: 'one', ...resolved }), true)
  await Promise.all([...active.values()].map((entry) => entry.promise))
  assert.equal(observed, true)
  assert.equal(released, true)
  assert.equal(active.size, 0)
})

test('same-user concurrent sessions and their awaited background work keep separate instruction roots', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pending = [[projectB, 'PROJECT_B_RULE_ONLY'], [projectC, 'PROJECT_C_RULE_ONLY']].map(
    ([projectDirectory, marker]) => withTurnProjectDirectory({ userId: alice, projectDirectory }, async () => {
      await gate
      assertContextRoot(alice, marker)
      await Promise.resolve()
      assert.equal(readWorkspaceInstructions({ userId: alice, env }).path, path.join(projectDirectory, 'AGENTS.md'))
    }),
  )
  release()
  await Promise.all(pending)
})

test('another user and an unidentified caller never inherit the current user instruction scope or cache', async () => {
  await withTurnProjectDirectory({ userId: alice, projectDirectory: projectB }, async () => {
    assertContextRoot(alice, 'PROJECT_B_RULE_ONLY')
    assertContextRoot(bob, 'DEPLOYMENT_RULE_ONLY')
    assertContextRoot(undefined, 'DEPLOYMENT_RULE_ONLY')
    await withTurnProjectDirectory({ userId: bob, projectDirectory: projectC }, async () => {
      await Promise.resolve()
      assertContextRoot(bob, 'PROJECT_C_RULE_ONLY')
      assertContextRoot(alice, 'DEPLOYMENT_RULE_ONLY')
    })
    assertContextRoot(alice, 'PROJECT_B_RULE_ONLY')
    assert.throws(() => resolveTurnProjectDirectory({ userId: bob, workspacePath: projectB }),
      { code: 'TURN_WORKSPACE_NOT_AUTHORIZED' })
    await assert.rejects(readFileTool({ userId: bob, path: path.join(projectB, 'AGENTS.md') }),
      { code: 'PATH_NOT_AUTHORIZED' })
  })
  assertContextRoot(alice, 'DEPLOYMENT_RULE_ONLY')
})

test('outside a turn the explicit global root wins over the most recent trusted user grant', () => {
  assert.notEqual(getProjectDirectory({ userId: alice }), deployment)
  assertContextRoot(alice, 'DEPLOYMENT_RULE_ONLY')
  assertContextRoot(bob, 'DEPLOYMENT_RULE_ONLY')
  assertContextRoot(undefined, 'DEPLOYMENT_RULE_ONLY')
})

test('project instruction and filesystem switches still disable scoped main and background instructions', () => {
  withTurnProjectDirectory({ userId: alice, projectDirectory: projectB }, () => {
    for (const settings of [
      { ...env, PROJECT_INSTRUCTIONS_ENABLED: '0' },
      { ...env, WORKSPACE_FS_ENABLED: '0' },
    ]) {
      assert.equal(readWorkspaceInstructions({ userId: alice, env: settings }), null)
      for (const prepare of [prepareTurnPromptContext, prepareBackgroundPromptContext]) {
        assert.deepEqual(contextInstructions(prepare, alice, settings), [])
      }
    }
  })
})

test('a selected project without instructions does not inherit an unrelated deployment instruction file', () => {
  withTurnProjectDirectory({ userId: alice, projectDirectory: emptyProject }, () => {
    assert.equal(readWorkspaceInstructions({ userId: alice, env }), null)
    for (const prepare of [prepareTurnPromptContext, prepareBackgroundPromptContext]) {
      assert.deepEqual(contextInstructions(prepare, alice), [])
    }
  })
})
