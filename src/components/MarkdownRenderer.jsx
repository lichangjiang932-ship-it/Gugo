import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import DOMPurify from 'dompurify'
import { GitBranch, ChevronDown, ChevronRight } from 'lucide-react'

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'img', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
]
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'class', 'id']

function sanitizeHtml(raw) {
  if (typeof raw !== 'string') return ''
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR, KEEP_CONTENT: true })
}

function MermaidDiagram({ code }) {
  const [svg, setSvg] = useState(null)
  const [error, setError] = useState(null)

  useMemo(() => {
    let cancelled = false
    const render = async () => {
      try {
        const m = await import('mermaid')
        const mermaid = m.default || m
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        const id = 'mermaid-' + Math.random().toString(36).slice(2, 10)
        const { svg: s } = await mermaid.render(id, code)
        if (!cancelled) { setSvg(s); setError(null) }
      } catch (e) {
        if (!cancelled) { setError(e.message || ''); setSvg(null) }
      }
    }
    render()
    return () => { cancelled = true }
  }, [code])

  if (svg) return (
    <div className="my-3">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-mono tracking-wider uppercase text-ink-fade">
        <GitBranch className="w-3 h-3" />Mermaid
      </div>
      <div className="bg-paper-dark rounded-lg p-4 overflow-x-auto border border-ink-fade/20" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
  return (
    <div className="my-3">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-mono tracking-wider uppercase text-ink-fade">
        <GitBranch className="w-3 h-3" />Mermaid {error && <span className="text-ember">({error})</span>}
      </div>
      <pre className="bg-paper-2 border border-ink-fade/30 rounded-md p-3 overflow-x-auto text-sm"><code className="text-ink-soft font-mono text-xs">{code}</code></pre>
    </div>
  )
}

function ThinkingBlock({ content }) {
  const [open, setOpen] = useState(false)
  if (!content || typeof content !== 'string') return null
  const lines = content.split('\n').filter(l => l.trim())
  return (
    <div className="my-2 border border-ink-fade/20 rounded-md overflow-hidden bg-paper-2/30">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-paper-2/50 transition-colors">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-ink-fade" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-fade" />}
        <span className="text-[11px] font-mono text-ink-fade tracking-wider">THINKING &middot; {lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-ink-fade/10">
          <pre className="text-xs text-ink-fade font-mono whitespace-pre-wrap leading-relaxed">{content}</pre>
        </div>
      )}
    </div>
  )
}

function splitThinkingBlocks(content) {
  if (!content || typeof content !== 'string') return [{ type: 'markdown', content: '' }]
  const parts = []
  try {
    const regex = /<thinking>([\s\S]*?)<\/thinking>/g
    let lastIndex = 0
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'markdown', content: content.slice(lastIndex, match.index) })
      }
      parts.push({ type: 'thinking', content: (match[1] || '').trim() })
      lastIndex = match.index + (match[0] || '').length
    }
    if (lastIndex < content.length) {
      parts.push({ type: 'markdown', content: content.slice(lastIndex) })
    }
  } catch (e) {
    // fallback: return whole content as markdown
    return [{ type: 'markdown', content: String(content) }]
  }
  return parts.length > 0 ? parts : [{ type: 'markdown', content: String(content) }]
}

export default function MarkdownRenderer({ children, className = '' }) {
  let parts
  try {
    parts = splitThinkingBlocks(children || '')
  } catch (e) {
    parts = [{ type: 'markdown', content: String(children || '') }]
  }

  return (
    <div className={`prose prose-sm max-w-none ${className}`}>
      {parts.map((part, i) => {
        if (part.type === 'thinking') {
          return <ThinkingBlock key={i} content={part.content} />
        }
        const safeContent = sanitizeHtml(part.content || '')
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              a: ({ href, children, ...props }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
              ),
              pre: ({ children }) => {
                const codeEl = children?.[0]
                if (codeEl?.props?.className?.includes('language-mermaid')) {
                  return <MermaidDiagram code={codeEl.props.children || ''} />
                }
                return <pre className="bg-paper-2 border border-ink-fade/30 rounded-md p-3 overflow-x-auto my-2 text-sm">{children}</pre>
              },
              code: ({ inline, className, children, ...props }) => {
                if (!inline && className?.includes('language-mermaid')) return <code className={className} {...props}>{children}</code>
                if (inline) return <code className="bg-paper-2 px-1 py-0.5 rounded text-xs font-mono text-ember" {...props}>{children}</code>
                return <code className={className} {...props}>{children}</code>
              },
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-ember pl-3 py-1 my-2 text-ink-soft italic">{children}</blockquote>
              ),
              table: ({ children }) => <table className="w-full text-sm border-collapse my-2">{children}</table>,
              th: ({ children }) => <th className="border border-ink-fade/30 px-2 py-1 bg-paper-2 text-left font-semibold">{children}</th>,
              td: ({ children }) => <td className="border border-ink-fade/30 px-2 py-1">{children}</td>,
            }}
          >{safeContent}</ReactMarkdown>
        )
      })}
    </div>
  )
}
