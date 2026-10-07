import { useEffect, useRef, useState } from 'react'
import {
  ExternalLink,
  Globe2,
  Loader2,
  Lock,
  RotateCw,
  Search,
  X,
} from 'lucide-react'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { isDesktopBrowserAvailable } from '../lib/desktopBrowserClient.js'
import { publishPreviewPageStatus } from '../lib/previewPageStore.js'
import useEmbeddedBrowser from './useEmbeddedBrowser.js'

const HINT_DISMISSED_KEY = 'yma:workbench-browser-hint-dismissed'

/** The status line names where the page is; the full address is in the bar above. */
function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

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
  // The top bar names preview intents; this component owns the URL, so it is
  // the one that executes them (reload, open outside, copy the address).
  useEffect(() => {
    const openExternal = () => {
      const target = browser.url
      if (!target) return
      // An anchor click, not window.open: same new-tab behaviour, and the
      // guard that keeps window.open out of the UI keeps holding.
      const anchor = document.createElement('a')
      anchor.href = target
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.click()
    }
    const copyUrl = () => {
      if (browser.url) void copyTextToClipboard(browser.url)
    }
    window.addEventListener('workbench-preview:reload', browser.reload)
    window.addEventListener('workbench-preview:back', browser.goBack)
    window.addEventListener('workbench-preview:forward', browser.goForward)
    window.addEventListener('workbench-preview:open-external', openExternal)
    window.addEventListener('workbench-preview:copy-url', copyUrl)
    return () => {
      window.removeEventListener('workbench-preview:reload', browser.reload)
      window.removeEventListener('workbench-preview:back', browser.goBack)
      window.removeEventListener('workbench-preview:forward', browser.goForward)
      window.removeEventListener('workbench-preview:open-external', openExternal)
      window.removeEventListener('workbench-preview:copy-url', copyUrl)
    }
  }, [browser.goBack, browser.goForward, browser.reload, browser.url])

  // The top bar's arrows act on this page when this panel is the active tool, and
  // it can only know whether they should be enabled from here.
  useEffect(() => {
    publishPreviewPageStatus({
      url: browser.url,
      title: browser.status?.title || '',
      canGoBack: browser.status?.canGoBack === true,
      canGoForward: browser.status?.canGoForward === true,
      loading: browser.status?.loading === true,
      backend: browser.backend,
    })
  }, [browser.backend, browser.status, browser.url])
  const hosted = isDesktopBrowserAvailable()
  // A refused embed fires an error on the frame. Without this the panel would keep
  // showing a white rectangle and the reader would have no way to tell a refusal
  // from a slow load.
  const [failedUrl, setFailedUrl] = useState('')
  const frameFailed = Boolean(browser.url) && failedUrl === browser.url
  // The backend note is worth reading once; after that it is a permanent strip
  // of grey text under every page, so it can be put away for good.
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return window.localStorage.getItem(HINT_DISMISSED_KEY) === '1' } catch { return false }
  })
  const dismissHint = () => {
    setHintDismissed(true)
    try { window.localStorage.setItem(HINT_DISMISSED_KEY, '1') } catch { /* storage is optional */ }
  }
  // Ctrl/Cmd+L focuses the address bar, as in every browser — but only while
  // this panel is the one on screen, so the shortcut is not taken from the app.
  const addressRef = useRef(null)
  useEffect(() => {
    if (!active) return undefined
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <section data-testid="embedded-browser-panel" className="flex min-h-0 flex-1 flex-col">
      {/* One address row. Back and forward live in the workbench bar above, which
          already walks this page's history; repeating them here gave the panel
          two navigation strips. Reload sits beside the address, as in a browser,
          and turns into stop while a hosted page loads. */}
      <form onSubmit={browser.submit} className="shrink-0 border-b border-ink/10 px-1.5 py-1.5">
        <div className="flex items-center gap-1">
          {hosted && browser.status.loading ? (
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
          ) : (
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
          )}
          <label className="relative flex h-8 min-w-0 flex-1 items-center">
            <span className="pointer-events-none absolute left-2.5 flex text-ink-fade" aria-hidden="true">
              {browser.url.startsWith('https://')
                ? <Lock className="h-3 w-3" />
                : browser.url ? <Globe2 className="h-3 w-3" /> : <Search className="h-3 w-3" />}
            </span>
            <input
              ref={addressRef}
              value={browser.input}
              onChange={(event) => browser.setInput(event.target.value)}
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { browser.setInput(browser.url); event.currentTarget.blur() }
              }}
              aria-label={t('workbench.browserUrl')}
              placeholder={t('workbench.browserPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-full min-w-0 rounded-pill border border-ink/10 bg-paper-2/60 pl-7 pr-3 text-xs text-ink outline-none transition-colors placeholder:text-ink-fade hover:border-ink/20 focus:border-focus focus:bg-paper"
            />
          </label>
          <button
            type="submit"
            className="h-8 shrink-0 rounded-pill bg-ink px-3 text-xs font-medium text-paper transition-opacity hover:opacity-90"
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

      {browser.url && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-ink/10 px-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-fade" title={browser.status.title || browser.url}>
            {browser.status.loading && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden="true" />}
            {browser.status.title || hostOf(browser.url)}
          </span>
          <span data-testid="embedded-browser-backend" data-backend={browser.backend} className="shrink-0 rounded-pill bg-ink/[0.05] px-1.5 py-0.5 text-xs text-ink-fade">
            {t(hosted ? 'workbench.browserHost' : 'workbench.browserFrame')}
          </span>
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
        </div>
      )}

      <div ref={containerRef} data-testid="embedded-browser-viewport" className="relative min-h-0 flex-1 overflow-hidden">
        {!browser.url && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-running/10 text-running" aria-hidden="true">
              <Globe2 className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <div className="max-w-[17rem]">
              <p className="text-sm font-medium text-ink">{t('workbench.browserEmptyTitle')}</p>
              <p className="mt-1 text-balance text-xs leading-5 text-ink-fade">{t('workbench.browserHint')}</p>
            </div>
            {browser.recent.length > 0 && (
              <div className="w-full max-w-[18rem] text-left" data-testid="embedded-browser-recent">
                <p className="mb-1 px-1 text-xs text-ink-fade">{t('workbench.browserRecent')}</p>
                <ul className="space-y-0.5">
                  {browser.recent.map((entry) => (
                    <li key={entry}>
                      <button
                        type="button"
                        onClick={() => browser.navigate(entry)}
                        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-xs text-ink-soft transition-colors hover:bg-[var(--color-row-hover)] hover:text-ink"
                        title={entry}
                      >
                        {entry.startsWith('https://')
                          ? <Lock className="h-3 w-3 shrink-0 text-ink-fade" aria-hidden="true" />
                          : <Globe2 className="h-3 w-3 shrink-0 text-ink-fade" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 truncate font-mono">{entry.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-ink-fade">{t('workbench.browserFocusHint', { shortcut: 'Ctrl+L' })}</p>
          </div>
        )}
        {frameFailed && (
          <div role="alert" data-testid="embedded-browser-failed" className="flex flex-col items-center gap-2 border-b border-ink/10 bg-paper-2/60 px-3 py-2.5 text-xs leading-5 text-ink-soft">
            <span>{t('workbench.browserFailed')}</span>
            <a href={browser.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
              data-testid="browser-embed-refused-open"
              className="rounded-control bg-ink px-3 py-1.5 text-xs text-paper">
              {t('workbench.openBrowser')}
            </a>
          </div>
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

      {browser.url && !hintDismissed && (
        <p className="flex shrink-0 items-start gap-2 border-t border-ink/10 px-2 py-1.5 text-xs leading-4 text-ink-fade">
          <span className="min-w-0 flex-1">{t(hosted ? 'workbench.browserHostHint' : 'workbench.browserEmbeddingHint')}</span>
          <button
            type="button"
            onClick={dismissHint}
            aria-label={t('workbench.browserHintDismiss')}
            title={t('workbench.browserHintDismiss')}
            className="shrink-0 rounded-control p-0.5 text-ink-fade hover:bg-ink/5 hover:text-ink"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </p>
      )}
    </section>
  )
}
