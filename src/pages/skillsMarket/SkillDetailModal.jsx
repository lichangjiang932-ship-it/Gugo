import { createElement } from 'react'
import { X } from 'lucide-react'
import { getSkillIconPresentation } from '../../lib/skillIcons.js'
import { describeSkillRequirements } from '../../lib/skillPresentation.js'

export default function SkillDetailModal({ skill, copy, lang, onClose, onUse, t }) {
  if (!skill) return null
  const { Icon, className: iconClassName } = getSkillIconPresentation(skill)
  const icon = createElement(Icon, { className: 'h-6 w-6', strokeWidth: 1.9, 'aria-hidden': true })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="skill-detail-title" className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-ink/30 bg-paper shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-ink/10 px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${iconClassName}`}>{icon}</div>
            <div className="min-w-0">
              <h2 id="skill-detail-title" className="truncate text-lg font-semibold text-ink">{skill.name}</h2>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-fade hover:bg-paper-2 hover:text-ink" aria-label={t('nav.skillDetails')}><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <section><h3 className="mb-2 text-xs font-medium text-ink">{copy.overview}</h3><p className="leading-6 text-ink-soft">{skill.desc}</p></section>
          <section>
            <h3 className="mb-2 text-xs font-medium text-ink">{copy.usage}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-md border border-ink/15 bg-paper-2 p-3 text-xs">
              <dt className="text-ink-fade">{copy.command}</dt><dd className="min-w-0 break-all font-mono text-ink-soft">/{skill.id} {copy.promptPlaceholder}</dd>
              {skill.originalName && <><dt className="text-ink-fade">{copy.originalName}</dt><dd className="min-w-0 break-words font-mono text-ink-soft">{skill.originalName}</dd></>}
              <dt className="text-ink-fade">{copy.requirements}</dt><dd className="min-w-0 space-y-1 text-ink-soft">{describeSkillRequirements(skill, lang).map((requirement) => <div key={requirement}>{requirement}</div>)}</dd>
            </dl>
          </section>
          {skill.runnable === false && <div className="rounded-md border border-ember-line bg-ember-soft/30 p-3 text-xs leading-5 text-ember">{t('skillsMarket.incompatibleHint')}</div>}
          {skill.codexPlugin && <PluginSource skill={skill} t={t} />}
          {(skill.perms || []).length > 0 && <section><h3 className="mb-2 text-xs font-medium text-ink">{t('nav.permissions')}</h3><div className="flex flex-wrap gap-1.5">{skill.perms.map((permission) => <span key={permission} className="rounded-full border border-ink-fade/40 px-2 py-1 text-[11px] text-ink-soft">{permission}</span>)}</div></section>}
          {skill.systemPrompt && <section><h3 className="mb-2 text-xs font-medium text-ink">{t('nav.skillInstructions')}</h3><div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink/15 bg-paper-2 p-3 text-xs leading-5 text-ink-soft">{skill.systemPrompt}</div></section>}
        </div>
        <div className="flex justify-end border-t border-ink/15 px-5 py-4"><button type="button" onClick={onUse} disabled={skill.runnable === false} className="h-9 rounded-md bg-ink px-4 text-sm text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40">{skill.runnable === false ? t('skillsMarket.unavailable') : t('nav.useSkill')}</button></div>
      </div>
    </div>
  )
}

function PluginSource({ skill, t }) {
  const rows = [
    [t('skillsMarket.plugin'), skill.pluginName || skill.pluginId],
    skill.publisher && [t('skillsMarket.publisher'), skill.publisher],
    skill.license && [t('skillsMarket.license'), skill.license],
    skill.source?.rootName && [t('skillsMarket.localSource'), skill.source.rootName],
  ].filter(Boolean)
  return <section><h3 className="mb-2 text-xs font-medium text-ink">{t('skillsMarket.pluginSource')}</h3><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md border border-ink/15 bg-paper-2 p-3 text-xs">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-ink-fade">{label}</dt><dd className="min-w-0 break-words text-ink-soft">{value}</dd></div>)}{skill.repository && <><dt className="text-ink-fade">GitHub</dt><dd className="min-w-0 break-all"><a href={skill.repository} target="_blank" rel="noreferrer" className="text-ember underline">{skill.repository}</a></dd></>}</dl></section>
}
