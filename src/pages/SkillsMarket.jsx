import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  Wrench, Shield, FileText, Database, Presentation, Image,
  FileCode, Pencil, Terminal, Code2, BarChart3, Search,
  GitBranch, Brain, Sparkles, ArrowRight, Zap, Lock, Eye,
  ShieldCheck, ShieldAlert, Filter, RefreshCw, Globe
} from 'lucide-react'
import ThemeWrapper from '../components/ThemeWrapper.jsx'
import { useAppContext } from '../store/AppContext.jsx'
import { SKILLS } from '../data.js'

const SKILL_ICONS = {
  PPT: Presentation, 'HTML PPT': Image, Excel: Database, Word: FileText,
  React: FileCode, '代码编辑': Pencil, '代码执行': Terminal, '本地代码库': Code2,
  '内容生成': FileText, '数据可视化': BarChart3, '网页搜索': Search, '抓取链接': Globe,
  '文件读取': FileText, '文件写入': Pencil, '代码提交': GitBranch,
  '数据分析': BarChart3, '代码审查': Code2, '研究': Search,
}

function SkillIcon({ name }) {
  const Icon = SKILL_ICONS[name] || Wrench
  return <Icon className="w-4 h-4" />
}

function PermissionChip({ level }) {
  const configs = {
    allow: { label: '允许', color: '#5B8B6B', icon: ShieldCheck },
    ask: { label: '询问', color: '#8B7B55', icon: Eye },
    deny: { label: '拒绝', color: '#A55B5B', icon: ShieldAlert },
  }
  const cfg = configs[level] || configs.ask
  return (
    <span
      className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[10px] font-medium"
      style={{ background: `${cfg.color}12`, color: cfg.color, border: `1px solid ${cfg.color}20` }}
    >
      <cfg.icon className="w-3 h-3" />
      {cfg.label}
    </span>
  )
}

function SkillCard({ skill, activeSkill, onToggle, index }) {
  const isActive = activeSkill === skill.id
  const userLevel = skill.userLevel || 'ask'
  const iconColor = skill.color || '#8A7B68'

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onClick={onToggle}
      className={`group cursor-pointer rounded-2xl border p-5 transition-all duration-300 ${
        isActive
          ? 'border-ember/40 bg-ember-soft/20 shadow-lg shadow-ember/5'
          : 'border-ink/10 bg-paper-2/30 hover:border-ink-fade/30 hover:shadow-md hover:bg-paper-2/50'
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-105"
          style={{ background: `${iconColor}12`, border: `1px solid ${iconColor}25` }}
        >
          <SkillIcon name={skill.name} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-ink leading-tight">{skill.name}</h3>
          <p className="text-[11px] text-ink-fade mt-1 leading-relaxed">{skill.desc}</p>
        </div>
        {isActive && (
          <div className="w-5 h-5 rounded-full bg-ember flex items-center justify-center shrink-0">
            <Sparkles className="w-3 h-3 text-paper" />
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {skill.tags?.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-paper/60 border border-ink-fade/15 text-[10px] text-ink-fade"
          >
            <SkillIcon name={tag} />
            {tag}
          </span>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-ink-fade/10">
        <PermissionChip level={userLevel} />
        <span className="text-[10px] text-ink-fade/60 font-mono tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
          {isActive ? '已激活' : '点击切换'}
        </span>
      </div>
    </motion.div>
  )
}

export default function SkillsMarket() {
  const { state } = useAppContext()
  const [filterTag, setFilterTag] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  const allTags = useMemo(() => {
    const tags = new Set()
    SKILLS.forEach((s) => s.tags?.forEach((t) => tags.add(t)))
    return Array.from(tags)
  }, [])

  const filteredSkills = useMemo(() => {
    let skills = SKILLS
    if (filterTag) skills = skills.filter((s) => s.tags?.includes(filterTag))
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      skills = skills.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.desc.toLowerCase().includes(q) ||
        s.tags?.some((t) => t.toLowerCase().includes(q))
      )
    }
    return skills
  }, [filterTag, searchQuery])

  const stats = useMemo(() => {
    const total = SKILLS.length
    const active = SKILLS.filter((s) => s.userLevel === 'allow').length
    const ask = SKILLS.filter((s) => s.userLevel === 'ask').length
    const deny = SKILLS.filter((s) => s.userLevel === 'deny').length
    return { total, active, ask, deny }
  }, [])

  return (
    <ThemeWrapper headerName="技能库" headerPath="/skills">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-[900px] mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-8"
          >
            <span className="section-label">SKILLS MARKETPLACE</span>
            <h1 className="font-hand text-3xl text-ink mt-1">技能与工具</h1>
            <p className="text-sm text-ink-fade mt-2">管理你的 AI 技能库，控制每项技能的行为策略</p>
          </motion.div>

          {/* Stats Bar */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="grid grid-cols-4 gap-3 mb-8"
          >
            {[
              { label: '总技能', value: stats.total, color: '#8A7B68' },
              { label: '已允许', value: stats.active, color: '#5B8B6B' },
              { label: '询问中', value: stats.ask, color: '#8B7B55' },
              { label: '已拒绝', value: stats.deny, color: '#A55B5B' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="p-4 rounded-xl border border-ink-fade/15 bg-paper-2/30"
              >
                <div className="text-[11px] text-ink-fade font-medium">{stat.label}</div>
                <div
                  className="font-display text-2xl mt-1"
                  style={{ color: stat.color }}
                >
                  {stat.value}
                </div>
              </div>
            ))}
          </motion.div>

          {/* Search & Filter */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="flex items-center gap-3 mb-6"
          >
            <div className="flex-1 relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-fade pointer-events-none" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索技能…"
                className="w-full h-10 pl-10 pr-4 border border-ink-fade/20 rounded-xl bg-paper/60 text-sm text-ink outline-none focus:border-ember/50 focus:ring-2 focus:ring-ember/10 transition-all placeholder:text-ink-fade/50"
              />
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => setFilterTag(null)}
                className={`h-9 px-3 rounded-lg text-[11px] font-medium transition-all border ${
                  !filterTag
                    ? 'bg-ink text-paper border-ink'
                    : 'border-ink-fade/20 text-ink-soft hover:bg-paper-2/40'
                }`}
              >
                全部
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(tag === filterTag ? null : tag)}
                  className={`h-9 px-3 rounded-lg text-[11px] font-medium transition-all border ${
                    filterTag === tag
                      ? 'bg-ink text-paper border-ink'
                      : 'border-ink-fade/20 text-ink-soft hover:bg-paper-2/40'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </motion.div>

          {/* Skill Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSkills.map((skill, i) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                activeSkill={filterTag}
                index={i}
                onToggle={() => setFilterTag(filterTag === skill.id ? null : skill.id)}
              />
            ))}
          </div>

          {filteredSkills.length === 0 && (
            <div className="py-16 text-center">
              <Wrench className="w-10 h-10 text-ink-fade/30 mx-auto mb-3" />
              <p className="text-sm text-ink-fade">没有找到匹配的技能</p>
              <p className="text-[11px] text-ink-fade/60 mt-1">尝试调整搜索条件</p>
            </div>
          )}
        </div>
      </div>
    </ThemeWrapper>
  )
}
