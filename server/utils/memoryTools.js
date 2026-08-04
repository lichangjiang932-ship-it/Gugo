/**
 * 记忆写入工具 —— 让模型能自己记住跨会话有用的事实。
 *
 * 背景:记忆注入(selectActiveMemoriesForInjection)一直是通的,但**没人写**——
 * 只有 Memory 管理页能手动加。于是模型在同一个上下文里也像没有记忆:
 * 你告诉它「项目在 /path/to/money」「这个项目用 Python + FastAPI」,
 * 下一轮它照样不知道。Claude Code / Codex 都有这个能力。
 *
 * 设计取舍:
 *   - 只允许写 memoryStore 已有的 4 种 type,不新增 schema
 *   - 强制 userId,不跨用户
 *   - 幂等:同 title 覆盖而不是堆重复条目(按标题精确比对,不能用 slug ——
 *     slug 会把中文剥光,不同标题会归一成同一个值互相覆盖)
 *   - 不做删除 —— 删记忆是用户的事,模型不该有这个权限
 */
import { listMemories, upsertMemory } from '../services/memoryStore.js'

const ALLOWED_TYPES = ['user', 'feedback', 'project', 'reference']
const MAX_TITLE = 120
const MAX_BODY = 4000

export const MEMORY_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description: [
        '★ 把一条跨会话有用的事实存进长期记忆,下次对话会自动带回来。',
        '什么时候用:用户告诉你他的项目路径 / 技术栈 / 偏好 / 约定 / 反复要纠正你的同一件事。',
        '什么时候不用:只在本轮有用的中间结论、可以随时重新查到的代码细节、大段原文。',
        '同名 title 会覆盖而不是新增,所以修正旧认知就用同一个 title 再写一次。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ALLOWED_TYPES,
            description: 'user=用户本人偏好/身份;project=项目背景与约定;feedback=用户对你的纠正;reference=参考资料',
          },
          title: { type: 'string', description: '简短标题,同名会覆盖(如「money 项目路径」)' },
          body: { type: 'string', description: '具体内容,一两句话说清楚,别抄大段原文' },
        },
        required: ['type', 'title', 'body'],
      },
    },
  },
]

export function dispatchMemoryTool(name, args = {}, { userId = null, sessionId = null } = {}) {
  if (name !== 'remember') throw new Error(`unknown memory tool: ${name}`)
  if (!userId) return { ok: false, error: '未登录,无法写入记忆' }

  const type = String(args?.type || '').trim()
  const title = String(args?.title || '').trim().slice(0, MAX_TITLE)
  const body = String(args?.body || '').trim().slice(0, MAX_BODY)

  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, error: `type 必须是 ${ALLOWED_TYPES.join(' / ')} 之一` }
  }
  if (!title) return { ok: false, error: 'title 不能为空' }
  if (!body) return { ok: false, error: 'body 不能为空' }

  try {
    // 同名覆盖:按标题精确查现有条目。
    // 注意不能用 findBySlug —— slug 会把中文全部剥掉,
    // 「money 项目路径」和「技术栈」都会归一成同一个 'memory',
    // 用它查重会把不相干的记忆互相覆盖。这里直接比对 title。
    let existingId = null
    try {
      const existing = listMemories({ userId, limit: 500 })
        .find((m) => String(m.title || '').trim() === title)
      if (existing?.id) existingId = existing.id
    } catch {
      // 查重失败就当新建,不阻断
    }
    const memory = upsertMemory({
      id: existingId || undefined,
      userId,
      type,
      title,
      body,
      sourceSessionId: sessionId || null,
    })
    return {
      ok: true,
      id: memory.id,
      updated: !!existingId,
      summary: `${existingId ? '已更新' : '已记住'}:${title}`,
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}
