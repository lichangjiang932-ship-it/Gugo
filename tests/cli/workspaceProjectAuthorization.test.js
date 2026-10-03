import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { moduleUrl, workspaceSessionFixture } from './helpers/workspaceSessionHarness.js'

test('only the exact trusted CLI root can use process-scoped selection authority and a separate output directory', async (t) => {
  const f = await workspaceSessionFixture(t)
  const child = join(f.paths.workspace, 'nested')
  const escape = join(f.paths.workspace, 'escape')
  mkdirSync(child)
  symlinkSync(f.paths.other, escape, process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.read('no-session')
  const results = f.evaluate(`
    const { resolveTurnProjectDirectory } = await import(${JSON.stringify(moduleUrl('server/services/localFileAccessService.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    const trusted = { WORKSPACE_ROOT: ${JSON.stringify(f.paths.workspace)},
      GUGO_CLI_WORKSPACE_ROOT: ${JSON.stringify(f.paths.workspace)},
      WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHARED_TRUSTED: '1' }
    function resolve(workspacePath, overrides = {}) {
      Object.assign(process.env, trusted, overrides)
      try { return resolveTurnProjectDirectory({ userId: ${JSON.stringify(f.userId)}, workspacePath }) }
      catch (error) { return { code: error.code } }
    }
    try { process.stdout.write(JSON.stringify({
      exact: resolve(${JSON.stringify(f.paths.workspace)}),
      other: resolve(${JSON.stringify(f.paths.other)}),
      nested: resolve(${JSON.stringify(child)}),
      parent: resolve(${JSON.stringify(f.paths.launcher + '/..')}),
      escape: resolve(${JSON.stringify(escape)}),
      wrongMarker: resolve(${JSON.stringify(f.paths.workspace)}, { GUGO_CLI_WORKSPACE_ROOT: ${JSON.stringify(f.paths.other)} }),
      wrongRoot: resolve(${JSON.stringify(f.paths.workspace)}, { WORKSPACE_ROOT: ${JSON.stringify(f.paths.other)} }),
      noMarker: resolve(${JSON.stringify(f.paths.workspace)}, { GUGO_CLI_WORKSPACE_ROOT: '' }),
      disabled: resolve(${JSON.stringify(f.paths.workspace)}, { WORKSPACE_FS_ENABLED: '0' }),
      untrusted: resolve(${JSON.stringify(f.paths.workspace)}, { WORKSPACE_SHARED_TRUSTED: '0' }),
    })) } finally { closeDb() }
  `)
  assert.deepEqual(results.exact, { workspacePath: f.paths.workspace, projectDirectory: f.paths.workspace,
    defaultOutputDirectory: f.paths.output })
  for (const [name, result] of Object.entries(results)) {
    if (name !== 'exact') assert.equal(result.code, 'TURN_WORKSPACE_NOT_AUTHORIZED', name)
  }
  assert.deepEqual(f.read('no-session').grants, before.grants)
  assert.deepEqual(f.read('no-session').trust, before.trust)
})

test('a normal web selection retains its own output directory and revocation still takes effect', async (t) => {
  const f = await workspaceSessionFixture(t)
  const results = f.evaluate(`
    const { resolveTurnProjectDirectory, grantLocalPath, revokeLocalPath } = await import(${JSON.stringify(moduleUrl('server/services/localFileAccessService.js'))})
    const { setWorkspaceTrust } = await import(${JSON.stringify(moduleUrl('server/services/workspaceTrustService.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    const scope = { userId: ${JSON.stringify(f.userId)}, workspacePath: ${JSON.stringify(f.paths.workspace)} }
    try {
      const grant = grantLocalPath({ userId: scope.userId, rootPath: scope.workspacePath, accessMode: 'read_write' })
      setWorkspaceTrust({ userId: scope.userId, rootPath: scope.workspacePath, trusted: true, confirmation: 'TRUST_WORKSPACE_CONFIG' })
      const selected = resolveTurnProjectDirectory(scope)
      let foreignCode = null
      try { resolveTurnProjectDirectory({ ...scope, userId: 'workspace-other-owner' }) } catch (error) { foreignCode = error.code }
      revokeLocalPath({ userId: scope.userId, id: grant.id })
      let revokedCode = null
      try { resolveTurnProjectDirectory(scope) } catch (error) { revokedCode = error.code }
      process.stdout.write(JSON.stringify({ selected, foreignCode, revokedCode }))
    } finally { closeDb() }
  `, { WORKSPACE_SHARED_TRUSTED: '0', GUGO_CLI_WORKSPACE_ROOT: '', WORKSPACE_ROOT: f.paths.launcher })
  assert.deepEqual(results.selected, { workspacePath: f.paths.workspace, projectDirectory: f.paths.workspace,
    defaultOutputDirectory: f.paths.workspace })
  assert.equal(results.foreignCode, 'TURN_WORKSPACE_NOT_AUTHORIZED')
  assert.equal(results.revokedCode, 'TURN_WORKSPACE_NOT_AUTHORIZED')
})
