import { AnimatePresence, motion } from 'framer-motion'
import { FileText, X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import PreviewBody from './preview/PreviewBody.jsx'
import { PreviewHeader, PreviewToolbar } from './preview/PreviewChrome.jsx'
import useArtifactExports from './preview/useArtifactExports.js'
import usePreviewPaneState from './preview/usePreviewPaneState.js'

export default function RightPreviewPane({ artifact, onClose, onMessage }) {
  const { t } = useT()
  const pane = usePreviewPaneState({ artifact, onClose })
  if (!artifact) return null
  const { preview, content } = artifact
  if (!preview) return <UnsupportedPreview onClose={onClose} t={t} />
  return <PreviewPane artifact={artifact} preview={preview} content={content} pane={pane} onClose={onClose} onMessage={onMessage} t={t} />
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
        className={`chat-preview-pane ${pane.maximized ? 'chat-preview-pane-maximized fixed inset-0 w-screen' : 'relative'} z-40 bg-paper-2 flex flex-col border-l border-dashed border-ink-fade/50 overflow-hidden`}
      >
        {!pane.maximized && <div onMouseDown={pane.startResize} onDoubleClick={() => pane.setPaneWidth(520)} title={t('chatPreview.resize')} className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-ember/30 transition-colors" aria-hidden="true" />}
        <PreviewHeader preview={preview} maximized={pane.maximized} setMaximized={pane.setMaximized} onClose={onClose} t={t} />
        <PreviewToolbar preview={preview} content={content} view={pane.view} setView={pane.setView} exports={exports} t={t} />
        <div className="flex-1 min-h-0 overflow-hidden"><PreviewBody preview={preview} content={content} view={pane.view} /></div>
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
