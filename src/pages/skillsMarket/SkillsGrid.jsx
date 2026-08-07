import { Trash2 } from 'lucide-react'
import { getSkillIconPresentation } from '../../lib/skillIcons.js'

export default function SkillsGrid({ skills, onSelect, onDelete, t }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(238px,100%),1fr))] gap-4">
      {skills.map((skill) => {
        const { Icon, className: iconClassName } = getSkillIconPresentation(skill)
        const detailLabel = `${t('nav.skillDetails')}: ${skill.name}`
        return (
          <article
            key={skill.id}
            data-skill-id={skill.id}
            className="group relative min-h-[154px] overflow-hidden rounded-[18px] border border-ink/10 bg-paper px-5 py-4 shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition duration-200 hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-[0_12px_30px_rgb(0_0_0/0.07)] focus-within:border-ink/25 focus-within:shadow-[0_12px_30px_rgb(0_0_0/0.07)]"
          >
            <button
              type="button"
              onClick={() => onSelect(skill)}
              className="absolute inset-0 z-0 rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/50 focus-visible:ring-inset"
              aria-label={detailLabel}
              data-skill-open
            />
            <div className="pointer-events-none relative z-10 flex items-center gap-3">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${iconClassName}`} data-skill-icon>
                <Icon className="h-[22px] w-[22px]" strokeWidth={1.9} aria-hidden="true" />
              </div>
              <h2 className="min-w-0 truncate text-[15px] font-semibold leading-5 text-ink" title={skill.name}>{skill.name}</h2>
            </div>
            <p className="pointer-events-none relative z-10 mt-4 line-clamp-2 min-h-11 text-[13px] leading-[1.65] text-ink-soft" title={skill.desc}>{skill.desc}</p>
            {skill.localCustom && (
              <button
                type="button"
                onClick={(event) => onDelete(event, skill.id)}
                className="absolute bottom-2.5 right-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-ink-fade opacity-0 transition hover:bg-ink/[0.06] hover:text-ink group-hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/50"
                title={t('skillsMarket.deleteCustom')}
                aria-label={t('skillsMarket.deleteCustom')}
                data-skill-action="delete"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </article>
        )
      })}
      {skills.length === 0 && <div className="col-span-full py-16 text-center text-sm text-ink-fade">{t('skillsMarket.empty')}</div>}
    </div>
  )
}
