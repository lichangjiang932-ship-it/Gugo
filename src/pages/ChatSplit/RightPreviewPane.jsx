import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FileText } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withArtifactPreviewMode } from '../../lib/directFilePreview.js'
import { withDownloadToken } from '../../lib/jobClient.js'
import PreviewBody from './preview/PreviewBody.jsx'
import DirectFilePreview from './preview/DirectFilePreview.jsx'
import { DirectFileToolbar, PreviewHeader, PreviewToolbar } from './preview/PreviewChrome.jsx'
import useArtifactExports from './preview/useArtifactExports.js'
import { createPreviewTabState } from './preview/previewTabs.js'
import usePreviewPaneState, {
  DEFAULT_PREVIEW_PANE_WIDTH,
  MIN_PREVIEW_PANE_WIDTH,
  previewPaneMaxWidth,
} from './preview/usePreviewPaneState.js'

export default function RightPreviewPane({
  artifact,
  previewTabs,
  activePreviewId,
  onActivateTab,
  onCloseTab,
  onClose,
  onMessage,
}) {
  const { t } = useT()
  const paneRef = useRef(null)
  const [initialReturnFocus] = useState(() => {
    if (typeof document === 'undefined') return null
    const activeElement = document.activeElement
    return activeElement && activeElement !== document.body && typeof activeElement.focus === 'function'
      ? activeElement
      : null
  })
  const returnFocusRef = useRef(initialReturnFocus)
  const focusActiveTabRef = useRef(false)
  const fallbackTabState = createPreviewTabState(artifact)
  const tabState = Array.isArray(previewTabs) && previewTabs.length > 0
    ? { tabs: previewTabs, activeId: activePreviewId }
    : fallbackTabState
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeId) || tabState.tabs[0] || null
  const activeArtifact = activeTab?.artifact || null

  useEffect(() => {
    if (typeof document === 'undefined') return
    const activeElement = document.activeElement
    if (
      activeElement
      && activeElement !== document.body
      && typeof activeElement.focus === 'function'
      && !paneRef.current?.contains(activeElement)
    ) {
      returnFocusRef.current = activeElement
    }
  }, [artifact])

  const restoreTriggerFocus = useCallback(() => {
    const target = returnFocusRef.current
    if (!target?.isConnected || typeof target.focus !== 'function') return
    try {
      target.focus({ preventScroll: true })
    } catch {
      target.focus()
    }
  }, [])

  const closePane = useCallback(() => {
    restoreTriggerFocus()
    onClose?.()
  }, [onClose, restoreTriggerFocus])

  const pane = usePreviewPaneState({ artifact: activeArtifact, onClose: closePane })

  const selectTab = useCallback((tabId) => {
    onActivateTab?.(tabId)
  }, [onActivateTab])

  const closeTab = useCallback((tabId) => {
    if (tabState.tabs.length <= 1 || typeof onCloseTab !== 'function') {
      closePane()
      return
    }
    focusActiveTabRef.current = true
    onCloseTab(tabId)
  }, [closePane, onCloseTab, tabState.tabs.length])

  useEffect(() => {
    if (!focusActiveTabRef.current || !activeTab) return
    focusActiveTabRef.current = false
    const target = paneRef.current?.querySelector('[role="tab"][aria-selected="true"]')
    if (typeof target?.focus !== 'function') return
    try {
      target.focus({ preventScroll: true })
    } catch {
      target.focus()
    }
  }, [activeTab, tabState.tabs])

  if (!activeTab || !activeArtifact) return null
  const testId = activeArtifact.directFile ? 'direct-file-pane' : 'preview-pane'
  return (
    <PreviewShell pane={pane} paneRef={paneRef} onClose={closePane} t={t} testId={testId} shellKey="preview-pane">
      <PreviewHeader
        tabs={tabState.tabs}
        activeId={activeTab.id}
        maximized={pane.maximized}
        setMaximized={pane.setMaximized}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onClose={closePane}
        t={t}
      />
      {activeArtifact.directFile ? (
        <DirectFileContent file={activeArtifact.directFile} t={t} />
      ) : activeArtifact.preview ? (
        <PreviewContent preview={activeArtifact.preview} content={activeArtifact.content} pane={pane} onMessage={onMessage} t={t} />
      ) : (
        <UnsupportedPreview t={t} />
      )}
    </PreviewShell>
  )
}

function DirectFileContent({ file, t }) {
  const filename = String(file?.filename || file?.title || 'artifact')
  const extension = String(filename.split('.').pop() || '').toLowerCase()
  const rawType = String(file?.type || extension || 'file').toLowerCase()
  const type = rawType.includes('/') ? (extension || rawType.split('/').pop()) : rawType
  const downloadUrl = file?.url ? withDownloadToken(file.url) : ''
  const previewUrl = withArtifactPreviewMode(downloadUrl)
  return (
    <>
      <DirectFileToolbar filename={filename} type={type} summary={file?.summary || file?.mimeType || ''} url={downloadUrl} t={t} />
      <div className="chat-direct-file-content min-h-0 flex-1 overflow-hidden" data-testid="direct-file-content">
        {previewUrl ? <DirectFilePreview file={{ ...file, filename, type }} url={previewUrl} t={t} /> : (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText className="h-10 w-10 text-ink-fade" />
            <p className="max-w-xs text-sm font-medium text-ink-soft">{filename}</p>
          </div>
        )}
      </div>
    </>
  )
}

function PreviewContent({ preview, content, pane, onMessage, t }) {
  const exports = useArtifactExports({ preview, content, onMessage, t })
  return (
    <>
      <PreviewToolbar preview={preview} content={content} view={pane.view} setView={pane.setView} exports={exports} t={t} />
      <div data-testid="preview-scroll-region" className="chat-preview-scroll-region min-h-0 flex-1 overflow-hidden overscroll-contain"><PreviewBody preview={preview} content={content} view={pane.view} /></div>
    </>
  )
}

function PreviewShell({ children, onClose, pane, paneRef, shellKey, t, testId }) {
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" aria-hidden="true" onClick={onClose} className="chat-preview-backdrop fixed inset-0 z-30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} />
      <motion.aside
        ref={paneRef}
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

function UnsupportedPreview({ t }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-ink-fade">
      <FileText className="h-10 w-10 opacity-30" />
      <p className="text-sm">{t('chatPreview.unsupported')}</p>
      <p className="max-w-[240px] text-xs text-ink-fade/70">{t('chatPreview.unsupportedHint')}</p>
    </div>
  )
}
