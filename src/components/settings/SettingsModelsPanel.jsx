import ModelProvidersPanel from '../ModelProvidersPanel.jsx'

/**
 * 模型设置页 —— 简洁优先：
 * 去掉手写体标题 / 装饰框 / 入场动画，改成一行紧凑状态条 + Provider 列表。
 * 用户要填模型时看这里就知道「当前用什么、配了几个」，细节全在列表和编辑器里。
 */
export default function SettingsModelsPanel({ diagnostics, onChanged, t }) {
  const model = diagnostics?.model
  const configured = Boolean(model?.configured)
  return (
    <section className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold text-ink">{t('modelProviders.navTitle')}</h1>
        <p className="mt-1 text-sm text-ink-soft">{t('modelProviders.navSubtitle')}</p>
      </header>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${configured ? 'bg-emerald-500' : 'bg-ink-fade'}`} aria-hidden="true" />
          <span className="text-ink-fade">{t('modelProviders.currentModel')}</span>
          <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-xs text-ink">{model?.modelName || t('modelProviders.notConfigured')}</code>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-ink-fade">{t('modelProviders.baseUrlLabel')}</span>
          <code className="max-w-[280px] truncate rounded bg-paper-2 px-1.5 py-0.5 font-mono text-xs text-ink">{model?.baseUrlMasked || t('modelProviders.notConfigured')}</code>
        </span>
        <span className={`text-xs ${configured ? 'text-emerald-700' : 'text-ink-fade'}`}>{t(configured ? 'modelProviders.statusConfigured' : 'modelProviders.statusWaiting')}</span>
      </div>
      <ModelProvidersPanel onChanged={onChanged} />
    </section>
  )
}
