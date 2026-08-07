import { X } from 'lucide-react'
import { getSkillIcon } from '../../lib/skillIcons.js'

export default function SkillsGrid({ skills, onSelect, onDelete, t }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
      {skills.map((skill) => {
        const Icon = getSkillIcon(skill.id)
        return (
          <button
            type="button"
            key={skill.id}
            data-skill-id={skill.id}
            onClick={() => onSelect(skill)}
            className={`relative p-4 border rounded-md text-left flex flex-col gap-2.5 hover:shadow-md transition-shadow ${skill.custom ? 'border-ink/40 border-dashed bg-paper-2' : 'border-ink/30 hover:border-ink/60'}`}
          >
            {skill.localCustom && (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => onDelete(event, skill.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onDelete(event, skill.id) }}
                className="absolute top-2 right-2 w-5 h-5 rounded-full hover:bg-ink/10 flex items-center justify-center text-ink-fade hover:text-ink"
                title={t('skillsMarket.deleteCustom')}
              >
                <X className="w-3 h-3" />
              </span>
            )}
            <div className="flex items-start justify-between gap-2">
              <div className="w-9 h-9 rounded-lg border border-ink-fade/60 flex items-center justify-center bg-paper">
                <Icon className="w-5 h-5 text-ink-fade" />
              </div>
              {skill.compatibility && <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t(`skillsMarket.compatibility.${skill.compatibility}`)}</span>}
              {skill.custom && <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t(skill.imported ? 'skillsMarket.imported' : 'skillsMarket.custom')}</span>}
            </div>
            <div>
              <div className="font-hand text-[17px] leading-tight text-ink">{skill.name}</div>
              {(skill.pluginName || skill.originalName) && <div className="mt-1 truncate font-mono text-[9px] tracking-wide text-ink-fade">{[skill.pluginName, skill.originalName].filter(Boolean).join(' · ')}</div>}
              <div className="mt-1 text-sm leading-5 text-ink-soft">{skill.desc}</div>
            </div>
            <div className="flex flex-wrap gap-1 mt-auto">
              {(skill.perms || []).map((permission) => <span key={permission} className="font-mono text-[9px] tracking-wider text-ink-fade">· {permission}</span>)}
            </div>
          </button>
        )
      })}
      {skills.length === 0 && <div className="col-span-full text-center py-16 text-ink-fade text-sm">{t('skillsMarket.empty')}</div>}
    </div>
  )
}
