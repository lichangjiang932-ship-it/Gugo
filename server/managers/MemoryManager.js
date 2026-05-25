/**
 * server/managers/MemoryManager.js
 *
 * 记忆系统统一门面。
 */

import {
  listMemories,
  getMemory,
  upsertMemory,
  deleteMemory,
  touchMemoryUsage,
  selectActiveMemoriesForInjection,
  buildMemorySystemBlock,
  buildMemoryIndex,
} from '../services/memoryStore.js'

export const MemoryManager = {
  list: listMemories,
  get: getMemory,
  upsert: upsertMemory,
  remove: deleteMemory,
  touchUsage: touchMemoryUsage,
  selectActiveForInjection: selectActiveMemoriesForInjection,
  buildSystemBlock: buildMemorySystemBlock,
  buildIndex: buildMemoryIndex,
}
