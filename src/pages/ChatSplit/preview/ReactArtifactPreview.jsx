import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { buildReactSandboxDoc } from './reactSandboxDocument.js'

export default function ReactArtifactPreview({ code }) {
  const { t } = useT()
  const [reloadTick, setReloadTick] = useState(0)
  const labels = useMemo(() => ({ title: t('chatPreview.reactTitle'), loading: t('chatPreview.reactLoading'), runtimeError: t('chatPreview.runtimeError'), promiseError: t('chatPreview.promiseError'), missingDefault: t('chatPreview.missingDefault'), compileFailed: t('chatPreview.compileFailed'), dependencyTimeout: t('chatPreview.dependencyTimeout') }), [t])
  const srcDoc = useMemo(() => buildReactSandboxDoc(code, labels), [code, labels, reloadTick]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="relative w-full h-full"><iframe key={reloadTick} title={t('chatPreview.reactTitle')} srcDoc={srcDoc} sandbox="allow-scripts allow-forms" csp="default-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:;" referrerPolicy="no-referrer" className="w-full h-full border-0 bg-white"/><button type="button" onClick={() => setReloadTick((value) => value + 1)} title={t('chatPreview.reloadSandbox')} className="absolute top-2 right-2 w-8 h-8 rounded-md bg-paper-2/90 border border-ink-fade/40 text-ink-fade hover:text-ember flex items-center justify-center"><RefreshCw className="w-3.5 h-3.5"/></button></div>
}
