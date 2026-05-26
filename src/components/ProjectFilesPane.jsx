import { useMemo, useState } from 'react'

/**
 * ProjectFilesPane · P0 右栏(项目工作台 / 对话文件)
 *
 * 不依赖具体 store, 通过 props 拿:
 *   - projectName: 标题
 *   - sessionFiles: [{id, name, kind, createdAt}]  本次对话生成
 *   - pinnedFiles: [{id, name, kind}]              项目固定文件
 *   - onOpen(file): 打开文件回调
 *   - onOpenProjectSkills(): 跳"项目技能"
 *
 * 渲染逻辑很轻,以便能在 RightPreviewPane 没 artifact 时常驻显示。
 */
export default function ProjectFilesPane({
  projectName = '当前项目',
  sessionFiles = [],
  pinnedFiles = [],
  onOpen,
  onOpenProjectSkills,
}) {
  const [tab, setTab] = useState('files') // 'files' | 'workbench'
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState('time') // 'time' | 'name'

  const filteredSession = useMemo(() => {
    const q = query.trim().toLowerCase()
    let arr = sessionFiles
    if (q) arr = arr.filter((f) => String(f.name || '').toLowerCase().includes(q))
    if (order === 'name') {
      arr = [...arr].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    } else {
      arr = [...arr].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    }
    return arr
  }, [sessionFiles, query, order])

  const filteredPinned = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pinnedFiles
    return pinnedFiles.filter((f) => String(f.name || '').toLowerCase().includes(q))
  }, [pinnedFiles, query])

  const headerStyle = {
    padding: 'var(--p0-gap-md) var(--p0-gap-md) var(--p0-gap-sm)',
    borderBottom: '1px solid var(--p0-border)',
  }
  const sectionLabel = {
    fontSize: 10,
    color: 'var(--p0-text-tertiary)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    padding: 'var(--p0-gap-md) var(--p0-gap-md) var(--p0-gap-xs)',
  }
  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px var(--p0-gap-md)',
    fontSize: 13,
    color: 'var(--p0-text-primary)',
    cursor: 'pointer',
    borderRadius: 6,
  }

  return (
    <div
      data-testid="project-files-pane"
      className="h-full flex flex-col"
      style={{ fontFamily: 'var(--p0-font-sans)' }}
    >
      {/* 标题 + 项目技能跳转 */}
      <div style={headerStyle}>
        <div className="flex items-center justify-between">
          <h3 style={{ fontSize: 14, fontWeight: 500, color: 'var(--p0-text-primary)', margin: 0 }}>
            {projectName}
          </h3>
          <button
            type="button"
            onClick={onOpenProjectSkills}
            className="transition-colors"
            style={{
              fontSize: 11,
              color: 'var(--p0-accent)',
              padding: '4px 8px',
              borderRadius: 'var(--p0-radius-btn)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            项目技能 →
          </button>
        </div>

        {/* tab 切换 */}
        <div className="flex" style={{ marginTop: 'var(--p0-gap-sm)', gap: 4 }}>
          {[
            { id: 'files', label: '对话文件' },
            { id: 'workbench', label: '工作台' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="transition-colors"
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 'var(--p0-radius-pill)',
                background: tab === t.id ? 'var(--p0-accent-soft)' : 'transparent',
                color: tab === t.id ? 'var(--p0-accent)' : 'var(--p0-text-secondary)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 搜索 + 排序 */}
      <div
        style={{
          padding: 'var(--p0-gap-sm) var(--p0-gap-md)',
          borderBottom: '1px solid var(--p0-border)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件"
          aria-label="搜索项目文件"
          className="flex-1 outline-none"
          style={{
            background: 'var(--p0-card)',
            border: '1px solid var(--p0-border)',
            borderRadius: 'var(--p0-radius-btn)',
            padding: '6px 10px',
            fontSize: 12,
            color: 'var(--p0-text-primary)',
          }}
        />
        <button
          type="button"
          onClick={() => setOrder(order === 'time' ? 'name' : 'time')}
          aria-label="切换排序方式"
          title={order === 'time' ? '当前: 时间序' : '当前: 名称序'}
          className="shrink-0"
          style={{
            fontSize: 11,
            color: 'var(--p0-text-secondary)',
            padding: '6px 8px',
            border: '1px solid var(--p0-border)',
            borderRadius: 'var(--p0-radius-btn)',
            background: 'var(--p0-card)',
          }}
        >
          {order === 'time' ? '时' : '名'}
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'var(--p0-gap-md)' }}>
        {tab === 'files' && (
          <>
            <div style={sectionLabel}>本次对话生成</div>
            {filteredSession.length === 0 ? (
              <EmptyHint text="还没生成任何文件" />
            ) : (
              filteredSession.map((f) => (
                <FileRow key={f.id} file={f} onOpen={onOpen} rowStyle={rowStyle} />
              ))
            )}

            <div style={sectionLabel}>项目固定文件</div>
            {filteredPinned.length === 0 ? (
              <EmptyHint text="没有固定文件" />
            ) : (
              filteredPinned.map((f) => (
                <FileRow key={f.id} file={f} onOpen={onOpen} rowStyle={rowStyle} />
              ))
            )}
          </>
        )}

        {tab === 'workbench' && (
          <div style={{ padding: 'var(--p0-gap-lg)', color: 'var(--p0-text-secondary)', fontSize: 12 }}>
            工作台视图 P1 接入(预留)
          </div>
        )}
      </div>
    </div>
  )
}

function FileRow({ file, onOpen, rowStyle }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(file)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(file) }}
      style={rowStyle}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span aria-hidden="true" style={{ color: 'var(--p0-text-tertiary)', fontFamily: 'var(--p0-font-mono)', fontSize: 11 }}>
        {kindGlyph(file.kind)}
      </span>
      <span className="truncate">{file.name}</span>
    </div>
  )
}

function EmptyHint({ text }) {
  return (
    <div
      style={{
        padding: 'var(--p0-gap-sm) var(--p0-gap-md)',
        color: 'var(--p0-text-tertiary)',
        fontSize: 11,
      }}
    >
      {text}
    </div>
  )
}

function kindGlyph(kind = 'file') {
  switch (String(kind).toLowerCase()) {
    case 'ppt':
    case 'pptx': return '◆'
    case 'image':
    case 'png':
    case 'jpg': return '▣'
    case 'md':
    case 'doc':
    case 'text': return '≡'
    case 'code':
    case 'js':
    case 'json': return '<>'
    default: return '·'
  }
}
