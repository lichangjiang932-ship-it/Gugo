import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyToolRisk } from '../server/utils/approvalPolicy.js'
import {
  findMatchingTaskGrant,
  normalizeTaskGrant,
  normalizeTaskGrants,
} from '../server/utils/taskGrants.js'

const NORMAL = Object.freeze({
  origin: 'job',
  mode: 'unattended',
  permissionMode: 'normal',
})

test('task grants normalize exact shell argv prefixes and external target fields', () => {
  assert.deepEqual(normalizeTaskGrants([
    { tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' },
    { toolName: 'publish_report', target: { channelId: 'C-ops' } },
  ]), [
    { tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' },
    { tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'this-run' },
  ])
})

test('task grant validation rejects empty targets, wildcards, shell metacharacters, and local writes', () => {
  for (const target of [[], ['git'], ['git', 'pull*'], ['git', 'pull;whoami']]) {
    assert.throws(() => normalizeTaskGrant({ tool: 'bash_exec', target }), /target|wildcard|metacharacter/i)
  }
  for (const target of [{}, { channelId: 'C-*' }, { channelId: 'C-ops', repo: 'gugo' }]) {
    assert.throws(() => normalizeTaskGrant({ tool: 'publish_report', target }), /target|wildcard/i)
  }
  for (const tool of ['write_file', 'edit_file', 'apply_patch', 'git_push']) {
    assert.throws(
      () => normalizeTaskGrant({ tool, target: { path: 'output.txt' } }),
      (error) => error?.code === 'TASK_GRANT_LOCAL_WRITE_FORBIDDEN',
    )
  }
  for (const tool of ['process_kill', 'delete_everything', 'unknown_dynamic_writer']) {
    assert.throws(
      () => normalizeTaskGrant({ tool, target: { id: 'exact-target' } }),
      (error) => error?.code === 'TASK_GRANT_TOOL_UNSUPPORTED',
    )
  }
})

test('task grants retain explicitly declared connector writes', () => {
  assert.deepEqual(normalizeTaskGrant({
    tool: 'slack_send_message',
    target: { channelId: 'C-ops' },
  }), {
    tool: 'slack_send_message',
    target: { channelId: 'C-ops' },
    scope: 'this-run',
  })
})

test('shell task grants match only a safe exact argv prefix', () => {
  const grants = [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }]
  assert.ok(findMatchingTaskGrant('bash_exec', { command: 'git pull origin main' }, grants))
  assert.ok(findMatchingTaskGrant('bash_exec', { command: 'git "pull" origin main' }, grants))
  assert.equal(findMatchingTaskGrant('bash_exec', { command: 'git push origin main' }, grants), null)
  assert.equal(findMatchingTaskGrant('bash_exec', { command: 'git pull && whoami' }, grants), null)
  assert.equal(findMatchingTaskGrant('bash_exec', { command: 'git pull*' }, grants), null)
})

test('external task grants use one exact target field and honor expiration', () => {
  const forever = [{ tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'forever' }]
  assert.ok(findMatchingTaskGrant('publish_report', { channelId: 'C-ops', text: 'daily' }, forever))
  assert.equal(findMatchingTaskGrant('publish_report', { channelId: 'C-finance', text: 'daily' }, forever), null)

  const expiring = [{
    tool: 'publish_report',
    target: { channelId: 'C-ops' },
    scope: 'until-date',
    expiresAt: 2_000,
  }]
  assert.ok(findMatchingTaskGrant('publish_report', { channelId: 'C-ops' }, expiring, { now: 1_999 }))
  assert.equal(findMatchingTaskGrant('publish_report', { channelId: 'C-ops' }, expiring, { now: 2_000 }), null)
})

test('plan denial wins, then task grant wins over remembered and deployment modes', () => {
  const taskGrants = [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }]
  const plan = classifyToolRisk('bash_exec', { command: 'git pull origin main' }, {
    ...NORMAL,
    permissionMode: 'plan',
    taskGrants,
  })
  assert.equal(plan.denied, true)
  assert.match(plan.reason, /计划模式/)

  for (const mode of ['off', 'unattended', 'all']) {
    const allowed = classifyToolRisk('bash_exec', { command: 'git pull origin main' }, {
      ...NORMAL,
      mode,
      taskGrants,
      rememberedGrants: [{ toolName: 'bash_exec', commandPrefix: 'legacy' }],
    })
    assert.equal(allowed.needsApproval, false)
    assert.deepEqual(allowed.authorization, {
      kind: 'task_grant',
      source: 'task_grant',
      toolName: 'bash_exec',
      target: ['git', 'pull'],
      scope: 'forever',
    })
  }
})

test('local writes never consume task grants while exact external targets can', () => {
  const write = classifyToolRisk('write_file', { path: 'output.txt', content: 'x' }, {
    ...NORMAL,
    taskGrants: [{ tool: 'write_file', target: { path: 'output.txt' }, scope: 'forever' }],
  })
  assert.equal(write.needsApproval, true)
  assert.equal(write.authorization, undefined)

  const external = classifyToolRisk('publish_report', { channelId: 'C-ops', text: 'daily' }, {
    ...NORMAL,
    taskGrants: [{ tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'forever' }],
  })
  assert.equal(external.needsApproval, false)
  assert.equal(external.authorization?.kind, 'task_grant')
})
