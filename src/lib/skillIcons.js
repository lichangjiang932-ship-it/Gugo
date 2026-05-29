// 技能 id → Lucide 图标组件.新增技能时在这里加一条即可,
// ChatComposer / SkillsMarket 等消费方都从这里读,避免两份重复定义脱钩.
//
// 取图标请用 getSkillIcon(id) —— 它对未知/自定义 skill 会回退到 Wrench,
// 避免消费方还要写 SKILL_ICONS[id] || Fallback 的散逻辑.

import {
  Presentation,
  Monitor,
  FileText,
  Table,
  Mail,
  Calculator,
  Globe,
  PieChart,
  Code2,
  ClipboardCheck,
  Beaker,
  Languages,
  Search,
  ListChecks,
  Wrench,
} from 'lucide-react'

export const SKILL_ICONS = {
  ppt: Presentation,
  htmlppt: Monitor,
  webpage: Globe,
  axippt: PieChart,
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
}

export const SKILL_ICON_FALLBACK = Wrench

export function getSkillIcon(id) {
  return SKILL_ICONS[id] || SKILL_ICON_FALLBACK
}
