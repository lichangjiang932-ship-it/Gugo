import { getMemory, upsertMemory } from './memoryStore.js'
import { installValidatedSkillPack, resolveImportedSkillId } from './skillImport.js'
import { listAllRuntimeSkillIds } from './skillRegistry.js'

/**
 * Install the skill an experience-abstraction run proposed.
 *
 * A proposal lives in the memory store (see experienceAbstraction.js) precisely
 * so that installing it stays a decision rather than a side effect: the
 * abstraction writes what it learned, and the reader presses the button. The
 * installed skill is a normal pack — the same `skill.json` + `prompts/system.md`
 * that an imported one has, so nothing downstream needs to know it was generated.
 */

export const SKILL_PROPOSAL_MARKER = 'skill'
const PROCEDURE_LIMIT = 12_000

function manifestIdFrom(title) {
  const id = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return id || ''
}

/**
 * The pack a proposal becomes, or why it cannot become one. Pure: the caller
 * gets the files, the install step is separate.
 */
export function buildSkillPackFromProposal(memory, { locale = 'zh' } = {}) {
  const title = String(memory?.title || '').trim()
  const body = String(memory?.body || '').trim()
  if (!title) return { ok: false, reason: 'PROPOSAL_TITLE_MISSING' }
  if (!body) return { ok: false, reason: 'PROPOSAL_BODY_MISSING' }
  const id = manifestIdFrom(title)
  if (!id) return { ok: false, reason: 'PROPOSAL_ID_INVALID' }
  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) || title
  const intro = locale === 'en'
    ? 'This skill was distilled from local experience. Its trigger and steps follow:'
    : '这个技能由本机经验日志抽象而来，触发条件与步骤如下：'
  return {
    ok: true,
    manifestId: id,
    files: {
      'skill.json': JSON.stringify({
        id,
        name: title,
        description: firstLine.slice(0, 2_000),
        version: '1.0.0',
        // A skill distilled from the agent's own experience; the icon set has no
        // "learned" glyph, and this is the one that reads as remembering.
        icon: 'brainstorming',
        permissions: [],
      }, null, 2),
      'prompts/system.md': [
        '# ' + title,
        '',
        intro,
        '',
        body.slice(0, PROCEDURE_LIMIT),
        '',
      ].join('\n'),
    },
  }
}

/**
 * Install the proposal as a skill and record on the memory that it happened.
 *
 * Idempotent: a second press returns the already-installed skill instead of
 * creating a duplicate, because the button is a decision, not a counter.
 */
export function installSkillFromMemory({ userId = null, memoryId = '', locale = 'zh' } = {}) {
  if (!userId) return { ok: false, code: 'MEMORY_USER_REQUIRED', error: '未登录' }
  const memory = getMemory(userId, String(memoryId || '').trim())
  if (!memory) return { ok: false, code: 'MEMORY_NOT_FOUND', error: '记忆不存在' }
  if (memory.type !== 'reference' || memory.frontmatter?.proposal !== SKILL_PROPOSAL_MARKER) {
    return { ok: false, code: 'MEMORY_NOT_A_SKILL_PROPOSAL', error: '这条记忆不是技能候选' }
  }
  const installedSkillId = String(memory.frontmatter?.installedSkillId || '').trim()
  if (installedSkillId) return { ok: true, alreadyInstalled: true, skillId: installedSkillId, memory }

  const pack = buildSkillPackFromProposal(memory, { locale })
  if (!pack.ok) return { ok: false, code: pack.reason, error: '技能候选内容不完整，无法生成技能包' }

  const installed = installValidatedSkillPack({
    files: pack.files,
    existingIds: listAllRuntimeSkillIds(),
    userId,
  })
  if (!installed.ok) return { ok: false, code: 'SKILL_PACK_REJECTED', error: installed.reason }

  const savedMemory = upsertMemory({
    id: memory.id,
    userId,
    type: memory.type,
    title: memory.title,
    body: memory.body,
    frontmatter: {
      ...(memory.frontmatter || {}),
      installedSkillId: installed.skill.id,
      installedAt: new Date().toISOString(),
    },
    pinned: memory.pinned === true,
    sourceSessionId: memory.sourceSessionId || null,
    sourceMessageId: memory.sourceMessageId || null,
    agentId: memory.agentId || null,
  })
  return { ok: true, alreadyInstalled: false, skill: installed.skill, skillId: installed.skill.id, memory: savedMemory || memory }
}

export const _skillFromMemoryInternals = Object.freeze({ manifestIdFrom, resolveImportedSkillId })
