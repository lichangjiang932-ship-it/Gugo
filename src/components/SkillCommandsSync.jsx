import { useEffect } from 'react'
import { syncSkillsToCommands } from '../lib/commandRegistry.js'
import { listSkills } from '../lib/skillClient.js'
import { SKILLS } from '../data.js'

/**
 * Feature 9: 应用启动时把技能列表同步进 commandRegistry，
 * CommandPalette 才能搜到 /ppt /excel 等。
 *
 * 失败时回退到 data.js 内置 SKILLS 常量。
 */
export default function SkillCommandsSync() {
  useEffect(() => {
    // 先用本地常量保证立即可用
    syncSkillsToCommands(SKILLS)
    let cancelled = false
    listSkills()
      .then(({ skills }) => {
        if (cancelled) return
        if (Array.isArray(skills) && skills.length) {
          syncSkillsToCommands(skills)
        }
      })
      .catch((err) => {
        console.warn('[SkillCommandsSync] 远程技能同步失败:', err?.message || err)
      })
    return () => { cancelled = true }
  }, [])

  return null
}
