import { Package, Plus, Sparkles, Upload } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useActiveAgent } from '../agents/activeAgentContext.js'
import { useT } from '../i18n/I18nProvider.jsx'
import AgentEditorModal from './agents/AgentEditorModal.jsx'
import AgentRows from './agents/AgentRows.jsx'
import AgentTemplateModal from './agents/AgentTemplateModal.jsx'
import useAgentListController from './agents/useAgentListController.js'

export default function AgentList() {
  const { t, lang } = useT()
  const { refresh: refreshActiveAgent } = useActiveAgent()
  const controller = useAgentListController({ lang, refreshActiveAgent, t })

  return (
    <div className="flex h-screen bg-canvas">
      <LeftRail />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <header className="mb-8 flex items-end justify-between border-b border-ink/10 pb-6">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{t('agents.title')}</h1>
              <p className="mt-1 text-sm text-ink-fade">{t('agents.subtitle')}</p>
            </div>
            <HeaderButton onClick={controller.openTemplates} icon={<Sparkles size={14} />} label={t('agents.fromTemplate')} />
            <HeaderButton onClick={controller.importZip} icon={<Package size={14} />} label={t('agents.importZip')} />
            <HeaderButton onClick={controller.importMarkdown} icon={<Upload size={14} />} label={t('agents.import')} />
            <button onClick={controller.openNew} className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm text-canvas hover:opacity-90"><Plus size={16} />{t('agents.newAgent')}</button>
          </header>
          {controller.err && <div className="mb-4 rounded border border-red-400/30 bg-red-50/40 px-4 py-3 text-sm text-red-700">{controller.err}</div>}
          <AgentRows
            agents={controller.agents}
            loading={controller.loading}
            onDelete={controller.remove}
            onEdit={controller.openEdit}
            onExport={controller.exportAgent}
            onExportZip={controller.exportZip}
            t={t}
          />
          {controller.editing && (
            <AgentEditorModal
              agent={controller.editing}
              onApplyPersona={controller.applyPersona}
              onChange={controller.setEditing}
              onClose={() => controller.setEditing(null)}
              onPersonaSelect={controller.selectPersona}
              onSave={controller.save}
              personaDraftId={controller.personaDraftId}
              personaLoading={controller.personaLoading}
              personaPreview={controller.personaPreview}
              personaTemplates={controller.personaTemplates}
              saving={controller.saving}
              t={t}
            />
          )}
          {controller.showTemplates && (
            <AgentTemplateModal
              loading={controller.previewLoading}
              onClose={() => controller.setShowTemplates(false)}
              onPreview={controller.openPreview}
              onUse={controller.useTemplate}
              preview={controller.previewTpl}
              source={controller.previewSource}
              templates={controller.templates}
              t={t}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function HeaderButton({ icon, label, onClick }) {
  return <button onClick={onClick} className="inline-flex items-center gap-2 rounded-md border border-ink/15 px-3 py-2 text-sm hover:bg-ink/5">{icon}{label}</button>
}
