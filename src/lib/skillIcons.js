// 技能 id → Lucide 图标组件.新增技能时在这里加一条即可,
// ChatComposer / SkillsMarket 等消费方都从这里读,避免两份重复定义脱钩.

import { Presentation, Monitor, FileText, Table, Mail, Calculator } from 'lucide-react'

export const SKILL_ICONS = {
  ppt: Presentation,
  htmlppt: Monitor,
  doc: FileText,
  excel: Table,
  mail: Mail,
  finance: Calculator,
}
