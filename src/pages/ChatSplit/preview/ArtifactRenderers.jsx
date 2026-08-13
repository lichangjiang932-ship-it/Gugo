import { useMemo, useRef } from 'react'
import { buildHtmlPreview } from '../../../lib/presentationExport.js'
import { buildHtmlDocument, isHtmlDeckLike } from '../../../lib/artifactPreview.js'
import { useT } from '../../../i18n/I18nProvider.jsx'

function currentDocumentNonce() {
  if (typeof document === 'undefined') return ''
  return document.querySelector('script[nonce]')?.nonce || ''
}

export function HtmlPreview({ html, previewType }) {
  const { t } = useT()
  const nonce = useMemo(() => currentDocumentNonce(), [])
  const srcDoc = useMemo(
    () => buildHtmlDocument(html, { nonce, previewType }),
    [html, nonce, previewType],
  )
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
  return <div className="chat-document-stage h-full overflow-auto p-5 sm:p-8"><div className="chat-document-page mx-auto min-h-full max-w-[760px] rounded-sm border border-ink/10 bg-paper px-8 py-10 shadow-sm sm:px-12"><div className="mb-7 break-words font-display text-3xl leading-tight text-ink">{title}</div><div className="space-y-3 text-sm leading-relaxed text-ink-soft">{blocks.map((block, index) => <DocumentBlock key={`${index}-${block.text}`} block={block} />)}</div></div></div>
}

function DocumentBlock({ block }) {
  if (block.type === 'heading' || block.type === 'title') return <div className="pt-3 font-semibold text-ink text-base break-words">{block.text}</div>
  if (block.type === 'bullet') return <div className="grid grid-cols-[14px_1fr] gap-1.5"><span className="text-ember">•</span><span className="break-words">{block.text}</span></div>
  return <p className="break-words">{block.text}</p>
}

export function XlsxPreview({ rows }) {
  const header = rows[0] || []
  const body = rows.slice(1)
  return <div className="h-full overflow-auto bg-paper"><table className="min-w-full border-collapse text-xs"><thead><tr><th className="sticky left-0 top-0 z-20 border-b border-r border-ink-fade/30 bg-paper-2 px-2 py-2 font-mono text-[10px] text-ink-fade">#</th>{header.map((cell, index) => <th key={`${index}-${cell}`} className="sticky top-0 z-10 whitespace-nowrap border-b border-r border-ink-fade/30 bg-paper-2 px-3 py-2 text-left font-semibold text-ink shadow-[0_1px_0_rgb(var(--color-ink-rgb)/0.04)]">{cell || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={`${rowIndex}-${row.join('|')}`} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}><td className="sticky left-0 z-10 border-b border-r border-ink-fade/30 bg-paper-2/90 px-2 py-2 text-right font-mono text-[10px] text-ink-fade">{rowIndex + 1}</td>{header.map((_, cellIndex) => <td key={cellIndex} className="max-w-[260px] truncate border-b border-r border-ink-fade/20 px-3 py-2 text-ink-soft" title={row[cellIndex] || ''}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>
}

export function SourceView({ content }) {
  return <pre className="h-full overflow-auto bg-paper p-4 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap font-mono">{content}</pre>
}
