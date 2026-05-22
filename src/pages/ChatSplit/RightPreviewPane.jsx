import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, Copy, Maximize2, Minimize2, Code, Eye, FileText, Table2, Presentation, Globe, Sparkles, Code2, RefreshCw } from 'lucide-react'
import {
  buildPresentationFilename,
  downloadPptxFromMarkdown,
  downloadPremiumPptx,
  parseMarkdownSlides,
  buildHtmlPreview,
} from '../../lib/presentationExport.js'
import {
  buildOfficeFilename,
  downloadDocxFromMarkdown,
  downloadXlsxFromMarkdown,
  parseMarkdownDocument,
  parseSpreadsheetRows,
} from '../../lib/officeExport.js'
import { buildHtmlDocument, isHtmlDeckLike } from '../../lib/artifactPreview.js'
import { downloadHtmlDeckAsPptx } from '../../lib/htmlSlidesToPptx.js'

function ArtifactIcon({ type }) {
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(type)) return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

function HtmlPreview({ html }) {
  const srcDoc = useMemo(() => buildHtmlDocument(html), [html])
  const iframeRef = useRef(null)
  const isDeck = useMemo(() => isHtmlDeckLike(html), [html])
  const sendDeckCommand = (type) => {
    iframeRef.current?.contentWindow?.postMessage({ type }, '*')
  }
  return (
    <div className="relative w-full h-full">
      <iframe
        ref={iframeRef}
        title="HTML 预览"
        // SECURITY: 只给 allow-scripts + allow-forms。绝不加 allow-same-origin —
        // srcdoc 文档默认是 opaque origin,加上后会让脚本访问父页 storage/cookie + 逃逸沙箱。
        // 工件页面如需调用外部 API,通过 postMessage 让父页代理。
        sandbox="allow-scripts allow-forms"
        // 可选:再加 referrerpolicy 防泄漏来源
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="w-full h-full border-0 bg-white"
      />
      {isDeck && (
        <div className="absolute left-3 bottom-3 z-10 flex items-center gap-1 rounded-full border border-ink-fade/30 bg-paper/85 p-1 shadow-sm backdrop-blur">
          <button
            type="button"
            onClick={() => sendDeckCommand('yma-deck-prev')}
            className="h-7 px-2 rounded-full text-xs text-ink-soft hover:bg-paper-2 hover:text-ember transition-colors"
            title="上一页"
          >
            上一页
          </button>
          <button
            type="button"
            onClick={() => sendDeckCommand('yma-deck-next')}
            className="h-7 px-2 rounded-full text-xs text-ink-soft hover:bg-paper-2 hover:text-ember transition-colors"
            title="下一页"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}

function PptxPreview({ content }) {
  const srcDoc = useMemo(() => buildHtmlPreview(content), [content])
  return (
    <iframe
      title="PPT 预览"
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
              return (
                <div key={index} className="pt-3 font-semibold text-ink text-base break-words">
                  {block.text}
                </div>
              )
            }
            if (block.type === 'bullet') {
              return (
                <div key={index} className="grid grid-cols-[14px_1fr] gap-1.5">
                  <span className="text-ember">•</span>
                  <span className="break-words">{block.text}</span>
                </div>
              )
            }
            return (
              <p key={index} className="break-words">
                {block.text}
              </p>
            )
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
            <th className="sticky top-0 left-0 z-20 bg-paper-2 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono">
              #
            </th>
            {header.map((cell, index) => (
              <th
                key={index}
                className="sticky top-0 z-10 bg-paper-2 border-b border-r border-ink-fade/30 px-3 py-1.5 text-left font-semibold text-ink whitespace-nowrap"
              >
                {cell || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}>
              <td className="sticky left-0 z-10 bg-paper-2/60 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono text-right">
                {rowIndex + 1}
              </td>
              {header.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-r border-ink-fade/20 px-3 py-1.5 text-ink-soft max-w-[260px] truncate"
                  title={row[cellIndex] || ''}
                >
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

function SourceView({ content }) {
  return (
    <pre className="h-full overflow-auto bg-paper p-4 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap font-mono">
      {content}
    </pre>
  )
}

// ★ batchH H1: React 沙箱预览 — 对标 Claude artifacts / Codex preview
//   把模型生成的单文件 React 组件放进 iframe,加载 React 18 + babel-standalone
//   (内置 cdn,sandbox 仍是 allow-scripts only,不带 allow-same-origin),
//   编译后挂载到 #root.编译错误捕获后写到页面顶部红条,方便用户自己 fix prompt.
function buildReactSandboxDoc(code) {
  const safe = String(code || '')
    // 防止源里有 </script> 提前结束
    .replace(/<\/script>/gi, '<\\/script>')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>React 沙箱</title>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js" crossorigin></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body,#root{margin:0;padding:0;min-height:100vh;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  #__err{position:fixed;top:0;left:0;right:0;background:#FEE2E2;color:#7F1D1D;padding:10px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;border-bottom:1px solid #FCA5A5;white-space:pre-wrap;z-index:99999;display:none;max-height:50vh;overflow:auto}
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
  function showErr(msg){
    var box = document.getElementById('__err');
    box.textContent = String(msg);
    box.style.display = 'block';
  }
  window.addEventListener('error', function(e){ showErr('运行错误: ' + (e?.error?.stack || e?.message || e)); });
  window.addEventListener('unhandledrejection', function(e){ showErr('Promise 错误: ' + (e?.reason?.stack || e?.reason || e)); });

  function boot(){
    try {
      var src = document.getElementById('__usercode').textContent;
      // babel 把 export default 转 esm,但我们要塞回 ReactDOM.createRoot —
      // 替换为 const __default = ...
      var rewritten = src.replace(/export\\s+default\\s+/m, 'var __default = ');
      var compiled = Babel.transform(rewritten, { presets: ['react', ['env', { modules: false }]] }).code;
      // 关掉 loading
      var loading = document.getElementById('__loading');
      if (loading) loading.remove();
      // 在隔离作用域里执行,把 React/ReactDOM/hooks 注入
      var React = window.React, ReactDOM = window.ReactDOM;
      var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef,
          useMemo = React.useMemo, useCallback = React.useCallback, useReducer = React.useReducer,
          useContext = React.useContext, useLayoutEffect = React.useLayoutEffect,
          Fragment = React.Fragment, createElement = React.createElement;
      var __default;
      // eslint-disable-next-line no-eval
      eval(compiled + '\\n;');
      if (!__default) { showErr('未找到 export default 组件'); return; }
      var root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(__default));
    } catch (err) {
      showErr('编译/执行失败: ' + (err && err.stack ? err.stack : err));
    }
  }
  if (window.Babel) boot();
  else {
    var t = 0;
    var timer = setInterval(function(){
      t += 50;
      if (window.Babel) { clearInterval(timer); boot(); }
      else if (t > 8000) { clearInterval(timer); showErr('依赖加载超时,请检查网络'); }
    }, 50);
  }
})();
</script>
</body>
</html>`
}

function ReactPreview({ code }) {
  const [reloadTick, setReloadTick] = useState(0)
  // reloadTick 是故意的依赖:用户点刷新时增 1,强制 useMemo 重算,iframe 重渲染
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => buildReactSandboxDoc(code), [code, reloadTick])
  return (
    <div className="relative w-full h-full">
      <iframe
        key={reloadTick}
        title="React 沙箱"
        srcDoc={srcDoc}
        // SECURITY: 只 allow-scripts + allow-forms,不开 allow-same-origin —
        //   组件无法访问父页 storage/cookie,iframe 沙箱视为 opaque origin.
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="w-full h-full border-0 bg-white"
      />
      <button
        onClick={() => setReloadTick((k) => k + 1)}
        title="重新加载沙箱(清状态)"
        className="absolute top-2 right-2 w-8 h-8 rounded-md bg-paper-2/90 border border-ink-fade/40 text-ink-fade hover:text-ember hover:border-ember/60 flex items-center justify-center transition-colors backdrop-blur"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function RightPreviewPane({ artifact, onClose, onMessage }) {
  const [view, setView] = useState('preview') // 'preview' | 'source'
  const [downloading, setDownloading] = useState(false)
  const [premiumExporting, setPremiumExporting] = useState(false)
  const [premiumProgress, setPremiumProgress] = useState('')
  const [maximized, setMaximized] = useState(false)
  // ★ #24: 可拖拽宽度,持久化到 localStorage
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('preview-pane-width'))
      if (Number.isFinite(saved) && saved >= 360 && saved <= 900) return saved
    } catch { /* ignore */ }
    return 520
  })
  const dragStateRef = useRef(null)
  const previousArtifactKey = useRef('')

  useEffect(() => {
    try { localStorage.setItem('preview-pane-width', String(paneWidth)) } catch { /* ignore */ }
  }, [paneWidth])

  const startResize = (e) => {
    e.preventDefault()
    dragStateRef.current = { startX: e.clientX, startWidth: paneWidth }
    const onMove = (ev) => {
      if (!dragStateRef.current) return
      // pane 在右侧,向左拖 (clientX 减小) → 变宽
      const delta = dragStateRef.current.startX - ev.clientX
      const next = Math.min(900, Math.max(360, dragStateRef.current.startWidth + delta))
      setPaneWidth(next)
    }
    const onUp = () => {
      dragStateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // 切换 artifact 时复位视图状态
  useEffect(() => {
    const key = `${artifact?.messageId || ''}:${artifact?.preview?.type || ''}`
    if (key !== previousArtifactKey.current) {
      previousArtifactKey.current = key
      setView('preview')
      setDownloading(false)
    }
  }, [artifact])

  // ★ 即使 preview 解析失败也要渲染面板框架，给用户"无法预览"提示而不是静默消失
  if (!artifact) return null
  const { preview, content } = artifact
  if (!preview) {
    return (
      <AnimatePresence>
        <motion.aside className="w-full h-full border-l border-ink-fade/30 bg-paper flex flex-col items-center justify-center gap-4 text-ink-fade" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ duration: 0.2 }}>
          <FileText className="w-10 h-10 opacity-30" />
          <p className="text-sm">无法渲染预览</p>
          <p className="text-xs text-ink-fade/70 max-w-[200px] text-center">内容格式不支持预览，但你可以下载原文件或切换到源码视图查看</p>
          {onClose && (
            <button onClick={onClose} className="mt-2 h-8 px-4 border border-ink-fade/30 rounded-md text-xs hover:border-ember/50 transition-colors">关闭面板</button>
          )}
        </motion.aside>
      </AnimatePresence>
    )
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      if (preview.type === 'pptx') {
        const slides = parseMarkdownSlides(content)
        const title = slides[0]?.title || preview.title
        await downloadPptxFromMarkdown(content, {
          title,
          filename: buildPresentationFilename(title),
        })
      } else if (preview.type === 'docx') {
        const doc = parseMarkdownDocument(content)
        await downloadDocxFromMarkdown(content, {
          title: doc.title,
          filename: buildOfficeFilename(doc.title, 'docx'),
        })
      } else if (preview.type === 'xlsx') {
        const rows = parseSpreadsheetRows(content)
        const title = rows[0]?.find((cell) => String(cell || '').trim()) || preview.title
        await downloadXlsxFromMarkdown(content, {
          title,
          filename: buildOfficeFilename(title, 'xlsx'),
        })
      } else if (['html', 'html_multi', 'mermaid', 'chart'].includes(preview.type)) {
        const blob = new Blob([buildHtmlDocument(preview.html)], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = preview.filename
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          URL.revokeObjectURL(url)
          a.remove()
        }, 100)
      } else if (preview.type === 'svg') {
        const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = preview.filename
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          URL.revokeObjectURL(url)
          a.remove()
        }, 100)
      } else if (preview.type === 'react') {
        // 直接下载组件源码 .jsx
        const blob = new Blob([content], { type: 'text/jsx;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = preview.filename
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          URL.revokeObjectURL(url)
          a.remove()
        }, 100)
      }
    } catch (err) {
      // ★ #26: 统一通过外层 toast 通道,避免阻塞式 alert
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
        title,
        filename: buildPresentationFilename(title).replace('.pptx', '_premium.pptx'),
        onProgress: (current, total) => setPremiumProgress(`${current}/${total}`),
      })
    } catch (err) {
      onMessage?.(err.message || '高级导出失败')
    } finally {
      setPremiumExporting(false)
      setPremiumProgress('')
    }
  }

  // HTML 幻灯片 → 可编辑 .pptx（每页截图 + 透明文本框覆盖）
  const handleHtmlToPptx = async () => {
    if (preview.type !== 'html') return
    setPremiumExporting(true)
    try {
      const title = (preview.title || preview.filename || 'presentation').replace(/\.html$/i, '')
      const fullHtml = buildHtmlDocument(preview.html)
      await downloadHtmlDeckAsPptx(fullHtml, {
        title,
        filename: buildPresentationFilename(title),
        onProgress: (current, total) => setPremiumProgress(`${current}/${total}`),
      })
    } catch (err) {
      onMessage?.(err.message || '转 PPTX 失败')
    } finally {
      setPremiumExporting(false)
      setPremiumProgress('')
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="preview-pane"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        style={maximized ? undefined : { width: `${paneWidth}px` }}
        className={`${
          maximized ? 'fixed inset-0 z-40 w-screen' : ''
        } bg-paper-2 flex flex-col border-l border-dashed border-ink-fade/50 overflow-hidden relative`}
      >
        {/* ★ #24: 左边缘拖拽 handle (最大化时隐藏) */}
        {!maximized && (
          <div
            onMouseDown={startResize}
            onDoubleClick={() => setPaneWidth(520)}
            title="拖动调节宽度,双击重置"
            className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-ember/30 transition-colors"
            aria-hidden="true"
          />
        )}
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-dashed border-ink-fade/40 bg-paper">
          <div className="w-8 h-8 rounded-md border border-ink-fade/40 bg-paper-2 flex items-center justify-center text-ember shrink-0">
            <ArtifactIcon type={preview.type} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">
                {preview.label}
              </span>
              <span className="text-[11px] text-ink-fade truncate">{preview.summary}</span>
            </div>
            <div className="font-semibold text-ink text-sm truncate" title={preview.filename}>
              {preview.filename}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMaximized((v) => !v)}
              className="w-8 h-8 rounded-md hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
              title={maximized ? '还原' : '最大化'}
            >
              {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-md hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
              title="关闭预览"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-ink-fade/20 bg-paper-2">
          <div className="inline-flex border border-ink-fade/40 rounded-md overflow-hidden text-[11px]">
            <button
              onClick={() => setView('preview')}
              className={`px-3 py-1 inline-flex items-center gap-1.5 transition-colors ${
                view === 'preview' ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper'
              }`}
            >
              <Eye className="w-3 h-3" />
              预览
            </button>
            <button
              onClick={() => setView('source')}
              className={`px-3 py-1 inline-flex items-center gap-1.5 transition-colors border-l border-ink-fade/40 ${
                view === 'source' ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper'
              }`}
            >
              <Code className="w-3 h-3" />
              源
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => navigator.clipboard?.writeText(content)}
              className="h-7 px-2 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper transition-colors inline-flex items-center gap-1 text-[11px]"
              title="复制源内容"
            >
              <Copy className="w-3 h-3" />
              复制
            </button>
            {preview.type === 'pptx' && (
              <button
                onClick={handlePremiumDownload}
                disabled={premiumExporting}
                className="h-7 px-2 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper hover:text-ember transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50"
                title="高级导出：截图生成高清 PPT"
              >
                <Sparkles className="w-3 h-3" />
                {premiumExporting ? `截图 ${premiumProgress}` : '高级'}
              </button>
            )}
            {preview.type === 'html' && (
              <button
                onClick={handleHtmlToPptx}
                disabled={premiumExporting || downloading}
                className="h-7 px-2 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper hover:text-ember transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50"
                title="把 HTML 幻灯片转成可编辑 PPTX（每页截图 + 透明文本框）"
              >
                <Presentation className="w-3 h-3" />
                {premiumExporting ? `转换 ${premiumProgress}` : '转 PPTX'}
              </button>
            )}
            <button
              onClick={handleDownload}
              disabled={downloading || premiumExporting}
              className="h-7 px-2.5 rounded-md bg-ember text-paper hover:bg-ember/90 transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50"
              title={`下载 ${preview.filename}`}
            >
              <Download className="w-3 h-3" />
              {downloading ? '生成中' : '下载'}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {view === 'source' ? (
            <SourceView content={content} />
          ) : (
            <>
              {['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(preview.type) && <HtmlPreview html={preview.html} />}
              {preview.type === 'pptx' && <PptxPreview content={content} />}
              {preview.type === 'docx' && <DocxPreview blocks={preview.blocks} title={preview.title} />}
              {preview.type === 'xlsx' && <XlsxPreview rows={preview.rows} />}
              {preview.type === 'react' && <ReactPreview code={content} />}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
