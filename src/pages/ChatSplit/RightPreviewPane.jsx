import { AnimatePresence, motion } from 'framer-motion'
import { Download, FileText, X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'
import PreviewBody from './preview/PreviewBody.jsx'
import { PreviewHeader, PreviewToolbar } from './preview/PreviewChrome.jsx'
import useArtifactExports from './preview/useArtifactExports.js'
import usePreviewPaneState, {
  DEFAULT_PREVIEW_PANE_WIDTH,
  MIN_PREVIEW_PANE_WIDTH,
  previewPaneMaxWidth,
} from './preview/usePreviewPaneState.js'

export default function RightPreviewPane({ artifact, onClose, onMessage }) {
  const { t } = useT()
  const pane = usePreviewPaneState({ artifact, onClose })
  if (!artifact) return null
  if (artifact.directFile) return <DirectFilePane file={artifact.directFile} pane={pane} onClose={onClose} t={t} />
  const { preview, content } = artifact
  if (!preview) return <UnsupportedPreview onClose={onClose} t={t} />
  return <PreviewPane artifact={artifact} preview={preview} content={content} pane={pane} onClose={onClose} onMessage={onMessage} t={t} />
}

function DirectFilePane({ file, pane, onClose, t }) {
  const filename = String(file?.filename || file?.title || 'artifact')
  const type = String(file?.type || filename.split('.').pop() || 'file').toLowerCase()
  const url = file?.url ? withDownloadToken(file.url) : ''
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(type)
  const isFrame = ['pdf', 'html', 'htm'].includes(type)
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-ink/20 pointer-events-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.aside
        key="direct-file-pane"
        data-testid="direct-file-pane"
        style={{ width: `${pane.paneWidth}px` }}
        className="relative z-40 flex h-full shrink-0 flex-col overflow-hidden border-l border-dashed border-ink-fade/50 bg-paper-2"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
      >
        <div
          role="separator"
          tabIndex={0}
          data-testid="preview-resize-handle"
          aria-label={t('chatPreview.resize')}
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_PANE_WIDTH}
          aria-valuemax={previewPaneMaxWidth()}
          aria-valuenow={pane.paneWidth}
          onPointerDown={pane.startResize}
          onKeyDown={pane.resizeWithKeyboard}
          onDoubleClick={() => pane.setPaneWidth(DEFAULT_PREVIEW_PANE_WIDTH)}
          className="chat-preview-resize-handle absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none outline-none"
        />
        <header className="flex items-center gap-3 border-b border-ink/10 bg-paper px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember"><FileText className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink" title={filename}>{filename}</span><span className="block text-[10px] uppercase tracking-[0.16em] text-ink-fade">{type}</span></span>
          <button type="button" onClick={onClose} aria-label={t('chatPreview.close')} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-fade hover:bg-ink/5 hover:text-ink"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-paper-2 p-4" data-testid="direct-file-content">
          {url && isImage && <img src={url} alt={filename} className="mx-auto max-h-full max-w-full object-contain" />}
          {url && isFrame && <iframe src={url} title={filename} sandbox="allow-scripts allow-forms" className="h-full min-h-[520px] w-full border-0 bg-white" />}
          {(!url || (!isImage && !isFrame)) && (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-ink/15 bg-paper text-center">
              <FileText className="h-10 w-10 text-ink-fade/40" />
              <p className="max-w-xs text-sm text-ink-soft">{filename}</p>
              <p className="max-w-xs text-xs text-ink-fade">{t('chatPreview.unsupportedHint')}</p>
            </div>
          )}
        </div>
        {url && (
          <footer className="border-t border-ink/10 bg-paper p-3">
            <a href={url} download={filename} className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-medium text-paper"><Download className="h-4 w-4" />{t('chatPreview.download', { filename })}</a>
          </footer>
        )}
      </motion.aside>
    </AnimatePresence>
  )
}

function PreviewPane({ preview, content, pane, onClose, onMessage, t }) {
  const exports = useArtifactExports({ preview, content, onMessage, t })
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-ink/20 pointer-events-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      <motion.div
        key="preview-pane"
        onTouchStart={pane.handleTouchStart}
        onTouchMove={pane.handleTouchMove}
        onTouchEnd={pane.handleTouchEnd}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        style={pane.maximized ? undefined : { width: `${pane.paneWidth}px` }}
        className={`chat-preview-pane ${pane.maximized ? 'chat-preview-pane-maximized fixed inset-0 w-screen' : 'relative shrink-0'} z-40 flex h-full min-w-0 flex-col overflow-hidden border-l border-dashed border-ink-fade/50 bg-paper-2`}
      >
        {!pane.maximized && (
          <div
            role="separator"
            tabIndex={0}
            data-testid="preview-resize-handle"
            aria-label={t('chatPreview.resize')}
            aria-orientation="vertical"
            aria-valuemin={MIN_PREVIEW_PANE_WIDTH}
            aria-valuemax={previewPaneMaxWidth()}
            aria-valuenow={pane.paneWidth}
            onPointerDown={pane.startResize}
            onKeyDown={pane.resizeWithKeyboard}
            onDoubleClick={() => pane.setPaneWidth(DEFAULT_PREVIEW_PANE_WIDTH)}
            title={t('chatPreview.resize')}
            className="chat-preview-resize-handle absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-ink-fade/30 hover:after:bg-ember focus-visible:after:bg-ember"
          />
        )}
        {pane.resizing && <div data-testid="preview-resize-shield" className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" />}
        <PreviewHeader preview={preview} maximized={pane.maximized} setMaximized={pane.setMaximized} onClose={onClose} t={t} />
        <PreviewToolbar preview={preview} content={content} view={pane.view} setView={pane.setView} exports={exports} t={t} />
        <div data-testid="preview-scroll-region" className="min-h-0 flex-1 overflow-auto overscroll-contain"><PreviewBody preview={preview} content={content} view={pane.view} /></div>
      </motion.div>
    </AnimatePresence>
  )
}

function UnsupportedPreview({ onClose, t }) {
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-ink/20 pointer-events-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      <motion.aside className="w-full h-full border-l border-ink-fade/30 bg-paper flex flex-col items-center justify-center gap-4 text-ink-fade relative z-40" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ duration: 0.2 }}>
        {onClose && <button type="button" onClick={onClose} aria-label={t('chatPreview.close')} className="absolute right-4 top-4 w-10 h-10 rounded-md bg-paper/80 hover:bg-ember/10 hover:text-ember flex items-center justify-center text-ink-soft" title={t('chatPreview.close')}><X className="w-4 h-4" /></button>}
        <FileText className="w-10 h-10 opacity-30" />
        <p className="text-sm">{t('chatPreview.unsupported')}</p>
        <p className="text-xs text-ink-fade/70 max-w-[200px] text-center">{t('chatPreview.unsupportedHint')}</p>
        {onClose && <button type="button" onClick={onClose} className="mt-2 h-8 px-4 border border-ink-fade/30 rounded-md text-xs hover:border-ember/50">{t('chatPreview.closePanel')}</button>}
      </motion.aside>
    </AnimatePresence>
  )
}
