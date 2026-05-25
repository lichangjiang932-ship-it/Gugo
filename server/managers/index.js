/**
 * server/managers/index.js
 *
 * Manager facade 统一出口。caller 以后只需：
 *   import { SessionManager, JobManager, SkillManager, MemoryManager } from '../managers/index.js'
 *
 * 主动选择不提供默认实例汇总对象，避免初期隐藏依赖。未来如果加全局 ManagerRegistry，
 * 可以在这里加。
 */

export { SessionManager } from './SessionManager.js'
export { JobManager } from './JobManager.js'
export { SkillManager } from './SkillManager.js'
export { MemoryManager } from './MemoryManager.js'
