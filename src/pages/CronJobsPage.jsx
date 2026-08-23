import { CalendarClock, Plus, RefreshCw } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import CronJobEditor from './cron/CronJobEditor.jsx'
import CronJobTable from './cron/CronJobTable.jsx'
import useCronJobsController from './cron/useCronJobsController.js'
import { useNavigate } from '../lib/router.jsx'

export default function CronJobsPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const controller = useCronJobsController(t)
  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink">
      <LeftRail />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
          <header className="flex items-center justify-between gap-4">
            <div className="min-w-0"><div className="flex items-center gap-2"><CalendarClock className="h-5 w-5 text-accent-ink" /><h1 className="font-display text-2xl text-ink">{t('cron.title')}</h1><span className="inline-flex h-6 items-center rounded-md border border-ink-fade/40 bg-paper-2 px-2 text-xs text-ink-soft">{t('cron.activeBadge', { count: controller.activeCount })}</span></div><p className="mt-1 text-sm text-ink-fade">{t('cron.subtitle')}</p></div>
            <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={controller.reload} className="inline-flex h-9 items-center gap-2 rounded-md border border-ink-fade/40 px-3 text-sm text-ink-soft hover:bg-paper-2"><RefreshCw className="h-4 w-4" />{t('settings.refresh')}</button><button type="button" onClick={controller.openCreate} className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm text-accent-contrast hover:bg-accent/90"><Plus className="h-4 w-4" />{t('cron.new')}</button></div>
          </header>
          {controller.err && <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert"><span>{controller.err}</span>{['configure_model', 'test_provider', 'choose_agent_provider'].includes(controller.errAction) && <button type="button" onClick={() => navigate('/settings?tab=models')} className="shrink-0 font-medium underline underline-offset-2">{t('modelProviders.manage')}</button>}</div>}
          <CronJobTable controller={controller} t={t} />
        </div>
      </main>
      {controller.showCreate && <CronJobEditor controller={controller} t={t} />}
    </div>
  )
}
