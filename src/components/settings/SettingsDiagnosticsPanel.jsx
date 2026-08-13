import { RefreshCw, Server } from 'lucide-react'

function StatusPill({ ok, label }) {
  const tone = ok === true
    ? 'border-emerald-500/40 text-emerald-700 bg-emerald-50'
    : ok === false
      ? 'border-ember-line text-ember bg-ember-soft'
      : 'border-ink-fade/50 text-ink-soft bg-paper-2'
  return <span className={`inline-flex items-center h-7 px-2.5 rounded-full border text-xs ${tone}`}>{label}</span>
}

function Info({ label, value }) {
  return (
    <div className="p-3 border border-ink-fade/30 rounded-md bg-paper">
      <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{label}</div>
      <div className="text-ink mt-1 break-all">{value}</div>
    </div>
  )
}

function Group({ title, children }) {
  return (
    <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3">
      <h3 className="font-semibold text-lg text-ink">{title}</h3>
      {children}
    </div>
  )
}

export default function SettingsDiagnosticsPanel({
  authMode = 'multi_user',
  diagnostics,
  message,
  loading,
  onConfigureModels,
  onRefresh,
  onTest,
  t,
}) {
  const model = diagnostics?.model
  const endpoint = diagnostics?.endpoint
  const mail = diagnostics?.mail
  const localModelNeedsConfiguration = authMode === 'local'
    && diagnostics
    && model?.configured === false

  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">SYSTEM DIAGNOSTICS</span>
          <h1 className="font-semibold text-[28px] text-ink mt-1.5">系统诊断</h1>
          <p className="text-sm text-ink-soft mt-1">
            {authMode === 'local'
              ? t('settings.localAuthDescription')
              : '读取后端配置的安全状态；API Key 和邮箱授权码不会返回浏览器。'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onRefresh()} disabled={loading} className="h-9 px-3 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" />刷新
          </button>
          <button onClick={() => onRefresh({ check: true })} disabled={loading} className="h-9 px-3 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors flex items-center gap-1.5 disabled:opacity-50">
            <Server className="w-3.5 h-3.5" />探测端点
          </button>
        </div>
      </div>

      {localModelNeedsConfiguration ? (
        <div className="p-4 border border-ember-line rounded-md bg-ember-soft flex flex-col items-start gap-3">
          <p className="text-sm text-ember">{t('settings.localAuthHint')}</p>
          <button type="button" onClick={onConfigureModels} className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors">
            {t('modelProviders.manage')}
          </button>
        </div>
      ) : null}

      <Group title="模型服务">
        <div className="flex flex-wrap gap-2">
          <StatusPill ok={model?.configured} label={model?.configured ? '已配置' : '未配置'} />
          <StatusPill ok={model?.apiKeyConfigured ? true : null} label={model?.apiKeyConfigured ? 'API Key 已配置' : 'API Key 未设置（本地模型可用）'} />
          <StatusPill ok={endpoint?.checked ? endpoint.ok : null} label={endpoint?.checked ? (endpoint.ok ? '端点可达' : '端点异常') : '未探测端点'} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Info label="Base URL" value={model?.baseUrlMasked || '未配置'} />
          <Info label="默认模型" value={model?.modelName || '未配置'} />
          <Info label="Temperature" value={String(model?.temperature ?? '未配置')} />
          <Info label="Max Tokens" value={String(model?.maxTokens ?? '未配置')} />
        </div>
        {model?.missing?.length ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">尚未完成模型配置。请前往“模型”页面选择服务并保存 API Key。</div> : null}
        <button onClick={onTest} disabled={loading || !model?.configured} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 self-start">测试后端模型</button>
        {endpoint?.checked && !endpoint.ok ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">{endpoint.error || endpoint.reason}</div> : null}
        {endpoint?.remoteModels?.length ? <div className="flex flex-wrap gap-1.5">{endpoint.remoteModels.map((name) => <span key={name} className="px-2 py-1 rounded border border-ink-fade/40 text-xs text-ink-soft bg-paper">{name}</span>)}</div> : null}
      </Group>

      <Group title="可用模型">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {(model?.models || []).map((item) => <div key={item.name} className="p-3 border border-ink-fade/30 rounded-md"><span className="text-sm text-ink">{item.name}</span></div>)}
        </div>
      </Group>

      {authMode !== 'local' ? (
        <Group title="邮箱登录">
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={mail?.configured} label={mail?.configured ? 'SMTP 已配置' : 'SMTP 未完整配置'} />
            <StatusPill ok={!mail?.devCodes} label={mail?.devCodes ? '会显示开发验证码' : '真实邮箱验证码'} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Info label="SMTP Server" value={mail?.server || '未配置'} />
            <Info label="SMTP Port" value={String(mail?.port ?? '未配置')} />
            <Info label="TLS/SSL" value={`TLS ${mail?.useTls ? '开' : '关'} / SSL ${mail?.useSsl ? '开' : '关'}`} />
            <Info label="Sender" value={mail?.sender || '未配置'} />
          </div>
          {mail?.missing?.length ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">缺少邮箱变量：{mail.missing.join(', ')}</div> : null}
        </Group>
      ) : null}
      {message && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{message}</div>}
    </section>
  )
}
