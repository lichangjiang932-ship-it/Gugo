import { useState } from 'react'
import { ExternalLink, Globe2 } from 'lucide-react'

function BrowserDocument({ url, t }) {
  const [failed, setFailed] = useState(false)
  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b border-ink/10 bg-paper-2 px-3 py-2 text-xs text-ink-fade">
        <p className="min-w-0 flex-1 leading-5" role={failed ? 'alert' : undefined}>
          {t(failed ? 'workbench.browserFailed' : 'workbench.browserEmbeddingHint')}
        </p>
        <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
          className="inline-flex shrink-0 items-center gap-1 py-0.5 text-ink-soft underline underline-offset-4">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t('workbench.openBrowser')}
        </a>
      </div>
      <iframe title={t('workbench.browser')} src={url} sandbox="allow-scripts allow-forms allow-popups"
        onErrorCapture={() => setFailed(true)} referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" />
    </>
  )
}

export default function WorkbenchBrowser({ browserError, browserInput, browserUrl, navigateBrowser, setBrowserInput, t }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={navigateBrowser} className="border-b border-ink/10 p-2">
        <div className="flex gap-2">
          <input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)}
            aria-label={t('workbench.browserUrl')} className="h-9 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-3 text-xs outline-none focus:border-focus" />
          <button className="h-9 rounded-control bg-ink px-3 text-xs text-paper">{t('workbench.go')}</button>
        </div>
        {browserError && <p role="alert" className="mt-1.5 px-1 text-xs text-danger">{browserError}</p>}
      </form>
      {browserUrl ? <BrowserDocument key={browserUrl} url={browserUrl} t={t} /> : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-fade">
          <Globe2 className="h-9 w-9 opacity-35" /><span className="text-sm">{t('workbench.browserHint')}</span>
        </div>
      )}
    </section>
  )
}
