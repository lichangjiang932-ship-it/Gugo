const MIN_SLIDES = 4
const MAX_SLIDES = 16

const CHINESE_NUMERAL_MAP = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function slot(type, intent, title, content, visual, htmlClass = type) {
  return { type, intent, title, content, visual, htmlClass }
}

export const PRESENTATION_TEMPLATES = [
  {
    id: 'technology',
    label: 'Technology / AI narrative',
    defaultSlideCount: 8,
    theme: '科技蓝紫：深色封面、荧光网格、架构图、指标卡',
    keywords: ['ai', 'llm', 'deepseek', 'gpt', 'claude', 'codex', '模型', '大模型', '人工智能', '算法', '技术', '架构', '算力', '推理', 'v4'],
    slots: [
      slot('cover', 'position the technology as a strategic shift', '把技术命题写成一句高势能判断', '一句话定义对象 + 受众为什么现在必须关注', '暗色渐变封面、模型光环、版本徽章', 'cover'),
      slot('section', 'frame the core thesis before details', '核心判断：从能力演示进入生产系统', '说明该技术解决的真实业务瓶颈与时间窗口', '章节页、大数字、水印关键词', 'section'),
      slot('data', 'quantify proof and operating constraints', '关键指标决定落地边界', '3-4 个指标：上下文、延迟、成本、可靠性；无真实数据时标注可替换数据', 'KPI 卡 + 细线网格', 'kpi'),
      slot('process', 'explain system or architecture mechanism', '能力来自模型、工具与数据闭环的协同', '分 4 步讲清输入、推理、工具调用、反馈评估的因果链', '横向流程/架构链路', 'process'),
      slot('split', 'compare against legacy or competing alternatives', '优势不在单点参数，而在交付确定性', '左列旧范式/竞品，右列新范式/差异化；每列 3 点', '左右对比卡', 'split'),
      slot('chart', 'show adoption or performance trajectory', '采用曲线取决于成本曲线与集成深度', '给 bar/line chart：试点、扩展、生产、规模化', '趋势图 + 注释标签', 'chart'),
      slot('content', 'surface risks, governance, and tradeoffs', '真正的门槛是治理、观测与失败恢复', '3-4 条观点卡，每条写“主张；证据/机制/影响”', '深色观点卡矩阵', 'content'),
      slot('process', 'turn technology into an actionable roadmap', '路线图应从低风险场景切入再扩展', '30/60/90 天推进：试点、评估、集成、治理', '时间轴/里程碑', 'process'),
      slot('end', 'close with a memorable strategic takeaway', '结论：把模型能力变成系统能力', '一句收束 + 下一步行动', '暗色结束页、光晕、行动按钮感', 'end'),
    ],
  },
  {
    id: 'fundraising',
    label: 'Fundraising / investor pitch',
    defaultSlideCount: 10,
    theme: '融资黑金：强封面、市场地图、商业模型、资金用途',
    keywords: ['融资', '路演', 'pitch', 'investor', '投资人', 'a轮', 'b轮', 'pre-a', 'seed', 'tam', '估值', '资金用途', '商业模式'],
    slots: [
      slot('cover', 'position the company as an inevitable opportunity', '一句话定义投资机会', '公司/项目名 + 赛道 + 关键牵引力', '黑金封面、赛道标签', 'cover'),
      slot('section', 'state why now', '市场拐点正在创造新入口', '政策、技术、需求或成本曲线的变化', '章节页 + 拐点时间标', 'section'),
      slot('data', 'market size and urgency / TAM', 'TAM 与切入市场共同决定上限', 'TAM/SAM/SOM 或可替换数据，标明口径', '大数字 KPI 卡', 'kpi'),
      slot('content', 'customer pain and current broken workflow', '客户不是缺工具，而是缺确定性结果', '3-4 条痛点，每条写证据或业务损失', '问题卡矩阵', 'content'),
      slot('process', 'product solution and workflow', '解决方案把分散流程压缩为闭环', '用步骤展示产品如何完成关键任务', '流程图/产品闭环', 'process'),
      slot('split', 'business model and moat', '护城河来自分发、数据与切换成本叠加', '左列收入模型，右列壁垒机制', '双栏模型图', 'split'),
      slot('content', 'funding use and milestones', '资金用途必须对应 18 个月里程碑', '研发、销售、交付、合规；每条绑定产出', '资金用途卡片', 'content'),
      slot('chart', 'traction or growth evidence', '增长质量比增长速度更能说明续约潜力', 'MRR/留存/试点转化/管线，无法确认则标可替换数据', '增长曲线', 'chart'),
      slot('process', 'execution roadmap', '下一轮融资前要证明可复制增长', '季度里程碑、关键风险、验收指标', '路线图', 'process'),
      slot('end', 'ask and closing conviction', '投资要点：用确定性穿透周期', '融资金额/合作诉求/下一步', '黑金结束页', 'end'),
    ],
  },
  {
    id: 'product',
    label: 'Product launch / product strategy',
    defaultSlideCount: 8,
    theme: '产品珊瑚：场景图、功能卡、用户旅程、路线图',
    keywords: ['产品', '发布', '功能', '用户', '体验', '场景', 'app', 'saas', '介绍', '卖点', 'roadmap', '路线图', '增长'],
    slots: [
      slot('cover', 'turn product into a category promise', '一句话定义产品承诺', '产品名 + 目标用户 + 核心价值', '品牌色封面、产品徽章', 'cover'),
      slot('section', 'anchor user context', '目标用户的任务正在变复杂', '用户是谁、在什么场景下失败、为什么现在需要新方案', '用户场景章节页', 'section'),
      slot('content', 'pain points and buying trigger', '购买触发来自高频损耗而非新鲜感', '3-4 条痛点卡：主张；证据/影响', '痛点卡片', 'content'),
      slot('process', 'product workflow', '产品价值藏在端到端流程压缩里', '用 4 步讲清从输入到结果的体验闭环', '用户旅程', 'process'),
      slot('split', 'feature differentiation', '差异化来自场景深度而非功能数量', '左列基础能力，右列高级能力/差异化', '双栏功能矩阵', 'split'),
      slot('data', 'proof of value', '价值证明要落到时间、成本和质量', '节省时间、转化提升、错误降低、满意度', 'KPI 卡', 'kpi'),
      slot('process', 'launch and adoption roadmap', '发布节奏决定用户教育成本', 'Beta、首发、扩张、生态合作', '时间轴', 'process'),
      slot('end', 'close with product promise', '结论：让用户更快抵达确定结果', '一句产品宣言 + 下一步行动', '品牌结束页', 'end'),
    ],
  },
  {
    id: 'research',
    label: 'Research report / industry insight',
    defaultSlideCount: 9,
    theme: '研究暖金：摘要、框架、证据链、情景推演',
    keywords: ['研究', '报告', '行业', '趋势', '洞察', '白皮书', '论文', '分析', '调研', '政策', '市场格局', '竞争格局'],
    slots: [
      slot('cover', 'name the research question', '把研究问题压成一句判断', '主题 + 范围 + 时间窗口', '暖金封面、报告编号', 'cover'),
      slot('toc', 'show the argument map', '报告先给读者路线图', '3-5 个章节标题，必须是结论式', '目录/论证地图', 'toc'),
      slot('section', 'state executive summary', '核心发现先行，细节服务判断', '3 条关键发现 + 一个反直觉洞察', '摘要页', 'section'),
      slot('data', 'evidence base and market facts', '数据口径决定结论可信度', '规模、增速、渗透率、集中度；标注可替换数据', 'KPI 证据卡', 'kpi'),
      slot('chart', 'trend or scenario curve', '趋势不是线性增长，而是阶段跃迁', '给 line/bar chart，展示阶段变化', '趋势图', 'chart'),
      slot('split', 'segmentation or stakeholder map', '分层后才能看到真正机会', '左列高潜人群/场景，右列低效/风险场景', '分层矩阵', 'split'),
      slot('content', 'implications and second-order effects', '二阶影响决定战略价值', '3-4 条观点卡，每条写机制与影响', '洞察卡矩阵', 'content'),
      slot('process', 'recommended actions', '行动建议要对应不确定性等级', '立即做、观察、暂缓、需验证', '行动优先级', 'process'),
      slot('end', 'close with research thesis', '结论：机会属于先建立证据闭环的一方', '一句总结 + 后续研究方向', '报告结束页', 'end'),
    ],
  },
  {
    id: 'business',
    label: 'Business strategy / consulting deck',
    defaultSlideCount: 9,
    theme: '咨询墨绿：问题树、收益池、选择矩阵、行动路线',
    keywords: ['战略', '商业', '咨询', '增长', '运营', '降本', '效率', '组织', '方案', '规划', '转型', '管理'],
    slots: [
      slot('cover', 'frame the strategic decision', '一句话定义战略议题', '客户/主题 + 时间窗口 + 核心目标', '墨绿封面、咨询编号', 'cover'),
      slot('toc', 'make the storyline explicit', '决策需要先看清论证路径', '现状、洞察、选择、行动', '目录页', 'toc'),
      slot('section', 'executive recommendation', '建议不是选项列表，而是明确取舍', '一句建议 + 3 个支撑理由', '执行摘要', 'section'),
      slot('data', 'size the prize', '收益池大小决定资源优先级', '收入、成本、效率、风险四类指标', 'KPI 卡', 'kpi'),
      slot('split', 'compare strategic options', '真正的选择是速度、成本和控制权的权衡', '方案 A/B 对比：收益、成本、风险、前置条件', '选项矩阵', 'split'),
      slot('chart', 'show economics or operating leverage', '杠杆来自关键瓶颈被持续压缩', '给 bar/line chart 展示收益路径', '经济性图表', 'chart'),
      slot('process', 'implementation roadmap', '落地顺序要先验证最大不确定性', '诊断、试点、扩张、制度化', '路线图', 'process'),
      slot('content', 'risks and governance', '没有治理的增长会把复杂度后移', '3-4 条风险卡：触发条件与缓解动作', '风险卡片', 'content'),
      slot('end', 'close with decision ask', '结论：用小步验证换取大规模确定性', '下一步决策/资源/时间点', '咨询结束页', 'end'),
    ],
  },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeText(text = '') {
  return String(text || '').toLowerCase()
}

export function inferRequestedSlideCount(prompt = '') {
  const text = String(prompt || '')
  const digitMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*(?:页|頁|slides?|pages?)/i)
  if (digitMatch) return clamp(Number(digitMatch[1]), MIN_SLIDES, MAX_SLIDES)

  const chineseMatch = text.match(/([一二两三四五六七八九十])\s*(?:页|頁)/)
  if (chineseMatch) return clamp(CHINESE_NUMERAL_MAP[chineseMatch[1]], MIN_SLIDES, MAX_SLIDES)

  return null
}

export function selectPresentationTemplate(topic = '') {
  const text = normalizeText(topic)
  const scored = PRESENTATION_TEMPLATES.map((template, index) => {
    const score = template.keywords.reduce((sum, keyword) => {
      const key = normalizeText(keyword)
      return text.includes(key) ? sum + Math.max(1, Math.min(4, key.length / 2)) : sum
    }, 0)
    return { template, score, index }
  }).sort((a, b) => b.score - a.score || a.index - b.index)

  return scored[0]?.score > 0 ? scored[0].template : PRESENTATION_TEMPLATES.find((template) => template.id === 'business')
}

function expandSlots(template, count) {
  const middleSlots = template.slots.filter((item) => item.type !== 'cover' && item.type !== 'end')
  const needed = Math.max(0, count - 2)
  const selected = []
  for (let i = 0; i < needed; i += 1) {
    selected.push(middleSlots[i % middleSlots.length])
  }
  return [
    template.slots.find((item) => item.type === 'cover') || slot('cover', 'open the deck', '封面', '主题与副标题', '强封面', 'cover'),
    ...selected,
    template.slots.find((item) => item.type === 'end') || slot('end', 'close the deck', '结束页', '结论与下一步', '结束页', 'end'),
  ]
}

export function buildSlideBlueprint(template, requestedCount) {
  const safeTemplate = template || selectPresentationTemplate('')
  const count = clamp(Number(requestedCount) || safeTemplate.defaultSlideCount || 8, MIN_SLIDES, MAX_SLIDES)
  return expandSlots(safeTemplate, count).map((item, index) => ({
    ...item,
    page: index + 1,
  }))
}

function markdownTypeLine(type) {
  return `<!-- ${type} -->`
}

function formatBlueprintLine(slotItem, skillId) {
  const page = String(slotItem.page).padStart(2, '0')
  if (skillId === 'htmlppt') {
    return `- Page ${page}: <section class="slide ${slotItem.htmlClass}" data-slide="${slotItem.page}"> | intent: ${slotItem.intent} | title: ${slotItem.title} | content: ${slotItem.content} | visual: ${slotItem.visual}`
  }
  return `- Page ${page}: ${markdownTypeLine(slotItem.type)} | intent: ${slotItem.intent} | title: ${slotItem.title} | content: ${slotItem.content} | visual: ${slotItem.visual}`
}

export function buildPresentationPlannerPrompt(topic = '', { skillId = 'ppt' } = {}) {
  const template = selectPresentationTemplate(topic)
  const slideCount = inferRequestedSlideCount(topic) || template.defaultSlideCount
  const blueprint = buildSlideBlueprint(template, slideCount)
  const library = PRESENTATION_TEMPLATES.map((item) => `${item.id}=${item.label}`).join('; ')
  const syntaxRule = skillId === 'htmlppt'
    ? 'Use exactly one top-level section per planned page. Keep data-slide numbers continuous, render every page on a fixed 16:9 canvas, keep primary content inside an equal 6% horizontal / 8% vertical safe area, and expose window.__ymaDeck navigation.'
    : 'Use exactly one Markdown slide per planned page. The second line of every slide must be the planned <!-- type --> tag.'

  return `\n\n## Template library planner\n- Template library: ${library}\n- Selected template: ${template.id} (${template.label})\n- Visual theme: ${template.theme}\n- Strict slide count: ${blueprint.length}\n- Do not add, remove, merge, or reorder pages unless the user explicitly asks.\n- ${syntaxRule}\n- Every non-cover/end page must contain real argument depth: claim; evidence/mechanism/impact; metric or tradeoff.\n\n### Page-by-page blueprint\n${blueprint.map((item) => formatBlueprintLine(item, skillId)).join('\n')}\n\n### Content density rules\n- Write from the slot intent, not from a generic outline.\n- Each content card must include a causal mechanism, proof point, risk, or action implication.\n- If a factual metric is unknown, mark it as replaceable data instead of inventing a source.\n- Avoid decorative filler such as "future outlook" unless the slot asks for a roadmap or closing thesis.`
    + (skillId === 'htmlppt' ? `\n- Use at least 64px for the deck title, 48px for slide titles, 28px for subheads, and 22px for body copy on the 1920×1080 canvas.\n- Never duplicate visible text with pseudo-elements, text-shadow, filters, or stacked DOM copies; decorations may not overlap the primary copy.` : '')
}
