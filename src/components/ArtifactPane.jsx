import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Download, Maximize2, Minimize2, AlertTriangle, Loader2 } from 'lucide-react'
import { getAuthToken } from '../lib/accountClient'

/**
 * ArtifactPane · P3 右栏 .pptx 预览
 *
 * P3 升级:
 *   - 优先走 /api/artifacts/:file/render?page=N 拿真 PNG 版式图 (libreoffice + pdftoppm)
 *   - 缩略图列与大图都用 <img>; 加载中显骨架屏 shimmer
 *   - 渲染 503 或单页 4xx/5xx → fallback 到文字摘要卡 (P2 行为)
 *   - 下载按钮走 /api/artifacts/:file?token=...; 浏览器原生下载
 *   - Esc: 全屏先退 → 再关闭
 *
 * artifact.pages 传入时直接用 (兼容 mock / 测试)
 */
export default function ArtifactPane({
  artifact,
  onClose,
  onDownload,
}) {
  // slides JSON (文字摘要)
  const [fetchResult, setFetchResult] = useState({ file: null, state: 'idle', slides: null, error: '' })
  // render 能否用
  const [renderAvail, setRenderAvail] = useState({ file: null, state: 'unknown', missing: [] })
  // 选中页
  const [activeId, setActiveId] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  const abortRef = useRef(null)

  const file = artifact?.file
  const shouldFetch =
    typeof file === 'string' &&
    file.toLowerCase().endsWith('.pptx') &&
    !(Array.isArray(artifact?.pages) && artifact.pages.length > 0)

  useEffect(() => {
    if (!shouldFetch) return undefined
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const token = getAuthToken()
    const auth = token ? { Authorization: `Bearer ${token}` } : undefined

    // 注: 不在 effect 同步 setState 走 'loading' 标记 —— 派生 loadState 已通过
    // fetchResult.file !== file 自然兜底为 'loading' (见下面 sameFile 判断).
    // 异步 setState 走 .then() 内, 不触发 cascading render lint warn.

    // 1) slides 文字摘要 (主线, 拿页数 + 标题 + 文字)
    fetch(`/api/artifacts/${encodeURIComponent(file)}/slides`, { headers: auth, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`
          try { const j = await r.json(); detail = j.error || j.detail || detail } catch { /* not json */ }
          throw new Error(detail)
        }
        return r.json()
      })
      .then((j) => {
        const slides = Array.isArray(j.slides) ? j.slides : []
        setFetchResult({ file, state: 'ok', slides, error: '' })
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        setFetchResult({ file, state: 'error', slides: null, error: err?.message || '解析失败' })
      })

    // 2) 探测 render 是否可用 —— HEAD ?page=1 快路径
    fetch(`/api/artifacts/${encodeURIComponent(file)}/render?page=1`, {
      method: 'HEAD',
      headers: auth,
      signal: ctrl.signal,
    })
      .then((r) => {
        if (r.status === 200) {
          setRenderAvail({ file, state: 'available', missing: [] })
        } else if (r.status === 503) {
          setRenderAvail({ file, state: 'unavailable', missing: [] })
        } else {
          // 404 / 413 / 500 etc —— 不能渲染, fallback 文字
          setRenderAvail({ file, state: 'unavailable', missing: [] })
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        setRenderAvail({ file, state: 'unavailable', missing: [] })
      })

    return () => ctrl.abort()
  }, [file, shouldFetch])

  const sameFile = fetchResult.file === file
  const loadState = !shouldFetch ? 'idle' : sameFile ? fetchResult.state : 'loading'
  const errorMsg = sameFile ? fetchResult.error : ''
  const remoteSlides = sameFile && fetchResult.state === 'ok' ? fetchResult.slides : null
  const canRender = renderAvail.file === file && renderAvail.state === 'available'

  const pages =
    Array.isArray(artifact?.pages) && artifact.pages.length > 0
      ? artifact.pages
      : Array.isArray(remoteSlides) && remoteSlides.length > 0
      ? remoteSlides.map((s) => ({
          id: `slide-${s.idx}`,
          idx: s.idx,
          title: s.title,
          lines: s.lines,
        }))
      : []

  const firstId = pages[0]?.id
  const knownIds = pages.map((p) => p.id)
  const effectiveActiveId = knownIds.includes(activeId) ? activeId : firstId
  if (effectiveActiveId !== activeId && firstId) {
    queueMicrotask(() => setActiveId(effectiveActiveId))
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (fullscreen) setFullscreen(false)
        else onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, onClose])

  const active = pages.find((p) => p.id === effectiveActiveId) || pages[0]

  // 渲染图 URL builder (带 token 注入 query; <img> 不能带 Authorization 头)
  const tokenForImg = canRender ? getAuthToken() : null
  const renderUrl = useMemo(() => {
    if (!canRender || !file) return null
    return (page) => {
      const u = new URLSearchParams({ page: String(page) })
      if (tokenForImg) u.set('token', tokenForImg)
      return `/api/artifacts/${encodeURIComponent(file)}/render?${u.toString()}`
    }
  }, [canRender, file, tokenForImg])

  const handleDownload = () => {
    if (!file) return
    if (typeof onDownload === 'function') {
      // 让上层决定 (测试 / 自定义) 是否拦截
      const r = onDownload(artifact)
      if (r === false) return
    }
    const params = new URLSearchParams()
    const t = getAuthToken()
    if (t) params.set('token', t)
    const url = `/api/artifacts/${encodeURIComponent(file)}${params.toString() ? `?${params}` : ''}`
    // 在同窗导航 —— 服务器返 attachment, 浏览器只下载不跳转
    window.location.href = url
  }

  return (
    <div
      data-testid="artifact-pane"
      className="h-full flex flex-col"
      style={{
        fontFamily: 'var(--p0-font-sans)',
        background: 'var(--p0-bg)',
        color: 'var(--p0-text-primary)',
        ...(fullscreen
          ? { position: 'fixed', inset: 0, zIndex: 60, background: 'var(--p0-card)' }
          : {}),
      }}
    >
      {/* 头栏 */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: '10px 14px',
          background: 'var(--p0-card)',
          borderBottom: '1px solid var(--p0-border)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onClose}
            aria-label="返回聊天"
            className="inline-flex items-center gap-1 transition-colors"
            style={{
              height: 26,
              padding: '0 8px',
              borderRadius: 'var(--p0-radius-btn)',
              border: '1px solid var(--p0-border)',
              background: 'var(--p0-card)',
              color: 'var(--p0-text-secondary)',
              fontSize: 12,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--p0-card)')}
          >
            <X className="w-3 h-3" /> 聊天
          </button>
          <span
            className="truncate"
            style={{ fontSize: 13, color: 'var(--p0-text-primary)', fontWeight: 500 }}
            title={file || ''}
          >
            {file || 'artifact'}
          </span>
          {loadState === 'loading' && (
            <span className="inline-flex items-center gap-1" style={{ fontSize: 11, color: 'var(--p0-text-tertiary)' }}>
              <Loader2 className="w-3 h-3 animate-spin" /> 解析中
            </span>
          )}
          {loadState === 'ok' && pages.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--p0-text-tertiary)' }}>
              {pages.length} 页{canRender ? ' · 版式渲染' : ' · 文字预览'}
            </span>
          )}
        </div>

        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={handleDownload}
            aria-label="下载"
            className="inline-flex items-center justify-center transition-colors"
            style={{
              width: 26, height: 26,
              borderRadius: 'var(--p0-radius-btn)',
              color: 'var(--p0-text-secondary)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            title="下载原 .pptx"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            aria-label={fullscreen ? '退出全屏' : '全屏'}
            className="inline-flex items-center justify-center transition-colors"
            style={{
              width: 26, height: 26,
              borderRadius: 'var(--p0-radius-btn)',
              color: 'var(--p0-text-secondary)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            title={fullscreen ? '退出全屏' : '全屏'}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 内容 */}
      {loadState === 'error' ? (
        <ErrorState message={errorMsg} />
      ) : loadState === 'loading' && pages.length === 0 ? (
        <LoadingState />
      ) : pages.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* 缩略图列 */}
          <div
            className="overflow-y-auto shrink-0"
            style={{
              width: 92,
              padding: 10,
              background: 'var(--p0-bg)',
              borderRight: '1px solid var(--p0-border)',
            }}
            aria-label="页面缩略图"
          >
            {pages.map((p, idx) => {
              const selected = p.id === effectiveActiveId
              const pageNum = p.idx ?? idx + 1
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveId(p.id)}
                  aria-current={selected ? 'true' : undefined}
                  className="w-full block transition-colors text-left"
                  style={{
                    marginBottom: 8,
                    padding: 4,
                    background: 'var(--p0-card)',
                    border: selected ? '2px solid var(--p0-accent)' : '1px solid var(--p0-border)',
                    borderLeftWidth: selected ? 4 : 1,
                    borderLeftColor: 'var(--p0-accent)',
                    borderRadius: 8,
                    color: 'var(--p0-text-primary)',
                    fontSize: 10,
                  }}
                >
                  <Thumb key={`${pageNum}-${renderUrl ? '1' : '0'}`} page={p} pageNum={pageNum} renderUrl={renderUrl} />
                  <div
                    className="truncate"
                    style={{ marginTop: 4, color: 'var(--p0-text-secondary)', padding: '0 2px' }}
                    title={p.title || ''}
                  >
                    {p.title || `第 ${pageNum} 页`}
                  </div>
                </button>
              )
            })}
          </div>

          {/* 大图 */}
          <div
            className="flex-1 min-w-0 flex items-center justify-center overflow-y-auto"
            style={{ padding: 20 }}
          >
            <BigSlide
              key={`big-${(active?.idx ?? (pages.findIndex((p) => p.id === effectiveActiveId) + 1))}-${renderUrl ? '1' : '0'}`}
              active={active}
              pageNum={active?.idx ?? (pages.findIndex((p) => p.id === effectiveActiveId) + 1)}
              total={pages.length}
              renderUrl={renderUrl}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Thumb({ page, pageNum, renderUrl }) {
  const url = renderUrl ? renderUrl(pageNum) : null
  const [imgState, setImgState] = useState(() => (url ? 'loading' : 'fail'))
  return (
    <div
      style={{
        aspectRatio: '4 / 3',
        background: 'var(--p0-bg)',
        borderRadius: 4,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url && imgState !== 'fail' && (
        <img
          src={url}
          alt={`第 ${pageNum} 页缩略图`}
          onLoad={() => setImgState('ok')}
          onError={() => setImgState('fail')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: imgState === 'ok' ? 'block' : 'none',
          }}
          loading="lazy"
        />
      )}
      {(imgState === 'loading' && url) && (
        <div className="p0-shimmer" style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />
      )}
      {(imgState === 'fail' || !url) && (
        <div
          style={{
            padding: 4,
            fontSize: 8,
            color: 'var(--p0-text-secondary)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: 'var(--p0-text-primary)',
              lineHeight: 1.2,
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
              overflow: 'hidden',
              fontSize: 9,
            }}
          >
            {page.title || `第 ${pageNum} 页`}
          </span>
          <span style={{ color: 'var(--p0-text-tertiary)', alignSelf: 'flex-end' }}>#{pageNum}</span>
        </div>
      )}
    </div>
  )
}

function BigSlide({ active, pageNum, total, renderUrl }) {
  const url = renderUrl ? renderUrl(pageNum) : null
  const [imgState, setImgState] = useState(() => (url ? 'loading' : 'fail'))

  if (!active) return null

  // 有版式渲染 → 展示真图 (16:9 卡同一看起)
  if (url && imgState !== 'fail') {
    return (
      <div
        className="flex flex-col"
        style={{
          width: '100%',
          maxWidth: 880,
          aspectRatio: '16 / 9',
          background: 'var(--p0-card)',
          border: '1px solid var(--p0-border)',
          borderRadius: 'var(--p0-radius-card)',
          boxShadow: 'var(--p0-shadow-card)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <img
          src={url}
          alt={`第 ${pageNum} 页`}
          onLoad={() => setImgState('ok')}
          onError={() => setImgState('fail')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#fff',
            display: imgState === 'ok' ? 'block' : 'none',
          }}
        />
        {imgState === 'loading' && (
          <div className="p0-shimmer" style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />
        )}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 12,
            fontSize: 11,
            color: 'var(--p0-text-tertiary)',
            fontFamily: 'var(--p0-font-mono)',
            background: 'rgba(255,255,255,0.85)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          {pageNum} / {total}
        </div>
      </div>
    )
  }

  // 渲染不可用 / 加载失败 → 文字摘要卡 (P2 行为)
  return <SlideTextCard active={active} pageNum={pageNum} total={total} />
}

function SlideTextCard({ active, pageNum, total }) {
  const body = Array.isArray(active.lines) ? active.lines.slice(1) : []
  return (
    <div
      className="flex flex-col"
      style={{
        width: '100%',
        maxWidth: 760,
        aspectRatio: '16 / 9',
        background: 'var(--p0-card)',
        border: '1px solid var(--p0-border)',
        borderLeft: '4px solid var(--p0-accent)',
        borderRadius: 'var(--p0-radius-card)',
        boxShadow: 'var(--p0-shadow-card)',
        padding: 32,
        color: 'var(--p0-text-primary)',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: 'var(--p0-text-tertiary)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >slide</span>
      <h2 style={{ marginTop: 8, fontSize: 28, fontWeight: 500, lineHeight: 1.25 }}>
        {active.title || '未命名页'}
      </h2>
      {body.length > 0 && (
        <ul
          style={{
            marginTop: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 14,
            color: 'var(--p0-text-secondary)',
            paddingLeft: 0,
            listStyle: 'none',
            overflow: 'hidden',
          }}
        >
          {body.slice(0, 8).map((line, i) => (
            <li key={i} style={{ lineHeight: 1.5 }}>· {line}</li>
          ))}
          {body.length > 8 && (
            <li style={{ color: 'var(--p0-text-tertiary)', fontSize: 12 }}>
              … 还有 {body.length - 8} 行, 下载查看完整版式
            </li>
          )}
        </ul>
      )}
      <div
        style={{
          marginTop: 'auto',
          fontSize: 11,
          color: 'var(--p0-text-tertiary)',
          fontFamily: 'var(--p0-font-mono)',
        }}
      >
        {pageNum} / {total} · 文字预览 (未安装 libreoffice/pdftoppm), 下载查看完整版式
      </div>
    </div>
  )
}

function LoadingState() {
  // P3: 骨架屏 shimmer (升级为 transform translateX, 不再是单行 spinner)
  return (
    <div className="flex-1 flex min-h-0">
      <div
        className="shrink-0"
        style={{
          width: 92,
          padding: 10,
          background: 'var(--p0-bg)',
          borderRight: '1px solid var(--p0-border)',
        }}
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              marginBottom: 8,
              padding: 4,
              background: 'var(--p0-card)',
              border: '1px solid var(--p0-border)',
              borderRadius: 8,
            }}
          >
            <div className="p0-shimmer" style={{ aspectRatio: '4 / 3', borderRadius: 4 }} />
            <div className="p0-shimmer" style={{ height: 8, marginTop: 6, borderRadius: 2 }} />
          </div>
        ))}
      </div>
      <div className="flex-1 min-w-0 flex items-center justify-center" style={{ padding: 20 }}>
        <div
          style={{
            width: '100%',
            maxWidth: 760,
            aspectRatio: '16 / 9',
            background: 'var(--p0-card)',
            border: '1px solid var(--p0-border)',
            borderRadius: 'var(--p0-radius-card)',
            overflow: 'hidden',
            position: 'relative',
          }}
          aria-label="加载中"
        >
          <div className="p0-shimmer" style={{ position: 'absolute', inset: 0 }} />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ message }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ padding: 24 }}>
      <div
        style={{
          maxWidth: 380,
          background: 'var(--p0-card)',
          border: '1px solid var(--p0-border)',
          borderLeft: '4px solid var(--p0-accent)',
          borderRadius: 'var(--p0-radius-card)',
          padding: 20,
          color: 'var(--p0-text-primary)',
        }}
      >
        <div className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 500 }}>
          <AlertTriangle className="w-4 h-4" style={{ color: 'var(--p0-accent)' }} />
          无法解析 .pptx
        </div>
        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--p0-text-secondary)', lineHeight: 1.5 }}>
          {message || '未知错误'}
        </p>
        <p style={{ marginTop: 12, fontSize: 11, color: 'var(--p0-text-tertiary)' }}>
          下载原始文件后用 PowerPoint / WPS / Keynote 打开通常可用.
        </p>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--p0-text-tertiary)', fontSize: 13 }}>
      此 artifact 没有可预览页面
    </div>
  )
}
