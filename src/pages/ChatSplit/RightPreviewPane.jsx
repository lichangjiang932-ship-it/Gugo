import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, FileText } from 'lucide-react'
import ErrorBoundary from '../../components/ErrorBoundary.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withArtifactPreviewMode } from '../../lib/directFilePreview.js'
import { withDownloadToken } from '../../lib/jobClient.js'
import PreviewBody from './preview/PreviewBody.jsx'
import DirectFilePreview from './preview/DirectFilePreview.jsx'
import { PreviewStatus, RetryPreviewButton } from './preview/PreviewPrimitives.jsx'
import { DirectFileToolbar, PreviewHeader, PreviewToolbar } from './preview/PreviewChrome.jsx'
import useArtifactExports from './preview/useArtifactExports.js'
import { PreviewZoomProvider, usePreviewZoomState } from './preview/previewZoomState.js'
import { createPreviewTabState } from './preview/previewTabs.js'
import usePreviewPaneState, {
  DEFAULT_PREVIEW_PANE_WIDTH,
  MIN_PREVIEW_PANE_WIDTH,
} from './preview/usePreviewPaneState.js'

export default function RightPreviewPane({
  artifact,
  previewTabs,
  activePreviewId,
  onActivateTab,
  onCloseTab,
  onClose,
  onMessage,
  onInsertText = null,
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
  const restoreChatInteractionRef = useRef(null)
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
    const original = returnFocusRef.current
    const chat = paneRef.current?.closest('[data-chat-main-area]')?.querySelector('.chat-main-pane')
    const target = original?.isConnected ? original
      : chat?.querySelector('[data-testid="chat-composer-surface"] textarea:not(:disabled)')
        || chat?.querySelector('textarea:not(:disabled)')
    if (!target?.isConnected || typeof target.focus !== 'function') return
    try {
      target.focus({ preventScroll: true })
    } catch {
      target.focus()
    }
  }, [])

  const closePane = useCallback(() => {
    restoreChatInteractionRef.current?.()
    restoreTriggerFocus()
    onClose?.()
  }, [onClose, restoreTriggerFocus])

  const pane = usePreviewPaneState({ artifact: activeArtifact, onClose: closePane, paneRef })

  useEffect(() => {
    if (!pane.overlay) return
    const activeElement = document.activeElement
    const main = paneRef.current?.closest('[data-chat-main-area]')
    const targets = [main?.querySelector('.chat-main-pane'),
      pane.maximized ? main?.parentElement?.querySelector(':scope > .left-rail') : null]
      .filter(Boolean).map((element) => ({ element, hadInert: element.hasAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') }))
    for (const { element } of targets) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
    let restored = false
    const restore = () => {
      if (restored) return
      restored = true
      for (const { element, hadInert, ariaHidden } of targets) {
        if (!hadInert) element.removeAttribute('inert')
        if (ariaHidden == null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      }
      if (restoreChatInteractionRef.current === restore) restoreChatInteractionRef.current = null
    }
    restoreChatInteractionRef.current = restore
    if (!paneRef.current?.contains(activeElement)) {
      if (activeElement && activeElement !== document.body && typeof activeElement.focus === 'function') {
        returnFocusRef.current = activeElement
      }
      paneRef.current?.querySelector('[data-testid="preview-back-to-chat"]')?.focus({ preventScroll: true })
    }
    return restore
  }, [pane.overlay, pane.maximized])

  // "Request changes" names the file in the composer and puts the reader there;
  // a pane covering the conversation steps aside first so the composer is seen.
  const requestChange = useCallback((file) => {
    if (typeof onInsertText !== 'function') return
    const reference = String(file?.path || file?.filename || '').trim()
    if (!reference) return
    if (pane.overlay) closePane()
    onInsertText(`\`${reference}\` `)
    requestAnimationFrame(() => {
      const composer = document.querySelector('[data-testid="chat-composer-surface"] textarea:not(:disabled)')
      if (!composer) return
      composer.focus({ preventScroll: true })
      composer.selectionStart = composer.value.length
      composer.selectionEnd = composer.value.length
    })
  }, [closePane, onInsertText, pane.overlay])

  const selectTab = useCallback((tabId) => {
    onActivateTab?.(tabId)
  }, [onActivateTab])

  const closeTab = useCallback((tabId) => {
    if (typeof onCloseTab !== 'function') {
      closePane()
      return
    }
    focusActiveTabRef.current = tabState.tabs.length > 1
    if (tabState.tabs.length === 1) {
      restoreChatInteractionRef.current?.()
      restoreTriggerFocus()
    }
    onCloseTab(tabId)
  }, [closePane, onCloseTab, restoreTriggerFocus, tabState.tabs.length])

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
        focused={pane.overlay}
        setMaximized={pane.setMaximized}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onClose={closePane}
        t={t}
      />
      {activeArtifact.directFile ? (
        <DirectFileContent key={activeTab.id} file={activeArtifact.directFile} pane={pane} onRequestChange={onInsertText ? requestChange : null} t={t} />
      ) : activeArtifact.preview ? (
        <PreviewContent tabId={activeTab.id} preview={activeArtifact.preview} content={activeArtifact.content} pane={pane} onMessage={onMessage} t={t} />
      ) : (
        <UnsupportedPreview t={t} />
      )}
    </PreviewShell>
  )
}

function DirectFileContent({ file, pane, onRequestChange, t }) {
  const zoom = usePreviewZoomState()
  const filename = String(file?.filename || file?.title || 'artifact')
  const extension = String(filename.split('.').pop() || '').toLowerCase()
  const rawType = String(file?.type || extension || 'file').toLowerCase()
  const type = rawType.includes('/') ? (extension || rawType.split('/').pop()) : rawType
  const downloadUrl = file?.url ? withDownloadToken(file.url) : ''
  const previewUrl = withArtifactPreviewMode(downloadUrl)
  return (
    <PreviewZoomProvider value={zoom}>
      <DirectFileToolbar filename={filename} type={type} file={file} url={downloadUrl} view={pane.view} setView={pane.setView} submenuFlipped={pane.overlay} onRequestChange={onRequestChange} zoom={zoom} t={t} />
      <div className="chat-direct-file-content min-h-0 flex-1 overflow-hidden" data-testid="direct-file-content">
        {previewUrl ? (
          <PreviewRendererBoundary key={previewUrl} filename={filename} t={t}>
            <DirectFilePreview file={{ ...file, filename, type }} url={previewUrl} view={pane.view} t={t} />
          </PreviewRendererBoundary>
        ) : (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText className="h-10 w-10 text-ink-fade" />
            <p className="max-w-xs text-sm font-medium text-ink-soft">{filename}</p>
          </div>
        )}
      </div>
    </PreviewZoomProvider>
  )
}

function PreviewContent({ tabId, preview, content, pane, onMessage, t }) {
  const exports = useArtifactExports({ preview, content, onMessage, t })
  return (
    <>
      <PreviewToolbar preview={preview} content={content} view={pane.view} setView={pane.setView} exports={exports} t={t} />
      <div data-testid="preview-scroll-region" className="chat-preview-scroll-region min-h-0 flex-1 overflow-hidden overscroll-contain">
        <PreviewRendererBoundary key={tabId} filename={preview?.filename || preview?.title || ''} t={t}>
          <PreviewBody preview={preview} content={content} view={pane.view} t={t} />
        </PreviewRendererBoundary>
      </div>
    </>
  )
}

/**
 * Renderers parse untrusted files (docx/xlsx/pptx packages); one that throws
 * while rendering fails inside the pane instead of unmounting the chat route.
 * The header, tabs and toolbar sit outside it and stay usable. Keyed by tab by
 * the caller, so another tab starts with a fresh boundary; retry remounts.
 */
function PreviewRendererBoundary({ children, filename, t }) {
  return (
    <ErrorBoundary renderFallback={({ reset }) => (
      <div data-testid="preview-renderer-crashed" className="h-full">
        <PreviewStatus
          icon={<AlertCircle className="h-6 w-6" />}
          text={filename || t('chatPreview.previewFailed')}
          detail={t('chatPreview.rendererCrashed')}
          action={<RetryPreviewButton onClick={reset} t={t} />}
        />
      </div>
    )}>
      {children}
    </ErrorBoundary>
  )
}

function PreviewShell({ children, onClose, pane, paneRef, shellKey, t, testId }) {
  return (
    <AnimatePresence>
      <motion.div key="preview-backdrop" data-testid="preview-backdrop" data-preview-overlay={pane.overlay} aria-hidden="true" onClick={onClose} className="chat-preview-backdrop absolute inset-0 z-30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} />
      <motion.aside
        ref={paneRef}
        key={shellKey}
        data-testid={testId}
        data-artifact-surface="preview"
        data-preview-layout={pane.maximized ? 'maximized' : pane.focused ? 'focused' : 'split'}
        aria-label={t('chatPreview.preview')}
        onTouchStart={pane.handleTouchStart}
        onTouchMove={pane.handleTouchMove}
        onTouchEnd={pane.handleTouchEnd}
        initial={{ x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 32, opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={pane.overlay ? undefined : { width: `${pane.paneWidth}px` }}
        className={`chat-preview-pane ${pane.maximized ? 'chat-preview-pane-maximized fixed inset-0 w-screen' : pane.focused ? 'chat-preview-pane-focused absolute inset-0 w-full' : 'relative shrink-0'} z-40 flex h-full min-w-0 flex-col overflow-hidden border-l border-ink/10 bg-paper`}
      >
        {!pane.overlay && (
          <div
            role="separator"
            tabIndex={0}
            data-testid="preview-resize-handle"
            aria-label={t('chatPreview.resize')}
            aria-orientation="vertical"
            aria-valuemin={MIN_PREVIEW_PANE_WIDTH}
            aria-valuemax={pane.maxPaneWidth}
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
