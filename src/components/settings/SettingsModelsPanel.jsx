import ModelProvidersPanel from '../ModelProvidersPanel.jsx'

function Info({ label, value }) {
  return (
    <div className="p-3 border border-ink-fade/30 rounded-md bg-paper">
      <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{label}</div>
      <div className="text-ink mt-1 break-all">{value}</div>
    </div>
  )
}

export default function SettingsModelsPanel({ diagnostics, onChanged, t }) {
  const model = diagnostics?.model
  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">MODEL PROVIDERS</span>
        <h1 className="font-hand text-[28px] text-ink mt-1.5">{t('modelProviders.navTitle')}</h1>
        <p className="text-sm text-ink-soft mt-1">{t('modelProviders.navSubtitle')}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Info label="当前默认模型" value={model?.modelName || '尚未配置'} />
        <Info label="Base URL" value={model?.baseUrlMasked || '尚未配置'} />
        <Info label="连接状态" value={model?.configured ? '配置可用' : '等待配置'} />
      </div>
      <ModelProvidersPanel onChanged={onChanged} />
    </section>
  )
}
