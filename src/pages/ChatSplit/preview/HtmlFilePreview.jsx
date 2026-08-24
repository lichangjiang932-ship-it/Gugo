import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import {
  createArtifactHtmlPreviewSession,
  createLocalHtmlPreviewSession,
  revokeArtifactHtmlPreviewSession,
  revokeLocalHtmlPreviewSession,
} from '../../../lib/jobClient.js'
import {
  PreviewFallbackActions,
  PreviewStatus,
  RetryPreviewButton,
} from './PreviewPrimitives.jsx'
import {
  isLocalReceiptFileUrl,
  isManagedArtifactPreviewUrl,
  issueUsableHtmlPreviewSession,
  withPreviewRetry,
} from './previewUrl.js'

export function InteractiveHtmlFilePreview({ file, t, url }) {
  if (isManagedArtifactPreviewUrl(url)) {
    return <ManagedHtmlArtifactPreview file={file} t={t} url={url} />
  }
  if (isLocalReceiptFileUrl(url)) {
    return <LocalReceiptHtmlPreview file={file} t={t} url={url} />
  }
  return <DirectHtmlUrlPreview file={file} t={t} url={url} />
}

function LocalReceiptHtmlPreview({ file, t, url }) {
  const [state, setState] = useState({ url: '', error: null })
  const [retryVersion, setRetryVersion] = useState(0)
  const retry = () => {
    setState({ url: '', error: null })
    setRetryVersion((value) => value + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let activePreviewUrl = ''
    issueUsableHtmlPreviewSession({
      createSession: ({ signal }) => createLocalHtmlPreviewSession(url, { signal }),
      revokeSession: revokeLocalHtmlPreviewSession,
      signal: controller.signal,
    }).then((previewUrl) => {
      activePreviewUrl = previewUrl
      if (disposed) {
        void revokeLocalHtmlPreviewSession(previewUrl).catch(() => {})
        return
      }
      setState({ url: previewUrl, error: null })
    }).catch((cause) => {
      if (!disposed && cause?.name !== 'AbortError') {
        setState({
          url: '',
          error: {
            code: String(cause?.code || 'LOCAL_HTML_PREVIEW_SESSION_FAILED'),
            message: String(cause?.message || ''),
            hint: String(cause?.hint || ''),
          },
        })
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (activePreviewUrl) void revokeLocalHtmlPreviewSession(activePreviewUrl).catch(() => {})
    }
  }, [retryVersion, url])

  if (state.error) {
    const serviceUnavailable = [
      'LOCAL_HTML_PREVIEW_NOT_READY',
      'LOCAL_HTML_PREVIEW_RUNTIME_MISMATCH',
      'LOCAL_HTML_PREVIEW_ROUTE_UNAVAILABLE',
    ].includes(state.error.code)
    const detailKey = serviceUnavailable
      ? 'chatPreview.localHtmlServiceUnavailable'
      : 'chatPreview.previewRetryHint'
    const structuredDetail = [state.error.message, state.error.hint]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ')
    return <PreviewStatus
      icon={<AlertCircle className="h-6 w-6" />}
      text={t('chatPreview.previewFailed')}
      detail={serviceUnavailable ? t(detailKey) : (structuredDetail || t(detailKey))}
      errorCode={state.error.code}
      action={<RetryPreviewButton onClick={retry} t={t} />}
    />
  }
  if (!state.url) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  return <DirectHtmlUrlPreview file={file} t={t} url={state.url} onRetry={retry} />
}

function ManagedHtmlArtifactPreview({ file, t, url }) {
  const [state, setState] = useState({ url: '', error: null })
  const [retryVersion, setRetryVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let activePreviewUrl = ''
    issueUsableHtmlPreviewSession({
      createSession: ({ signal }) => createArtifactHtmlPreviewSession(url, { signal }),
      revokeSession: revokeArtifactHtmlPreviewSession,
      signal: controller.signal,
    }).then((previewUrl) => {
      activePreviewUrl = previewUrl
      if (disposed) {
        void revokeArtifactHtmlPreviewSession(previewUrl).catch(() => {})
        return
      }
      setState({ url: previewUrl, error: null })
    }).catch((cause) => {
      if (!disposed && cause?.name !== 'AbortError') {
        setState({
          url: '',
          error: {
            code: String(cause?.code || 'ARTIFACT_HTML_PREVIEW_SESSION_FAILED'),
            message: String(cause?.message || cause || ''),
            hint: String(cause?.hint || ''),
          },
        })
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (activePreviewUrl) void revokeArtifactHtmlPreviewSession(activePreviewUrl).catch(() => {})
    }
  }, [retryVersion, url])

  const retry = () => {
    setState({ url: '', error: null })
    setRetryVersion((value) => value + 1)
  }
  if (state.error) {
    const detail = [state.error.message, state.error.hint]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ')
    return <PreviewStatus
      icon={<AlertCircle className="h-6 w-6" />}
      text={t('chatPreview.previewFailed')}
      detail={detail || t('chatPreview.previewRetryHint')}
      errorCode={state.error.code}
      action={<RetryPreviewButton onClick={retry} t={t} />}
    />
  }
  if (!state.url) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  return <DirectHtmlUrlPreview allowScripts file={file} t={t} url={state.url} onRetry={retry} />
}

export function DirectHtmlUrlPreview({ allowScripts = false, file, onRetry, t, timeoutMs = 5_000, url }) {
  const [attempt, setAttempt] = useState(0)
  const requestUrl = withPreviewRetry(url, attempt)
  const requestKey = `${requestUrl}:${attempt}`
  const [loadState, setLoadState] = useState({ key: '', status: 'loading' })
  const status = loadState.key === requestKey ? loadState.status : 'loading'
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadState((current) => (
        current.key === requestKey && current.status === 'ready'
          ? current
          : { key: requestKey, status: 'failed' }
      ))
    }, Math.max(0, Number(timeoutMs) || 0))
    return () => clearTimeout(timer)
  }, [requestKey, timeoutMs])

  const retry = () => {
    if (typeof onRetry === 'function') {
      onRetry()
      return
    }
    setAttempt((value) => value + 1)
  }
  return (
    <div className="relative h-full min-h-0 bg-white">
      <iframe
        key={requestKey}
        src={requestUrl}
        title={file.filename || file.title || t('chatPreview.htmlTitle')}
        sandbox={allowScripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        onLoad={() => setLoadState({ key: requestKey, status: 'ready' })}
        onError={() => setLoadState({ key: requestKey, status: 'failed' })}
        className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`}
      />
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus
        icon={<AlertCircle className="h-6 w-6" />}
        text={t('chatPreview.previewFailed')}
        detail={t('chatPreview.previewRetryHint')}
        action={<PreviewFallbackActions onRetry={retry} t={t} url={url} />}
      />}
    </div>
  )
}
