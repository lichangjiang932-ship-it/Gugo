// 技能图标的单一来源。内置技能走显式映射，插件与自定义技能按完整元数据
// 做稳定的语义匹配；未命中时才回退到通用工具图标。
import {
  BarChart3,
  Beaker,
  Blocks,
  BookOpenText,
  Brain,
  Bug,
  Calculator,
  CalendarDays,
  ClipboardCheck,
  Code2,
  Database,
  FileText,
  Globe,
  Image,
  Languages,
  ListChecks,
  Mail,
  MessageSquare,
  Music2,
  Network,
  Palette,
  PlugZap,
  Presentation,
  Search,
  ShieldCheck,
  Table,
  Video,
  Wrench,
} from 'lucide-react'

export const SKILL_ICONS = {
  ppt: Presentation,
  webpage: Globe,
  doc: FileText,
  excel: Table,
  mail: Mail,
  finance: Calculator,
  code: Code2,
  review: ClipboardCheck,
  test: Beaker,
  translate: Languages,
  research: Search,
  plan: ListChecks,
  brainstorming: Brain,
  'code-review': ClipboardCheck,
  'codex-superpowers-debugging': Bug,
  'dispatching-parallel-agents': Network,
  'evaluate-plugin': PlugZap,
  'evaluate-skill': ShieldCheck,
  'executing-plans': ListChecks,
  'connector-operator': Blocks,
}

export const SKILL_ICON_FALLBACK = Wrench

const SEMANTIC_ICON_RULES = [
  { key: 'presentation', match: /\b(pptx?|powerpoint|presentations?|slides?|deck)\b/i, icon: Presentation, tone: 'violet' },
  { key: 'spreadsheet', match: /\b(excel|xlsx|spreadsheet|sheets?|table|csv)\b/i, icon: Table, tone: 'emerald' },
  { key: 'document', match: /\b(document|docs?|word|writer|writing|report|markdown|pdf|book)\b/i, icon: FileText, tone: 'blue' },
  { key: 'mail', match: /\b(mail|email|smtp|imap|gmail|outlook)\b/i, icon: Mail, tone: 'rose' },
  { key: 'calendar', match: /\b(calendar|schedule|event|meeting)\b/i, icon: CalendarDays, tone: 'amber' },
  { key: 'message', match: /\b(slack|discord|message|chat|communication)\b/i, icon: MessageSquare, tone: 'cyan' },
  { key: 'finance', match: /\b(finance|financial|accounting|stock|market|fund|invoice|budget)\b/i, icon: Calculator, tone: 'amber' },
  { key: 'database', match: /\b(database|postgres|sql|supabase|storage)\b/i, icon: Database, tone: 'emerald' },
  { key: 'analytics', match: /\b(analysis|analytics|metric|chart|dashboard|data)\b/i, icon: BarChart3, tone: 'cyan' },
  { key: 'debug', match: /\b(debug|diagnos|troubleshoot|fix)\w*\b/i, icon: Bug, tone: 'rose' },
  { key: 'review', match: /\b(review|audit|quality|evaluate|verification)\w*\b/i, icon: ClipboardCheck, tone: 'indigo' },
  { key: 'test', match: /\b(test|validation|playtest)\w*\b/i, icon: Beaker, tone: 'emerald' },
  { key: 'code', match: /\b(code|coding|developer|development|frontend|backend|react|typescript|javascript|git)\b/i, icon: Code2, tone: 'indigo' },
  { key: 'web', match: /\b(browser|web|website|html|access)\b/i, icon: Globe, tone: 'blue' },
  { key: 'translation', match: /\b(translate|translation|language|localization|i18n)\b/i, icon: Languages, tone: 'cyan' },
  { key: 'research', match: /\b(search|research|discover|knowledge)\b/i, icon: Search, tone: 'blue' },
  { key: 'planning', match: /\b(plan|planning|task|execute|workflow|productivity)\w*\b/i, icon: ListChecks, tone: 'violet' },
  { key: 'creative', match: /\b(brainstorm|design|creative|idea|brand)\w*\b/i, icon: Palette, tone: 'rose' },
  { key: 'image', match: /\b(image|photo|ocr|vision|sprite|graphic)\b/i, icon: Image, tone: 'rose' },
  { key: 'video', match: /\b(video|remotion|film|movie)\b/i, icon: Video, tone: 'violet' },
  { key: 'audio', match: /\b(audio|music|speech|voice|sound)\b/i, icon: Music2, tone: 'amber' },
  { key: 'knowledge', match: /\b(guide|handbook|learning|education|tutorial)\b/i, icon: BookOpenText, tone: 'blue' },
  { key: 'plugin', match: /\b(plugin|extension|bundle)\b/i, icon: PlugZap, tone: 'amber' },
  { key: 'agent', match: /\b(parallel|dispatch|agent|subagent|team)\b/i, icon: Network, tone: 'violet' },
  { key: 'connector', match: /\b(connect|connector|integration|mcp)\b/i, icon: Blocks, tone: 'cyan' },
  { key: 'security', match: /\b(security|shield|privacy|permission|risk)\b/i, icon: ShieldCheck, tone: 'emerald' },
]

const ICON_TONE_CLASSES = Object.freeze({
  amber: 'bg-amber-500/10 text-amber-600 ring-amber-500/15',
  blue: 'bg-blue-500/10 text-blue-600 ring-blue-500/15',
  cyan: 'bg-cyan-500/10 text-cyan-600 ring-cyan-500/15',
  emerald: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/15',
  indigo: 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/15',
  rose: 'bg-rose-500/10 text-rose-600 ring-rose-500/15',
  violet: 'bg-violet-500/10 text-violet-600 ring-violet-500/15',
  neutral: 'bg-ink/[0.06] text-ink-soft ring-ink/10',
})

function skillSearchText(skillOrId) {
  if (typeof skillOrId === 'string') return skillOrId
  if (!skillOrId || typeof skillOrId !== 'object') return ''
  return [
    skillOrId.id,
    skillOrId.name,
    skillOrId.originalName,
    skillOrId.desc,
    skillOrId.description,
    skillOrId.categoryKey,
    skillOrId.capabilityKey,
    ...(Array.isArray(skillOrId.perms) ? skillOrId.perms : []),
  ].filter(Boolean).join(' ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
}

function findSemanticIcon(skillOrId) {
  const id = typeof skillOrId === 'string' ? skillOrId : skillOrId?.id
  if (id && SKILL_ICONS[id]) return { icon: SKILL_ICONS[id], tone: semanticToneForId(id) }
  const text = skillSearchText(skillOrId)
  return SEMANTIC_ICON_RULES.find((rule) => rule.match.test(text)) || null
}

function semanticToneForId(id) {
  return ({
    ppt: 'violet', webpage: 'blue', doc: 'blue', excel: 'emerald', mail: 'rose', finance: 'amber',
    code: 'indigo', review: 'indigo', test: 'emerald', translate: 'cyan', research: 'blue', plan: 'violet',
  })[id] || 'neutral'
}

export function getSkillIcon(skillOrId) {
  return findSemanticIcon(skillOrId)?.icon || SKILL_ICON_FALLBACK
}

export function getSkillIconPresentation(skillOrId) {
  const match = findSemanticIcon(skillOrId)
  const tone = match?.tone || 'neutral'
  return {
    Icon: match?.icon || SKILL_ICON_FALLBACK,
    tone,
    className: ICON_TONE_CLASSES[tone] || ICON_TONE_CLASSES.neutral,
  }
}
