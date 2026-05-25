/**
 * slashItems — Phase 2 S4 纯函数
 *
 * 把 ChatSplit/ChatComposer 用到的 slash 菜单合并 / 过滤逻辑从 .jsx 拆出来，
 * 方便 node --test 直接 import（不能 import .jsx）。
 */

/** 给定查询字符串，按 id 或 name 过滤 list。空查询返全部。 */
export function filterByQuery(list, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return Array.isArray(list) ? list : []
  if (!Array.isArray(list)) return []
  return list.filter((item) => {
    const id = String(item?.id || '').toLowerCase()
    const name = String(item?.name || '').toLowerCase()
    return id.includes(q) || name.includes(q)
  })
}

/**
 * 把 skills + promptTemplates 按 query 合并成统一 items。
 * 顺序：skills 在前，templates 在后；同类内维持原次序。
 */
export function buildSlashItems({ skills = [], promptTemplates = [], query = '' } = {}) {
  const filteredSkills = filterByQuery(skills, query)
  const filteredTpls = filterByQuery(promptTemplates, query)
  return [
    ...filteredSkills.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc || s.description || '',
      recommended: !!s.recommended,
      kind: 'skill',
      raw: s,
    })),
    ...filteredTpls.map((p) => ({
      id: p.id,
      name: p.name,
      desc: p.description || '',
      recommended: false,
      kind: 'prompt-template',
      raw: p,
    })),
  ]
}
