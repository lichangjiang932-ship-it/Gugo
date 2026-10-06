import { useState } from 'react'
import { AppWindow, FolderOpen } from 'lucide-react'
import FileTypeGlyph from '../../../components/FileTypeGlyph.jsx'
import { desktopFileCapabilities, desktopFileErrorKey, openDesktopFile } from '../../../lib/desktopFileClient.js'
import { OpenOriginalLink } from './PreviewPrimitives.jsx'

const BUTTON_CLASS = 'inline-flex h-8 items-center gap-1.5 rounded-full border border-ink/10 bg-paper px-3 text-xs font-medium text-ink hover:bg-paper-2 disabled:opacity-50'

/**
 * A format the pane cannot draw (a legacy .doc/.ppt, an archive, HEIC…). In the
 * desktop app the file is one press from its own application or its folder,
 * which is what a reader wants from a file the pane cannot show; a browser tab
 * keeps the plain link to the original.
 */
export default function UnsupportedFilePreview({ file, t, url }) {
  const [state, setState] = useState({ busy: false, message: null })
  const capabilities = desktopFileCapabilities({ ...file, url: file?.url || url })
  const filename = file?.filename || file?.title || 'file'
  const perform = async (action) => {
    setState({ busy: true, message: null })
    try {
      const outcome = await openDesktopFile({ ...file, url: file?.url || url }, action)
      setState({ busy: false, message: outcome.canceled ? null : { key: action === 'open' ? 'chatPreview.fileOpened' : 'chatPreview.fileRevealRequested' } })
    } catch (error) {
      setState({ busy: false, message: { error: true, key: desktopFileErrorKey(error.code) } })
    }
  }
  return (
    <div data-testid="unsupported-file-preview" className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 bg-paper-2 p-6 text-center">
      <FileTypeGlyph name={filename} type={file?.type} size={44} />
      <p className="max-w-xs break-words text-sm font-medium text-ink">{filename}</p>
      <p className="max-w-xs text-xs leading-5 text-ink-fade">{t(capabilities.supported ? 'chatPreview.unsupportedDesktopHint' : 'chatPreview.unsupportedHint')}</p>
      {capabilities.supported ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button type="button" data-testid="unsupported-open-default-app" disabled={state.busy || !capabilities.canOpen} onClick={() => perform('open')} className={BUTTON_CLASS}>
            <AppWindow className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" />{t('chatPreview.openDefaultApp')}
          </button>
          <button type="button" data-testid="unsupported-reveal" disabled={state.busy} onClick={() => perform('reveal')} className={BUTTON_CLASS}>
            <FolderOpen className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" />{t('chatPreview.revealFile')}
          </button>
        </div>
      ) : <OpenOriginalLink url={url} t={t} />}
      {state.message && <p role={state.message.error ? 'alert' : 'status'} className={`text-xs ${state.message.error ? 'text-danger' : 'text-ink-soft'}`}>{t(state.message.key)}</p>}
    </div>
  )
}
