import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, Copy, Maximize2, Minimize2, Code, Eye, FileText, Table2, Presentation, Globe, Sparkles, Code2, RefreshCw, GitBranch, Zap } from 'lucide-react'
import {
  buildPresentationFilename, downloadPptxFromMarkdown, downloadPremiumPptx, parseMarkdownSlides, buildHtmlPreview,
} from '../../lib/presentationExport.js'
import {
  buildOfficeFilename, downloadDocxFromMarkdown, downloadXlsxFromMarkdown, parseMarkdownDocument, parseSpreadsheetRows,
} from '../../lib/officeExport.js'
import { buildHtmlDocument } from '../../lib/artifactPreview.js'
import { downloadHtmlDeckAsPptx } from '../../lib/htmlSlidesToPptx.js'

function ArtifactIcon({ type }) {
  if (type === 'html') return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  if (type === 'mermaid') return <GitBranch className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

function HtmlPreview({ html }) {
  const srcDoc = useMemo(() => buildHtmlDocument(html), [html])
  return (
    <iframe
      title="HTML Preview"
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="w-full h-full border-0 bg-white"
    />
  )
}

function PptxPreview({ content }) {
  const srcDoc = useMemo(() => buildHtmlPreview(content), [content])
  return (
    <iframe
      title="PPT Preview"
      srcDoc={srcDoc}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
    />
  )
}

function DocxPreview({ blocks, title }) {
  return (
    <div className="overflow-auto h-full bg-paper">
      <div className="max-w-[720px] mx-auto px-10 py-8">
        <div className="font-display text-3xl text-ink leading-tight mb-6 break-words">{title}</div>
        <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
          {blocks.map((block, index) => {
            if (block.type === 'heading' || block.type === 'title') {
              return <div key={index} className="pt-3 font-semibold text-ink text-base break-words">{block.text}</div>
            }
            if (block.type === 'bullet') {
              return (
                <div key={index} className="grid grid-cols-[14px_1fr] gap-1.5">
                  <span className="text-ember">•</span>
                  <span className="break-words">{block.text}</span>
                </div>
              )
            }
            return <p key={index} className="break-words">{block.text}</p>
          })}
        </div>
      </div>
    </div>
  )
}

function XlsxPreview({ rows }) {
  const header = rows[0] || []
  const body = rows.slice(1)
  return (
    <div className="overflow-auto h-full bg-paper">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 bg-paper-2 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono">#</th>
            {header.map((cell, index) => (
              <th key={index} className="sticky top-0 z-10 bg-paper-2 border-b border-r border-ink-fade/30 px-3 py-1.5 text-left font-semibold text-ink whitespace-nowrap">
                {cell || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}>
              <td className="sticky left-0 z-10 bg-paper-2/60 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono text-right">{rowIndex + 1}</td>
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="border-b border-r border-ink-fade/20 px-3 py-1.5 text-ink-soft max-w-[260px] truncate" title={row[cellIndex] || ''}>
                  {row[cellIndex] || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MermaidPreview({ code }) {
  const containerRef = useRef(null)
  const [svg, setSvg] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        const mermaidModule = await import('mermaid')
        const mermaid = mermaidModule.default || mermaidModule
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        const id = 'mermaid-' + Math.random().toString(36).slice(2, 10)
        const { svg: svgCode } = await mermaid.render(id, code)
        if (!cancelled) { setSvg(svgCode); setError(null) }
      } catch (err) {
        if (!cancelled) { setError(err.message || '渲染失败'); setSvg(null) }
      }
    }
    render()
    return () => { cancelled = true }
  }, [code])

  if (svg) {
    return (
      <div className="w-full h-full overflow-auto bg-paper-dark p-6 flex items-start justify-center">
        <div ref={containerRef} className="rounded-xl overflow-hidden shadow-lg" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    )
  }
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-paper-dark p-6">
      <GitBranch className="w-10 h-10 text-ink-fade/30 mb-3" />
      {error ? (
        <>
          <p className="text-sm text-red-400 mb-2">Mermaid 渲染错误</p>
          <pre className="text-[11px] text-ink-fade/60 font-mono max-w-[400px] whitespace-pre-wrap">{error}</pre>
        </>
      ) : (
        <p className="text-sm text-ink-fade animate-breathe">渲染中…</p>
      )}
    </div>
  )
}

function SourceView({ content, language = '' }) {
  const lines = content.split('\n')
  return (
    <div className="h-full overflow-auto bg-paper-dark">
      <pre className="text-xs leading-relaxed font-mono">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="inline-block w-12 text-right pr-3 text-ink-ghost/40 select-none shrink-0">{i + 1}</span>
            <span className="text-ink-soft whitespace-pre">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

function buildReactSandboxDoc(code) {
  const safe = String(code || '').replace(/<\/script>/gi, '<\\/script>')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>React Sandbox</title>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js" crossorigin></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body,#root{margin:0;padding:0;min-height:100vh;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  #__err{position:fixed;top:0;left:0;right:0;background:#FEE2E2;color:#7F1D1D;padding:10px 14px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;border-bottom:1px solid #FCA5A5;white-space:pre-wrap;z-index:99999;display:none;max-height:50vh;overflow:auto}
  #__loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:13px}
</style>
</head>
<body>
<div id="__err"></div>
<div id="root"><div id="__loading">编译中…</div></div>
<script id="__usercode" type="text/babel" data-presets="react,env" data-type="module">
${safe}
</script>
<script>
(function(){
  function showErr(msg){var box=document.getElementById('__err');box.textContent=String(msg);box.style.display='block';}
  window.addEventListener('error',function(e){showErr('运行错误: '+(e?.error?.stack||e?.message||e));});
  window.addEventListener('unhandledrejection',function(e){showErr('Promise 错误: '+(e?.reason?.stack||e?.reason||e));});
  function boot(){
    try {
      var src=document.getElementById('__usercode').textContent;
      var rewritten=src.replace(/export\s+default\s+/m,'var __default = ');
      var compiled=Babel.transform(rewritten,{presets:['react',['env',{modules:false}]]}).code;
      var loading=document.getElementById('__loading');if(loading)loading.remove();
      var React=window.React,ReactDOM=window.ReactDOM;
      var useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,useCallback=React.useCallback;
      var __default;eval(compiled+'\n;');
      if(!__default){showErr('未找到 export default 组件');return;}
      var root=ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(__default));
    } catch(err){showErr('编译/执行失败: '+(err&&err.stack?err.stack:err));}
  }
  if(window.Babel)boot();
  else{var t=0,timer=setInterval(function(){t+=50;if(window.Babel){clearInterval(timer);boot();}else if(t>8000){clearInterval(timer);showErr('依赖加载超时');}},50);}
})();
</script>
</body></html>`
}

function ReactPreview({ code }) {
  const [reloadTick, setReloadTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => buildReactSandboxDoc(code), [code, reloadTick])
  return (
    <div className="relative w-full h-full">
      <iframe
        key={reloadTick}
        title="React Sandbox"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="w-full h-full border-0 bg-white"
      />
      <button
        onClick={() => setReloadTick((k) => k + 1)}
        title="Reload sandbox"
        className="absolute top-3 right-3 h-8 px-3 rounded-lg bg-paper-2/90 border border-ink-fade/30 text-ink-fade hover:text-ember hover:border-ember/50 flex items-center gap-1.5 transition-colors backdrop-blur text-[11px] shadow-sm"
      >
        <RefreshCw className="w-3 h-3" />
        刷新
      </button>
    </div>
  )
}

export default function RightPreviewPane({ artifact, onClose, onMessage }) {
  const [view, setView] = useState('preview')
  const [downloading, setDownloading] = useState(false)
  const [premiumExporting, setPremiumExporting] = useState(false)
  const [premiumProgress, setPremiumProgress] = useState('')
  const [maximized, setMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState(520)

  if (!artifact) return null
  const { preview, content } = artifact

  const handleDownload = async () => {
    if (downloading || premiumExporting) return
    setDownloading(true)
    try {
      const title = preview.title || preview.filename || 'artifact'
      if (preview.type === 'pptx') {
        await downloadPptxFromMarkdown(content, { title, filename: buildPresentationFilename(title) })
      } else if (preview.type === 'docx') {
        await downloadDocxFromMarkdown(content, { title, filename: buildOfficeFilename(title, 'docx') })
      } else if (preview.type === 'xlsx') {
        await downloadXlsxFromMarkdown(content, { title, filename: buildOfficeFilename(title, 'xlsx') })
      } else if (preview.type === 'html') {
        const blob = new Blob([buildHtmlDocument(preview.html)], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = preview.filename
        document.body.appendChild(a); a.click()
        setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 100)
      } else if (preview.type === 'react' || preview.type === 'mermaid') {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = preview.filename
        document.body.appendChild(a); a.click()
        setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 100)
      }
    } catch (err) {
      onMessage?.(err.message || '导出失败')
    } finally {
      setDownloading(false)
    }
  }

  const handlePremiumDownload = async () => {
    if (preview.type !== 'pptx') return
    setPremiumExporting(true)
    try {
      const slides = parseMarkdownSlides(content)
      const title = slides[0]?.title || preview.title
      await downloadPremiumPptx(content, {
        title, filename: buildPresentationFilename(title).replace('.pptx', '_premium.pptx'),
        onProgress: (c, t) => setPremiumProgress(`${c}/${t}`),
      })
    } catch (err) { onMessage?.(err.message || '高级导出失败') }
    finally { setPremiumExporting(false); setPremiumProgress('') }
  }

  const handleHtmlToPptx = async () => {
    if (preview.type !== 'html') return
    setPremiumExporting(true)
    try {
      const title = (preview.title || preview.filename || 'presentation').replace(/\.html$/i, '')
      await downloadHtmlDeckAsPptx(buildHtmlDocument(preview.html), {
        title, filename: buildPresentationFilename(title),
        onProgress: (c, t) => setPremiumProgress(`${c}/${t}`),
      })
    } catch (err) { onMessage?.(err.message || '转 PPTX 失败') }
    finally { setPremiumExporting(false); setPremiumProgress('') }
  }

  const showMermaid = preview.type === 'mermaid'

  return (
    <AnimatePresence>
      <motion.div
        key="preview-pane"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        style={maximized ? undefined : { width: `${paneWidth}px` }}
        className={`${maximized ? 'fixed inset-0 z-40 w-screen' : ''} bg-paper-2 flex flex-col border-l border-ink-fade/20 overflow-hidden relative shadow-xl`}
      >
        {/* Resize Handle */}
        {!maximized && (
          <div
            onDoubleClick={() => setPaneWidth(520)}
            title="双击重置宽度"
            className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-ember/40 transition-colors"
            aria-hidden="true"
          />
        )}

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-fade/10 bg-paper/80 backdrop-blur-md">
          <div className="w-8 h-8 rounded-lg border border-ink-fade/20 bg-paper-2 flex items-center justify-center text-ember shrink-0">
            <ArtifactIcon type={preview.type} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-ember">{preview.label}</span>
              <span className="text-[11px] text-ink-fade truncate">{preview.summary}</span>
            </div>
            <div className="font-semibold text-ink text-sm truncate" title={preview.filename}>{preview.filename}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setMaximized((v) => !v)} className="w-7 h-7 rounded-lg hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-ink" title={maximized ? '还原' : '最大化'}>
              {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-red-500" title="关闭预览">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-ink-fade/10 bg-paper-2/50">
          <div className="inline-flex rounded-lg overflow-hidden border border-ink-fade/20 text-[11px] bg-paper/60">
            <button onClick={() => setView('preview')} className={`px-3 py-1.5 inline-flex items-center gap-1.5 transition-all ${view === 'preview' ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-2/60'}`}>
              <Eye className="w-3 h-3" />
              预览
            </button>
            <button onClick={() => setView('source')} className={`px-3 py-1.5 inline-flex items-center gap-1.5 transition-all border-l border-ink-fade/15 ${view === 'source' ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-2/60'}`}>
              <Code className="w-3 h-3" />
              源码
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => navigator.clipboard?.writeText(content)} className="h-7 px-2.5 rounded-lg border border-ink-fade/20 text-ink-soft hover:bg-paper transition-colors inline-flex items-center gap-1 text-[11px]" title="复制源内容">
              <Copy className="w-3 h-3" />
              复制
            </button>
            {preview.type === 'pptx' && (
              <button onClick={handlePremiumDownload} disabled={premiumExporting} className="h-7 px-2.5 rounded-lg border border-ember/30 text-ember hover:bg-ember-soft transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50" title="高级导出：截图生成高清 PPT">
                <Sparkles className="w-3 h-3" />
                {premiumExporting ? premiumProgress : '高级'}
              </button>
            )}
            {preview.type === 'html' && (
              <button onClick={handleHtmlToPptx} disabled={premiumExporting || downloading} className="h-7 px-2.5 rounded-lg border border-ink-fade/20 text-ink-soft hover:bg-paper hover:text-ember transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50" title="HTML 转 PPTX">
                <Presentation className="w-3 h-3" />
                {premiumExporting ? premiumProgress : '转 PPTX'}
              </button>
            )}
            <button onClick={handleDownload} disabled={downloading || premiumExporting} className="h-7 px-3 rounded-lg bg-ember text-paper hover:bg-ember/90 transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50 shadow-sm" title={`下载 ${preview.filename}`}>
              <Download className="w-3 h-3" />
              {downloading ? '…' : '下载'}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {view === 'source' ? (
            <SourceView content={content} language={preview.type} />
          ) : (
            <>
              {preview.type === 'html' && <HtmlPreview html={preview.html} />}
              {preview.type === 'pptx' && <PptxPreview content={content} />}
              {preview.type === 'docx' && <DocxPreview blocks={preview.blocks} title={preview.title} />}
              {preview.type === 'xlsx' && <XlsxPreview rows={preview.rows} />}
              {preview.type === 'react' && <ReactPreview code={content} />}
              {preview.type === 'mermaid' && <MermaidPreview code={content} />}
              {showMermaid && view === 'preview' && !content && (
                <div className="w-full h-full flex items-center justify-center bg-paper-dark">
                  <p className="text-ink-fade">无效的 Mermaid 图表</p>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
