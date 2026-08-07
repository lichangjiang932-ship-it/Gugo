import { useMemo, useRef } from 'react'
import { buildHtmlPreview } from '../../../lib/presentationExport.js'
import { buildHtmlDocument, isHtmlDeckLike } from '../../../lib/artifactPreview.js'
import { useT } from '../../../i18n/I18nProvider.jsx'

export function HtmlPreview({ html }) {
  const { t } = useT()
  const srcDoc = useMemo(() => buildHtmlDocument(html), [html])
  const iframeRef = useRef(null)
  const isDeck = useMemo(() => isHtmlDeckLike(html), [html])
  const sendDeckCommand = (type) => iframeRef.current?.contentWindow?.postMessage({ type }, '*')
  return <div className={`relative w-full h-full ${isDeck ? 'html-deck-stage' : ''}`}><iframe ref={iframeRef} title={t('chatPreview.htmlTitle')} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={srcDoc} className={isDeck ? 'html-deck-frame border-0 bg-white' : 'w-full h-full border-0 bg-white'} />{isDeck && <div className="absolute left-3 bottom-3 z-10 flex items-center gap-1 rounded-full border border-ink-fade/30 bg-paper/85 p-1 shadow-sm backdrop-blur"><button type="button" onClick={() => sendDeckCommand('yma-deck-prev')} className="h-7 px-2 rounded-full text-xs text-ink-soft hover:bg-paper-2 hover:text-ember" title={t('chatPreview.previousPage')}>{t('chatPreview.previousPage')}</button><button type="button" onClick={() => sendDeckCommand('yma-deck-next')} className="h-7 px-2 rounded-full text-xs text-ink-soft hover:bg-paper-2 hover:text-ember" title={t('chatPreview.nextPage')}>{t('chatPreview.nextPage')}</button></div>}</div>
}

export function PptxPreview({ content }) {
  const { t } = useT()
  const srcDoc = useMemo(() => buildHtmlPreview(content), [content])
  return <iframe title={t('chatPreview.pptTitle')} srcDoc={srcDoc} className="w-full h-full border-0" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />
}

export function DocxPreview({ blocks, title }) {
  return <div className="overflow-auto h-full bg-paper"><div className="max-w-[720px] mx-auto px-10 py-8"><div className="font-display text-3xl text-ink leading-tight mb-6 break-words">{title}</div><div className="space-y-3 text-sm text-ink-soft leading-relaxed">{blocks.map((block, index) => <DocumentBlock key={`${index}-${block.text}`} block={block} />)}</div></div></div>
}

function DocumentBlock({ block }) {
  if (block.type === 'heading' || block.type === 'title') return <div className="pt-3 font-semibold text-ink text-base break-words">{block.text}</div>
  if (block.type === 'bullet') return <div className="grid grid-cols-[14px_1fr] gap-1.5"><span className="text-ember">•</span><span className="break-words">{block.text}</span></div>
  return <p className="break-words">{block.text}</p>
}

export function XlsxPreview({ rows }) {
  const header = rows[0] || []
  const body = rows.slice(1)
  return <div className="overflow-auto h-full bg-paper"><table className="min-w-full border-collapse text-xs"><thead><tr><th className="sticky top-0 left-0 z-20 bg-paper-2 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono">#</th>{header.map((cell, index) => <th key={`${index}-${cell}`} className="sticky top-0 z-10 bg-paper-2 border-b border-r border-ink-fade/30 px-3 py-1.5 text-left font-semibold text-ink whitespace-nowrap">{cell || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={`${rowIndex}-${row.join('|')}`} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}><td className="sticky left-0 z-10 bg-paper-2/60 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono text-right">{rowIndex + 1}</td>{header.map((_, cellIndex) => <td key={cellIndex} className="border-b border-r border-ink-fade/20 px-3 py-1.5 text-ink-soft max-w-[260px] truncate" title={row[cellIndex] || ''}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>
}

export function SourceView({ content }) {
  return <pre className="h-full overflow-auto bg-paper p-4 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap font-mono">{content}</pre>
}
