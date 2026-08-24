import { useMemo } from 'react'
import { useNavigate } from '../lib/router.jsx'
import AppLayout from '../components/AppLayout.jsx'
import { useAppContext } from '../store/AppContext'
import { useToast } from '../components/Toast.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { getSkillDetailCopy } from '../lib/skillPresentation.js'
import SkillsToolbar from './skillsMarket/SkillsToolbar.jsx'
import SkillsGrid from './skillsMarket/SkillsGrid.jsx'
import SkillDetailModal from './skillsMarket/SkillDetailModal.jsx'
import CustomSkillModal from './skillsMarket/CustomSkillModal.jsx'
import ImportSkillModal from './skillsMarket/ImportSkillModal.jsx'
import GithubSkillModal from './skillsMarket/GithubSkillModal.jsx'
import PluginSkillModal from './skillsMarket/PluginSkillModal.jsx'
import { useSkillsMarket } from './skillsMarket/useSkillsMarket.js'

export default function SkillsMarket() {
  const navigate = useNavigate()
  const { dispatch } = useAppContext()
  const toast = useToast()
  const { t, lang } = useT()
  const detailCopy = useMemo(() => getSkillDetailCopy(lang), [lang])
  const market = useSkillsMarket({
    lang,
    t,
    toast,
    onUseSkill: (skill) => {
      dispatch({ type: 'SET_DRAFT_INPUT', payload: `/${skill.id} ` })
      market.setSelectedSkill(null)
      navigate('/chat')
    },
  })

  return (
    <AppLayout className="h-screen flex bg-paper overflow-hidden">
      <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto w-full max-w-[1480px]">
          <SkillsToolbar
          query={market.query}
          setQuery={market.setQuery}
          activeFilter={market.activeFilter}
          setActiveFilter={market.setActiveFilter}
          filterDefs={market.filterDefs}
          searchRef={market.searchRef}
          folderInputRef={market.folderInputRef}
          selectFolder={market.selectFolder}
          openPlugins={market.openPlugins}
          openGithub={market.openGithub}
          openCustomModal={market.openCustomModal}
          t={t}
          />
          {market.catalogFallback && <div role="status" className="mb-5 rounded-xl border border-warning/70 bg-warning/70 px-4 py-3 text-sm text-warning" data-testid="skills-catalog-fallback">{t('skillsMarket.builtInFallback')}</div>}
          <SkillsGrid skills={market.filteredSkills} onSelect={market.setSelectedSkill} onDelete={market.deleteCustomSkill} t={t} />
        </div>
      </main>
      <SkillDetailModal skill={market.selectedSkill} copy={detailCopy} lang={lang} onClose={() => market.setSelectedSkill(null)} onUse={market.useSelectedSkill} t={t} />
      <CustomSkillModal market={market} t={t} />
      <ImportSkillModal market={market} t={t} />
      <GithubSkillModal market={market} t={t} />
      <PluginSkillModal market={market} t={t} />
    </AppLayout>
  )
}
