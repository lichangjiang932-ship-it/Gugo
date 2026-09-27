import { recordExperience } from '../services/experienceRecorder.js'

/**
 * `record_experience` —— 把一次"踩坑 → 解决"写进工作区的经验日志。
 *
 * 与 `remember` 的分工是刻意的,两者都必要:
 *   - `remember` 存**事实**(项目路径、技术栈、用户偏好),回答"这个项目是什么样";
 *   - `record_experience` 存**经过**(目标、卡在哪、怎么解的),回答"这类事该怎么办"。
 * 事实可以随时问用户,经过只有亲自做过的人才知道——所以经过必须当场记,事后补不出来。
 *
 * 这是一个 append-only 的本地文件写入:`<workspace>/.agent/experience.md`。它只增不改,
 * 抽象化之后条目转入 `experience.archive.md`,用户随时可以直接打开改或删。
 */
export const EXPERIENCE_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'record_experience',
      description: [
        '★ 把这一次"踩坑 → 解决"记进工作区经验日志,供后续抽象成规则和技能。',
        '什么时候用:任务完成且过程有值得复用的东西时;或一次失败/报错被你真正解决之后。',
        '什么时候不用:常规操作、一句话就能重新查到的事实(那用 remember)、还没解决的猜测、大段代码或日志原文。',
        'blocker 可以留空(顺利做完的任务没有坑),但 goal / solution / evidence 必须写。',
        'evidence 必须指向真实存在的东西(turn id、文件路径、报错原文片段),没有证据的经验会被拒收。',
        '每个字段一句话说清楚,不要抄代码;真正的细节留在文件和提交里。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '这次原本要做什么(一句话)' },
          blocker: { type: 'string', description: '遇到了什么报错或阻碍(没有就省略)' },
          solution: { type: 'string', description: '最后用什么工具或改动解决的(一句话)' },
          evidence: { type: 'string', description: '证据:turns/文件路径/报错原文片段,指向真实存在的东西' },
          topic: { type: 'string', description: '简短主题,便于归类(如 sidebar-browser、pptx-verification)' },
          scope: { type: 'string', enum: ['user', 'project'], description: 'project=只在这个项目成立;user=跨项目通用' },
        },
        required: ['goal', 'solution', 'evidence'],
        additionalProperties: false,
      },
    },
  },
]

export const EXPERIENCE_TOOL_NAMES = Object.freeze(EXPERIENCE_TOOL_SPECS.map((spec) => spec.function.name))

export async function dispatchExperienceTool(
  name,
  args = {},
  { userId = null, sessionId = null, workspaceRoot = '', now = Date.now() } = {},
) {
  if (!EXPERIENCE_TOOL_NAMES.includes(name)) throw new Error(`unknown experience tool: ${name}`)
  const result = await recordExperience({
    userId,
    workspaceRoot,
    now,
    // The session id is a real, checkable pointer even when the caller supplied
    // no evidence of its own, so it is appended rather than replacing theirs.
    episode: { ...(args || {}), evidence: [String(args?.evidence || '').trim(), sessionId].filter(Boolean).join(';') },
  })
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  return {
    ok: true,
    id: result.entry.id,
    topic: result.entry.topic,
    pendingExperienceCount: result.pendingCount,
    journalPath: result.journalPath,
    summary: `已记录经验 ${result.entry.id}（待抽象 ${result.pendingCount} 条）`,
    ...(result.problems ? { problems: result.problems } : {}),
  }
}
