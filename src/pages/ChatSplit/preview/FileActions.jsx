import { useRef, useState } from 'react'
import { AppWindow, ChevronDown, Copy, FolderOpen } from 'lucide-react'
import FileTypeGlyph from '../../../components/FileTypeGlyph.jsx'
import FileNameLabel from '../../../components/FileNameLabel.jsx'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { desktopFileCapabilities, desktopFileErrorKey, openDesktopFile } from '../../../lib/desktopFileClient.js'
import { CHIP_CLASS } from './previewChipStyles.js'
import useDetailsDismiss from './useDetailsDismiss.js'

const ITEM_CLASS = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-ink hover:bg-ink/[0.05] disabled:opacity-50'
const PANEL_CLASS = 'rounded-xl border border-ink/10 bg-paper p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.22)]'

/**
 * The file chip at the head of a previewed file, as the reference desktop apps
 * draw it: the file's own icon and name; opening it names the file in full and
 * offers what can be done with it on this machine.
 *
 * Opening a file in its own application, and showing it in its folder, are actions
 * on the local machine: they work when the file carries a reference this app issued
 * and the page is running in the desktop shell, which is the only place allowed to
 * ask the operating system to act. A browser tab cannot start a program or open a
 * file manager, so there those two entries are absent and the menu says why
 * rather than offering an action that could never work. The actions are listed
 * directly — no "Open with" step in between: there is one way to open a file.
 */
export default function FileActions({ file, t }) {
  const menuRef = useRef(null)
  useDetailsDismiss(menuRef)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const capabilities = desktopFileCapabilities(file)
  const filename = String(file?.filename || file?.title || '').trim()
  const filePath = String(file?.path || file?.fullPath || '').trim()
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false
  }
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
  const copyPath = () => {
    closeMenu()
    copyTextToClipboard(filePath)
      .then(() => setResult({ key: 'chatPreview.pathCopied' }))
      .catch(() => setResult({ error: true, key: 'chatPreview.pathCopyFailed' }))
  }
  return (
    <div className="relative min-w-0 shrink">
      <details ref={menuRef} className="group min-w-0" onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menuRef.current?.open) return
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        menuRef.current?.querySelector('summary')?.focus()
      }}>
        <summary data-testid="preview-open-menu" aria-label={t('chatPreview.fileActions')}
          title={filePath || filename} className={`${CHIP_CLASS} max-w-full cursor-pointer list-none`}>
          <FileTypeGlyph name={filename} type={file?.type} size={15} />
          <span data-testid="preview-file-path" title={filePath || filename} className="min-w-0 flex-1">
            {busy ? t('chatPreview.fileOpening') : <FileNameLabel value={filename} />}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-fade transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div role="group" aria-label={t('chatPreview.fileActions')} className={`absolute left-0 top-full z-50 mt-1.5 w-72 ${PANEL_CLASS}`}>
          {/* Which file these actions apply to, above the actions themselves. */}
          {filename && (
            <p data-testid="preview-open-menu-title" className="flex items-center gap-2.5 px-2.5 py-2 text-[0.8125rem] text-ink" title={filename}>
              <FileTypeGlyph name={filename} type={file?.type} size={16} />
              <FileNameLabel value={filename} />
            </p>
          )}
          <div className="mx-1.5 my-1 border-t border-ink/10" />
          {capabilities.supported ? (
            <>
              <button type="button" data-testid="preview-open-default-app" disabled={busy || !capabilities.canOpen} onClick={() => perform('open')} className={ITEM_CLASS}>
                <AppWindow className="h-4 w-4 text-accent-ink" aria-hidden="true" />{t('chatPreview.openDefaultApp')}
              </button>
              <button type="button" data-testid="preview-open-reveal" disabled={busy} onClick={() => perform('reveal')} className={ITEM_CLASS}>
                <FolderOpen className="h-4 w-4 text-ink-soft" aria-hidden="true" />{t('chatPreview.revealFile')}
              </button>
              {!capabilities.canOpen && <p className="px-2.5 py-2 text-xs leading-5 text-ink-fade">{t('chatPreview.fileOpenUnsafe')}</p>}
            </>
          ) : <p className="px-2.5 py-2 text-xs leading-5 text-ink-fade">{t('chatPreview.nativeOpenHint')}</p>}
          {filePath && (
            <button type="button" data-testid="preview-copy-path" onClick={copyPath} className={ITEM_CLASS}>
              <Copy className="h-4 w-4 text-ink-soft" aria-hidden="true" />{t('chatPreview.copyPath')}
            </button>
          )}
        </div>
      </details>
      {result && <p role={result.error ? 'alert' : 'status'} className={`absolute left-0 top-full z-50 mt-1.5 w-72 ${PANEL_CLASS} p-3 text-xs ${result.error ? 'text-danger' : 'text-ink-soft'}`}>
        {t(result.key)}<button type="button" onClick={() => setResult(null)} className="ml-2 underline underline-offset-2">{t('chatPreview.dismissMessage')}</button>
      </p>}
    </div>
  )
}
