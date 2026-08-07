import { AnimatePresence, motion } from 'framer-motion'
import { FileText, X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'
import PreviewBody from './preview/PreviewBody.jsx'
import { DirectFileToolbar, PreviewHeader, PreviewToolbar } from './preview/PreviewChrome.jsx'
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
  const extension = String(filename.split('.').pop() || '').toLowerCase()
  const rawType = String(file?.type || extension || 'file').toLowerCase()
  const type = rawType.includes('/') ? (extension || rawType.split('/').pop()) : rawType
  const url = file?.url ? withDownloadToken(file.url) : ''
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(type)
  const isFrame = ['pdf', 'html', 'htm'].includes(type)
  const preview = { type, filename }
  return (
    <PreviewShell pane={pane} onClose={onClose} t={t} testId="direct-file-pane" shellKey="direct-file-pane">
      <PreviewHeader preview={preview} maximized={pane.maximized} setMaximized={pane.setMaximized} onClose={onClose} t={t} />
      <DirectFileToolbar filename={filename} type={type} summary={file?.summary || file?.mimeType || ''} url={url} t={t} />
      <div className={`chat-direct-file-content min-h-0 flex-1 ${isImage ? 'overflow-auto p-5' : 'overflow-hidden'}`} data-testid="direct-file-content">
        {url && isImage && <div className="flex min-h-full min-w-full items-center justify-center"><img src={url} alt={filename} className="block max-h-full max-w-full rounded-sm object-contain shadow-sm" /></div>}
        {url && isFrame && <iframe src={url} title={filename} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="block h-full w-full border-0 bg-white" />}
        {(!url || (!isImage && !isFrame)) && (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink/10 bg-paper text-ink-fade shadow-sm"><FileText className="h-6 w-6" /></span>
            <p className="max-w-xs text-sm font-medium text-ink-soft">{filename}</p>
            <p className="max-w-xs text-xs leading-relaxed text-ink-fade">{t('chatPreview.unsupportedHint')}</p>
          </div>
        )}
      </div>
    </PreviewShell>
  )
}

function PreviewPane({ preview, content, pane, onClose, onMessage, t }) {
  const exports = useArtifactExports({ preview, content, onMessage, t })
  return (
    <PreviewShell pane={pane} onClose={onClose} t={t} testId="preview-pane" shellKey="preview-pane">
      <PreviewHeader preview={preview} maximized={pane.maximized} setMaximized={pane.setMaximized} onClose={onClose} t={t} />
      <PreviewToolbar preview={preview} content={content} view={pane.view} setView={pane.setView} exports={exports} t={t} />
      <div data-testid="preview-scroll-region" className="chat-preview-scroll-region min-h-0 flex-1 overflow-hidden overscroll-contain"><PreviewBody preview={preview} content={content} view={pane.view} /></div>
    </PreviewShell>
  )
}

function PreviewShell({ children, onClose, pane, shellKey, t, testId }) {
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" aria-hidden="true" onClick={onClose} className="chat-preview-backdrop fixed inset-0 z-30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} />
      <motion.aside
        key={shellKey}
        data-testid={testId}
        onTouchStart={pane.handleTouchStart}
        onTouchMove={pane.handleTouchMove}
        onTouchEnd={pane.handleTouchEnd}
        initial={{ x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 32, opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={pane.maximized ? undefined : { width: `${pane.paneWidth}px` }}
        className={`chat-preview-pane ${pane.maximized ? 'chat-preview-pane-maximized fixed inset-0 w-screen' : 'relative shrink-0'} z-40 flex h-full min-w-0 flex-col overflow-hidden border-l border-ink/10 bg-paper`}
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
            className="chat-preview-resize-handle absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none"
          />
        )}
        {pane.resizing && <div data-testid="preview-resize-shield" className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" />}
        {children}
      </motion.aside>
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
