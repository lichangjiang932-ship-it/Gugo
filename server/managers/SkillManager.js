/**
 * server/managers/SkillManager.js
 *
 * Skill 系统统一门面：runtime / imported / seed 全部从这里走。
 */

import {
  listRuntimeSkills,
  getRuntimeSkill,
  listRuntimeSkillIds,
} from '../services/skillRegistry.js'
import {
  installSkill,
  getImportedSkill,
  listImportedSkills,
  listImportedSkillIds,
} from '../services/skillStore.js'
import { seedSystemSkills } from '../services/seedSystemSkills.js'

export const SkillManager = {
  // runtime (合并后的高层视图)
  listRuntime: listRuntimeSkills,
  getRuntime: getRuntimeSkill,
  listRuntimeIds: listRuntimeSkillIds,

  // imported (用户导入的 / SQLite-backed)
  install: installSkill,
  getImported: getImportedSkill,
  listImported: listImportedSkills,
  listImportedIds: listImportedSkillIds,

  // 系统级 seed
  seedSystem: seedSystemSkills,
}
