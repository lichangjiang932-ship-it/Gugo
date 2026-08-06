import { canonicalizeSkillId, detectArtifactIntent } from '../../shared/artifactIntent.js'

export function parseSkillCommand(content = '') {
  const match = String(content).match(/^\/([a-z0-9_-]+)\s*(.*)$/i)
  if (!match) return { skillId: null, userPrompt: String(content || '') }
  return {
    skillId: canonicalizeSkillId(match[1]),
    userPrompt: match[2],
  }
}

export function inferSkillIdFromPrompt(content = '') {
  const text = String(content || '').trim().toLowerCase()
  if (!text || text.startsWith('/')) return null
  const wantsPptx = detectArtifactIntent(text).pptx

  // 所有演示文稿请求统一进入 canonical PPT 技能；渲染格式由内部产物链路决定。
  if (wantsPptx) return 'ppt'

  // webpage：高级感网页 / 落地页
  if (
    /\b(landing|landingpage|landing\s*page)\b/i.test(text) ||
    /高级感\s*网页|高级\s*网页|落地\s*页|官网\s*首页|品牌\s*网页|营销\s*网页/i.test(text) ||
    /(做|生成|写|来\s*一个|来个).{0,4}(网页|页面|官网|landing)/i.test(text)
  ) {
    return 'webpage'
  }

  if (/代码审查|code\s*review|review\s*code|审查代码|代码质量|bug\s*检查/i.test(text)) return 'review'
  if (/写测试|生成测试|test\s*case|单元测试|add\s*test/i.test(text)) return 'test'
  if (/翻译|translate|英译中|中译英|translate\s*to/i.test(text)) return 'translate'
  if (/调研|行业分析|市场分析|竞品|research|行业研究/i.test(text)) return 'research'
  if (/项目计划|任务拆解|milestone|project\s*plan|规划|实施方案/i.test(text)) return 'plan'
  if (/生成代码|写代码|写一个|实现一个|create\s*a\s*component|coding|编程|重构|refactor/i.test(text)) return 'code'

  return null
}
