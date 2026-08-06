// 技能 id → Lucide 图标组件.新增技能时在这里加一条即可,
// ChatComposer / SkillsMarket 等消费方都从这里读,避免两份重复定义脱钩.
//
// 取图标请用 getSkillIcon(id) —— 它对未知/自定义 skill 会回退到 Wrench,
// 避免消费方还要写 SKILL_ICONS[id] || Fallback 的散逻辑.

import {
  Presentation,
  FileText,
  Table,
  Mail,
  Calculator,
  Globe,
  Code2,
  ClipboardCheck,
  Beaker,
  Languages,
  Search,
  ListChecks,
  Bug,
  Blocks,
  Brain,
  Network,
  PlugZap,
  ShieldCheck,
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

export function getSkillIcon(id) {
  if (SKILL_ICONS[id]) return SKILL_ICONS[id]
  const value = String(id || '')
  if (/debug|diagnos|troubleshoot/i.test(value)) return Bug
  if (/review|audit|quality/i.test(value)) return ClipboardCheck
  if (/test|verify|validation/i.test(value)) return Beaker
  if (/plan|task|execut/i.test(value)) return ListChecks
  if (/brainstorm|design|creative/i.test(value)) return Brain
  if (/plugin|extension/i.test(value)) return PlugZap
  if (/parallel|dispatch|agent/i.test(value)) return Network
  if (/connect|browser|web/i.test(value)) return Blocks
  if (/document|doc|write|report/i.test(value)) return FileText
  if (/sheet|excel|data|table|analysis/i.test(value)) return Table
  if (/slide|ppt|presentation/i.test(value)) return Presentation
  return SKILL_ICON_FALLBACK
}
