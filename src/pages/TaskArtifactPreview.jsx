import { useState } from 'react'
import { X, Download, FileText, Table2, Presentation, Code2, Globe, Loader2 } from 'lucide-react'
import { withDownloadToken } from '../lib/jobClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

function TypeIcon({ type }) {
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'docx') return <FileText className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  if (type === 'html') return <Globe className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

/**
 * TaskRunPanel 专用预览面板。
 * 服务端落盘的 artifact 只有 url(无内联 source),所以策略:
 *   - html: iframe 直接加载 url(带 query token),sandbox 限制脚本
 *   - 其它(pptx/docx/xlsx): 不强求预览,渲染元数据卡片 + 醒目的下载按钮
 * 不复用 ChatSplit/RightPreviewPane — 它依赖 artifact.preview.source。
 */
export default function TaskArtifactPreview({ artifact, onClose }) {
  const { t } = useT()
  // artifact 切换会用 key 强制 remount,所以这里 useState(true) 初始 + iframe onLoad 翻 false 就够,
  // 不需要 effect(否则触发 react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true)

  if (!artifact) return null

  const downloadUrl = withDownloadToken(artifact.url)
  const isInlineHtml = artifact.type === 'html'

  return (
    <aside
      className="border-l border-dashed border-ink-fade/40 bg-paper flex flex-col min-w-0"
      style={{ width: 460 }}
      aria-label={t('artifact.taskPreview')}
    >
      <header className="px-4 py-3 border-b border-dashed border-ink-fade/40 flex items-center gap-2">
        <TypeIcon type={artifact.type} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink truncate">{artifact.title || artifact.filename || t('artifact.unnamed')}</p>
          <p className="font-mono text-[10px] text-ink-fade uppercase tracking-wider">
            {artifact.type || 'file'} · {artifact.filename || '—'}
          </p>
        </div>
        <a
          href={downloadUrl}
          download={artifact.filename || ''}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md bg-ember text-paper text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          {t('artifact.download')}
        </a>
        <button
          onClick={onClose}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-ink/20 text-ink-soft"
          aria-label={t('artifact.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isInlineHtml ? (
          <iframe
            title={t('artifact.previewTitle', { title: artifact.title || '' })}
            src={downloadUrl}
            // SECURITY: 与 ChatSplit/RightPreviewPane 同款 — 不加 allow-same-origin
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0 bg-white"
            onLoad={() => setLoading(false)}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-ink-soft">
            <TypeIcon type={artifact.type} />
            <p className="text-sm">
              {artifact.type === 'pptx' && t('artifact.pptxHint')}
              {artifact.type === 'docx' && t('artifact.docxHint')}
              {artifact.type === 'xlsx' && t('artifact.xlsxHint')}
              {!['pptx', 'docx', 'xlsx'].includes(artifact.type) && t('artifact.unsupportedHint')}
            </p>
            <a
              href={downloadUrl}
              download={artifact.filename || ''}
              className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md bg-ink text-paper text-sm"
            >
              <Download className="w-4 h-4" />
              {t('artifact.download')} {artifact.filename || ''}
            </a>
          </div>
        )}
        {loading && isInlineHtml && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-ink-fade" />
          </div>
        )}
      </div>
    </aside>
  )
}
