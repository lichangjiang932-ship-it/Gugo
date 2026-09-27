import { useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  Loader2,
  RotateCw,
  X,
} from 'lucide-react'
import { isDesktopBrowserAvailable } from '../lib/desktopBrowserClient.js'
import useEmbeddedBrowser from './useEmbeddedBrowser.js'

const ERROR_KEYS = Object.freeze({
  invalid: 'workbench.browserInvalid',
  local: 'workbench.browserLocalFile',
})

function controlClass(enabled) {
  return `flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
    enabled ? 'text-ink-soft hover:bg-ink/5 hover:text-ink' : 'text-ink-fade/40'
  }`
}

/**
 * The workbench's embedded browser.
 *
 * Two backends behind one address bar: a real Chromium view in the desktop app,
 * an iframe elsewhere. The difference is stated in the header rather than hidden,
 * because an iframe that a site refuses to be embedded in renders blank with no
 * error of any kind — which looks like a broken product instead of a refusal.
 */
export default function EmbeddedBrowser({ active = true, t }) {
  const containerRef = useRef(null)
  const browser = useEmbeddedBrowser({ containerRef, active })
  const hosted = isDesktopBrowserAvailable()
  // A refused embed fires an error on the frame. Without this the panel would keep
  // showing a white rectangle and the reader would have no way to tell a refusal
  // from a slow load.
  const [failedUrl, setFailedUrl] = useState('')
  const frameFailed = Boolean(browser.url) && failedUrl === browser.url

  return (
    <section data-testid="embedded-browser-panel" className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={browser.submit} className="shrink-0 border-b border-ink/10 px-1.5 py-1.5">
        <div className="flex items-center gap-1">
          <input
            value={browser.input}
            onChange={(event) => browser.setInput(event.target.value)}
            aria-label={t('workbench.browserUrl')}
            placeholder={t('workbench.browserUrl')}
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded-control border border-ink/10 bg-paper px-2 text-xs text-ink outline-none focus:border-focus"
          />
          <button
            type="submit"
            className="h-8 shrink-0 rounded-control bg-ink px-2.5 text-xs text-paper"
          >
            {t('workbench.go')}
          </button>
        </div>
        {browser.error && (
          <p role="alert" data-testid="embedded-browser-error" className="mt-1 px-0.5 text-xs leading-4 text-danger">
            {t(ERROR_KEYS[browser.error] || 'workbench.browserInvalid')}
          </p>
        )}
      </form>

      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-ink/10 px-1">
        <button
          type="button"
          data-testid="embedded-browser-back"
          onClick={browser.goBack}
          disabled={!hosted || !browser.status.canGoBack}
          aria-label={t('workbench.browserBack')}
          title={t('workbench.browserBack')}
          className={controlClass(hosted && browser.status.canGoBack)}
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="embedded-browser-forward"
          onClick={browser.goForward}
          disabled={!hosted || !browser.status.canGoForward}
          aria-label={t('workbench.browserForward')}
          title={t('workbench.browserForward')}
          className={controlClass(hosted && browser.status.canGoForward)}
        >
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="embedded-browser-reload"
          onClick={browser.reload}
          disabled={!browser.url}
          aria-label={t('workbench.browserReload')}
          title={t('workbench.browserReload')}
          className={controlClass(Boolean(browser.url))}
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {hosted && browser.status.loading && (
          <button
            type="button"
            data-testid="embedded-browser-stop"
            onClick={browser.stop}
            aria-label={t('workbench.browserStop')}
            title={t('workbench.browserStop')}
            className={controlClass(true)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-ink-fade" title={browser.status.title || browser.url}>
          {browser.status.loading && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden="true" />}
          {browser.status.title}
        </span>
        <span data-testid="embedded-browser-backend" data-backend={browser.backend} className="shrink-0 rounded-pill bg-ink/[0.05] px-1.5 py-0.5 text-xs text-ink-fade">
          {t(hosted ? 'workbench.browserHost' : 'workbench.browserFrame')}
        </span>
        {browser.url && (
          <a
            href={browser.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            data-testid="embedded-browser-external"
            aria-label={t('workbench.openBrowser')}
            title={t('workbench.openBrowser')}
            className={controlClass(true)}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>

      <div ref={containerRef} data-testid="embedded-browser-viewport" className="relative min-h-0 flex-1 overflow-hidden">
        {!browser.url && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-ink-fade">
            <Globe2 className="h-8 w-8 opacity-30" aria-hidden="true" />
            <span className="text-xs leading-5">{t('workbench.browserHint')}</span>
          </div>
        )}
        {frameFailed && (
          <p role="alert" data-testid="embedded-browser-failed" className="px-2.5 py-3 text-xs leading-5 text-ink-fade">
            {t('workbench.browserFailed')}
          </p>
        )}
        {browser.url && browser.backend === 'frame' && (
          <iframe
            key={`${browser.url}#${browser.reloadKey}`}
            title={t('workbench.browser')}
            src={browser.url}
            sandbox="allow-scripts allow-forms allow-popups"
            onErrorCapture={() => setFailedUrl(browser.url)}
            referrerPolicy="no-referrer"
            className={`h-full w-full border-0 bg-white ${frameFailed ? 'hidden' : ''}`}
          />
        )}
      </div>

      {browser.url && (
        <p className="shrink-0 border-t border-ink/10 px-2 py-1.5 text-xs leading-4 text-ink-fade">
          {t(hosted ? 'workbench.browserHostHint' : 'workbench.browserEmbeddingHint')}
        </p>
      )}
    </section>
  )
}
