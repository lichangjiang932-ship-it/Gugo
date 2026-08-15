export const SKILL_QUALITY_MARKER = '<!-- gugo-skill-quality:v1 -->'

const UNIVERSAL_CONTRACT = `## Runtime delivery contract
- Inspect the real inputs, available workspace, and current state before acting.
- Honor the requested operation and output format. Read-only review, translation, research, explanation, and planning tasks must not mutate files or external systems unless the user also asks for those changes.
- When the request authorizes changes, use the available tools to create or modify the real deliverable, then inspect the result, run the most relevant checks, fix in-scope failures, and re-check.
- Never claim that a command ran, a file changed, an external action completed, or an artifact was verified unless tool evidence confirms it. If a required capability is unavailable, state exactly what remains unverified.
- Treat scratch files, logs, screenshots, caches, and intermediate exports as internal work. Present only final deliverables unless the user explicitly asks for diagnostics.
- For artifact-producing tasks, link final deliverables by their real paths when the client supports file links and summarize verification. For answer-only tasks, return the requested answer without inventing a file deliverable.`

const CATEGORY_CONTRACTS = Object.freeze({
  web: 'When producing or changing a web deliverable, open the rendered result in a real browser when possible; verify target widths, overflow, keyboard focus, interactions, console errors, and readable contrast before delivery.',
  slides: 'When producing or changing slides, render the deck and inspect every slide for clipping, overlap, legibility, visual rhythm, editable text, correct count, and successful export before delivery.',
  document: 'When producing or changing a document artifact, render or reopen the exported file; verify headings, pagination, tables, links, fonts, margins, and that no requested content was lost.',
  spreadsheet: 'When producing or changing a spreadsheet, reopen the workbook; verify formulas, data types, ranges, totals, filters, charts, frozen panes, and representative values without replacing formulas with guessed numbers.',
  pdf: 'When producing or changing a PDF, render every page; verify page count, crop, orientation, searchable text where expected, form fields when relevant, and absence of clipping or blank pages.',
  image: 'When producing or changing an image, inspect the actual output at full size; verify dimensions, crop, transparency, text spelling, subject integrity, and requested format.',
  media: 'When producing or changing audio or video, probe and play representative segments; verify duration, streams, codec/container compatibility, synchronization, and audible or visible corruption.',
  code: 'When the request authorizes code changes, edit the real project, preserve its conventions, run focused tests plus relevant lint/type/build checks, and report any check that could not run. For code review only, report evidence-backed findings without silently editing the project.',
  research: 'For research, retrieve current primary sources when tools allow, distinguish evidence from inference, attach citations to claims, cross-check consequential facts, and label unresolved uncertainty.',
  connector: 'For connectors and external actions, inspect current state first, use least privilege, require confirmation at the final irreversible boundary when appropriate, and verify the remote result before claiming success.',
  planning: 'For plans, ground tasks in the actual repository or supplied constraints, include dependencies and measurable acceptance criteria, and do not claim implementation or validation that did not occur.',
  archive: 'When producing or changing archives, inspect inputs, preserve relative structure and metadata when requested, validate the result by listing or reopening it, and avoid including temporary or secret files.',
  general: 'Choose verification that directly exercises the requested outcome, while preserving any exact-output or read-only constraint in the active skill.',
})

// Classify from public metadata only. Skill prompts frequently mention tools or
// output formats as incidental examples, which must not override the skill's
// declared purpose (for example, an Excel skill mentioning a slide export).
const CATEGORY_RULES = [
  ['slides', /\b(pptx?|powerpoint|slides?|slide-deck|presentation-deck)\b|幻灯片|演示文稿/i],
  ['spreadsheet', /\b(xlsx?|spreadsheet|excel|csv|tsv|workbook)\b|电子表格|工作簿|数据清洗|透视分析|公式建议|分析表格/i],
  ['pdf', /\bpdf\b/i],
  ['web', /\b(html|css|javascript|typescript|react|nextjs|next\.js|vue|svelte|frontend|website|webpage|browser|playwright)\b|网页|网站|前端|浏览器/i],
  ['document', /\b(docx?|word|document|memo|report|minutes|writer|writing)\b|文档|报告|纪要|公文|长文|摘要|改写/i],
  ['image', /\b(image|photo|illustration|graphic|svg|png|jpe?g|webp)\b|图片|图像|海报|插画/i],
  ['media', /\b(audio|video|media|mp3|wav|mp4|subtitle|transcript)\b|音频|视频|字幕|转录/i],
  ['research', /\b(research|investigation|competitive-research|finance|financial-analysis)\b|研究|调研|竞品分析|财务分析|趋势判断/i],
  ['connector', /\b(connector|oauth|slack|notion|google-drive|dingtalk|whatsapp|jira|linear|trello|todoist|dropbox)\b|连接器|消息桥|本机浏览器直连/i],
  ['planning', /\b(plan|planning|roadmap|strategy)\b|计划|规划|路线图|里程碑|任务拆解/i],
  ['archive', /\b(zip|archive|compress|extract|tar)\b|归档|压缩|解压/i],
  ['code', /\b(code|coding|programming|developer|repository|git|unit-test|integration-test|debug|review|refactor|database|sql|tdd)\b|代码|编程|仓库|单元测试|集成测试|调试|审查|重构|数据库/i],
]

export function classifySkill(skill = {}) {
  const identity = [skill.id, skill.name].filter(Boolean).join('\n')
  const metadata = [
    skill.id,
    skill.name,
    skill.description,
    skill.desc,
    ...(Array.isArray(skill.permissions) ? skill.permissions : []),
  ].filter(Boolean).join('\n')
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(identity))?.[0]
    || CATEGORY_RULES.find(([, pattern]) => pattern.test(metadata))?.[0]
    || 'general'
}

export function getSkillQualityContract(skill = {}) {
  const category = classifySkill(skill)
  return [
    SKILL_QUALITY_MARKER,
    UNIVERSAL_CONTRACT,
    `### ${category} verification\n- ${CATEGORY_CONTRACTS[category]}`,
  ].join('\n\n')
}

export function hasSkillQualityContract(skill = {}, value = skill.systemPrompt) {
  const prompt = String(value || '').trim()
  const contract = getSkillQualityContract(skill)
  return prompt === contract || prompt.endsWith(`\n\n${contract}`)
}

export function applySkillQualityContract(skill = {}) {
  const prompt = String(skill.systemPrompt || '').trim()
  if (hasSkillQualityContract(skill, prompt)) return prompt
  return [prompt, getSkillQualityContract(skill)]
    .filter(Boolean)
    .join('\n\n')
}
