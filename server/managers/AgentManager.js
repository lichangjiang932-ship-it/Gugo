/**
 * server/managers/AgentManager.js
 *
 * Agent 人格管理统一门面。
 * 与 SessionManager / JobManager / SkillManager / MemoryManager 同级。
 */

import {
  listAgents,
  getAgent,
  getDefaultAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  ensureDefaultAgent,
} from '../services/agentStore.js'

export const AgentManager = {
  list: listAgents,
  get: getAgent,
  getDefault: getDefaultAgent,
  create: createAgent,
  update: updateAgent,
  remove: deleteAgent,
  ensureDefault: ensureDefaultAgent,
}
