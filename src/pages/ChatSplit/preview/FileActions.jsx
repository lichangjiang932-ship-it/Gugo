import { useRef, useState } from 'react'
import { ChevronDown, Download, ExternalLink, Eye, FolderOpen } from 'lucide-react'
import { desktopFileCapabilities, desktopFileErrorKey, openDesktopFile } from '../../../lib/desktopFileClient.js'

const ITEM_CLASS = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50'

export default function FileActions({ file, url, setView, t }) {
  const menuRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const capabilities = desktopFileCapabilities(file)
  const closeMenu = () => { if (menuRef.current) menuRef.current.open = false }
  const perform = async (action) => {
    if (busy) return
    closeMenu()
    setBusy(true)
    setResult(null)
    try {
      const outcome = await openDesktopFile(file, action)
      if (!outcome.canceled) setResult({ key: action === 'open' ? 'chatPreview.fileOpened' : 'chatPreview.fileRevealRequested' })
    } catch (error) {
      setResult({ error: true, key: desktopFileErrorKey(error.code) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="relative shrink-0">
      <details ref={menuRef} className="group" onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menuRef.current?.open) return
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        menuRef.current?.querySelector('summary')?.focus()
      }}>
        <summary data-testid="preview-open-menu" className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-ink/15 bg-paper px-2.5 text-xs font-medium text-ink outline-none hover:bg-paper-2 focus-visible:ring-2 focus-visible:ring-ink/25">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t(busy ? 'chatPreview.fileOpening' : 'chatPreview.openFile')}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </summary>
        <div role="group" aria-label={t('chatPreview.fileActions')} className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-ink/10 bg-paper p-1 shadow-xl">
          {setView && <button type="button" className={ITEM_CLASS} onClick={() => { setView('preview'); closeMenu() }}>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />{t('chatPreview.openPreview')}
          </button>}
          {capabilities.supported ? <>
            <button type="button" disabled={busy || !capabilities.canOpen} onClick={() => perform('open')} className={ITEM_CLASS}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t('chatPreview.openDefaultApp')}
            </button>
            <button type="button" disabled={busy} onClick={() => perform('reveal')} className={ITEM_CLASS}>
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />{t('chatPreview.revealFile')}
            </button>
            {!capabilities.canOpen && <p className="px-3 py-2 text-xs leading-5 text-ink-fade">{t('chatPreview.fileOpenUnsafe')}</p>}
          </> : <p className="px-3 py-2 text-xs leading-5 text-ink-fade">{t('chatPreview.nativeOpenHint')}</p>}
          {url && <a href={url} download={file.filename} aria-label={t('chatPreview.download', { filename: file.filename })}
            title={t('chatPreview.download', { filename: file.filename })}
            onClick={closeMenu} className={`${ITEM_CLASS} border-t border-ink/10`}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />{t('chatPreview.saveAs')}
          </a>}
        </div>
      </details>
      {result && <p role={result.error ? 'alert' : 'status'} className={`absolute right-0 top-full z-50 mt-1 w-64 rounded border border-ink/10 bg-paper p-3 text-xs shadow ${result.error ? 'text-danger' : 'text-ink-soft'}`}>
        {t(result.key)}<button type="button" onClick={() => setResult(null)} className="ml-2 underline underline-offset-2">{t('chatPreview.dismissMessage')}</button>
      </p>}
    </div>
  )
}
