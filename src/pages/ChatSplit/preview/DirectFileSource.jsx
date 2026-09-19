import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { loadDirectFileSource } from '../../../lib/directFileSource.js'
import { SourceView } from './ArtifactRenderers.jsx'
import { PreviewStatus, RetryPreviewButton } from './PreviewPrimitives.jsx'

const SOURCE_ERROR_KEYS = {
  SOURCE_PREVIEW_TOO_LARGE: 'chatPreview.sourceTooLarge',
  SOURCE_PREVIEW_DENIED: 'chatPreview.sourceDenied',
  SOURCE_PREVIEW_MISSING: 'chatPreview.sourceMissing',
}

export default function DirectFileSource({ file, url, t }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState(null)
  const filename = file?.filename || file?.title || ''
  const type = file?.type || ''
  const mimeType = file?.mimeType || ''
  useEffect(() => {
    const controller = new AbortController()
    loadDirectFileSource({ file: { filename, type, mimeType }, url, signal: controller.signal })
      .then((text) => {
        if (!controller.signal.aborted) setState({ attempt, text })
      }, (error) => {
        if (!controller.signal.aborted) setState({ attempt, errorCode: error?.code || 'SOURCE_PREVIEW_FAILED' })
      })
    return () => controller.abort()
  }, [attempt, filename, mimeType, type, url])
  if (!state || state.attempt !== attempt) {
    return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  }
  if (state.errorCode) {
    return <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')}
      detail={t(SOURCE_ERROR_KEYS[state.errorCode] || 'chatPreview.sourceFailed')} errorCode={state.errorCode}
      action={<RetryPreviewButton onClick={() => setAttempt((current) => current + 1)} t={t} />} />
  }
  return <SourceView content={state.text} />
}
