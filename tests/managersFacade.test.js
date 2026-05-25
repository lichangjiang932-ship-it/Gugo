/**
 * tests/managersFacade.test.js
 *
 * Manager facade 烟雾测试 — 确保 4 个 Manager 把核心方法都暴露出来，
 * 且转发的函数引用和 services 层的同源（这样未来加中间件不会偷偷断了）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionManager, JobManager, SkillManager, MemoryManager } from '../server/managers/index.js'
import * as dbMod from '../server/db.js'
import * as jobStore from '../server/services/jobStore.js'
import * as jobRuntime from '../server/services/jobRuntime.js'
import * as skillRegistry from '../server/services/skillRegistry.js'
import * as skillStore from '../server/services/skillStore.js'
import * as memoryStore from '../server/services/memoryStore.js'
import { seedSystemSkills } from '../server/services/seedSystemSkills.js'

test('SessionManager exposes auth + user APIs from db.js', () => {
  assert.equal(typeof SessionManager.getSessionByToken, 'function')
  assert.equal(typeof SessionManager.getUserById, 'function')
  assert.equal(typeof SessionManager.getUserByEmail, 'function')
  assert.equal(typeof SessionManager.createUser, 'function')
  assert.equal(typeof SessionManager.createSession, 'function')
  assert.equal(typeof SessionManager.deleteSession, 'function')

  // 转发同源校验
  assert.equal(SessionManager.getSessionByToken, dbMod.getSessionByToken)
  assert.equal(SessionManager.getUserById, dbMod.getUserById)
})

test('JobManager exposes CRUD + runtime APIs', () => {
  assert.equal(typeof JobManager.create, 'function')
  assert.equal(typeof JobManager.get, 'function')
  assert.equal(typeof JobManager.list, 'function')
  assert.equal(typeof JobManager.update, 'function')
  assert.equal(typeof JobManager.appendSteps, 'function')
  assert.equal(typeof JobManager.listQueuedSteps, 'function')
  assert.equal(typeof JobManager.getRuntime, 'function')
  assert.equal(typeof JobManager.closeRuntime, 'function')

  assert.equal(JobManager.create, jobStore.createJob)
  assert.equal(JobManager.getRuntime, jobRuntime.getJobRuntime)
})

test('SkillManager exposes runtime + imported + seed APIs', () => {
  assert.equal(typeof SkillManager.listRuntime, 'function')
  assert.equal(typeof SkillManager.getRuntime, 'function')
  assert.equal(typeof SkillManager.install, 'function')
  assert.equal(typeof SkillManager.getImported, 'function')
  assert.equal(typeof SkillManager.seedSystem, 'function')

  assert.equal(SkillManager.listRuntime, skillRegistry.listRuntimeSkills)
  assert.equal(SkillManager.install, skillStore.installSkill)
  assert.equal(SkillManager.seedSystem, seedSystemSkills)
})

test('MemoryManager exposes CRUD + injection helpers', () => {
  assert.equal(typeof MemoryManager.list, 'function')
  assert.equal(typeof MemoryManager.get, 'function')
  assert.equal(typeof MemoryManager.upsert, 'function')
  assert.equal(typeof MemoryManager.remove, 'function')
  assert.equal(typeof MemoryManager.selectActiveForInjection, 'function')
  assert.equal(typeof MemoryManager.buildSystemBlock, 'function')

  assert.equal(MemoryManager.list, memoryStore.listMemories)
  assert.equal(MemoryManager.remove, memoryStore.deleteMemory)
})
