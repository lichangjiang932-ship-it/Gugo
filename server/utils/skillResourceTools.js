import { readSelectedSkillResource } from '../services/skillResourceRuntime.js'
export { SKILL_RESOURCE_TOOL_NAME, SKILL_RESOURCE_TOOL_SPECS } from './skillResourceToolSpecs.js'

export function dispatchSkillResourceTool(args, { job, skillId, signal } = {}) {
  return readSelectedSkillResource(args, {
    userId: job?.userId || null,
    skillIds: Array.isArray(job?.skillIds) ? job.skillIds : [],
    skillId,
    signal,
  })
}
