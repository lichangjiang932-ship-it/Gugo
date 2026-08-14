import { isValidElement, memo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import FullscreenMediaModal from './FullscreenMediaModal.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { findArtifactReferenceByHref, remarkArtifactReferences } from '../lib/artifactReferences.js'
import { copyTextToClipboard } from '../lib/clipboard.js'

/**
 * MarkdownRenderer —— 安全渲染 Markdown + 代码高亮
 *
 * 流程：
 * 1. ReactMarkdown 把 markdown 解析为 hast
 * 2. rehype-sanitize 清洗危险 HTML（XSS 防护，schema 见 sanitizeSchema）
 * 3. rehype-highlight 给代码块加语法高亮 className
 *
 * 样式依赖 highlight.js 的主题 CSS，在 index.html 或全局 CSS 中引入即可。
 */

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
    a: [...(defaultSchema.attributes?.a || []), 'target', 'rel'],
  },
}

function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText(node.props.children)
  return ''
}

function isManagedArtifactHref(href = '') {
  try {
    return new URL(String(href || ''), 'http://artifact.local').pathname.startsWith('/api/artifacts/')
  } catch {
    return String(href || '').startsWith('/api/artifacts/')
  }
}

function CodeBlock({ children, streaming = false }) {
  const { t } = useT()
  const [copyState, setCopyState] = useState('idle')
  const child = Array.isArray(children) ? children[0] : children
  const className = isValidElement(child) ? child.props.className || '' : ''
  const language = className.match(/language-([\w-]+)/)?.[1] || 'text'
  const source = nodeText(child).replace(/\n$/, '')

  const copy = async () => {
    try {
      await copyTextToClipboard(source)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
  }

  const copyLabel = copyState === 'copied'
    ? t('chatMessages.copied')
    : copyState === 'error'
      ? t('chatMessages.copyFailed')
      : t('chatMessages.copy')

  return (
    <div className="chat-code-block not-prose my-2.5 overflow-hidden rounded-md border border-ink/15 bg-paper-2">
      <div className="flex h-7 items-center justify-between border-b border-ink/10 px-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-fade">{language}</span>
        {!streaming && (
          <button
            type="button"
            onClick={copy}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-paper hover:text-ink ${copyState === 'error' ? 'text-rose-700' : 'text-ink-fade'}`}
            aria-label={copyState === 'idle' ? t('chatMessages.copyContent') : copyLabel}
            aria-live="polite"
          >
            {copyState === 'copied' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copyLabel}
          </button>
        )}
      </div>
      <pre className="m-0 overflow-x-auto p-3 text-[12px] leading-5">{children}</pre>
    </div>
  )
}

function MarkdownRenderer({ artifactReferences = [], children, className = '', onLinkClick, streaming = false }) {
  const [fullscreen, setFullscreen] = useState(null)

  return (
    <div className={`chat-markdown prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkArtifactReferences, { references: artifactReferences }]]}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
          rehypeHighlight,
        ]}
        components={{
          // 自定义链接：强制新标签页打开 + noopener
          a: ({ href, children, ...props }) => {
            const isArtifactReference = Boolean(findArtifactReferenceByHref(artifactReferences, href))
            const anchorProps = { ...props }
            delete anchorProps.node
            if (!isArtifactReference && isManagedArtifactHref(href)) {
              return <span {...anchorProps} data-testid="blocked-artifact-link">{children}</span>
            }
            return (
              <a
                {...anchorProps}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={isArtifactReference ? 'inline-artifact-link' : undefined}
                className={isArtifactReference ? 'font-semibold text-ember decoration-ember/45 underline-offset-4 hover:decoration-ember' : anchorProps.className}
                onClick={(event) => {
                  if (onLinkClick?.(href, event)) event.preventDefault()
                }}
              >
                {children}
              </a>
            )
          },
          // 代码块容器
          pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
          // 内联代码
          code: ({ className, children, ...props }) => {
            if (!className) {
              return (
                <code className="rounded-md border border-ink/10 bg-paper-2 px-1.5 py-0.5 text-[0.86em] font-mono text-ember" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          // 图片：点击进入全屏查看器
          img: ({ src, alt, ...props }) => (
            <img
              {...props}
              src={src}
              alt={alt || ''}
              className="cursor-zoom-in rounded border border-ink-fade/30 max-w-full h-auto"
              onClick={() => src && setFullscreen({ src, alt: alt || '' })}
            />
          ),
          // 引用块
          blockquote: ({ children, ...props }) => (
            <blockquote className="my-2.5 rounded-r border-l-2 border-ember bg-ember-soft/30 py-1.5 pl-3 pr-2.5 text-ink-soft" {...props}>
              {children}
            </blockquote>
          ),
          // 表格
          table: ({ children, ...props }) => (
            <div className="my-2.5 overflow-x-auto rounded-md border border-ink/15">
              <table className="m-0 w-full border-collapse text-sm" {...props}>{children}</table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th className="border-b border-r border-ink/10 bg-paper-2 px-3 py-2 text-left font-semibold last:border-r-0" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border-b border-r border-ink/10 px-3 py-2 align-top last:border-r-0" {...props}>
              {children}
            </td>
          ),
        }}
      >
        {children || ''}
      </ReactMarkdown>
      {fullscreen && (
        <FullscreenMediaModal
          src={fullscreen.src}
          alt={fullscreen.alt}
          onClose={() => setFullscreen(null)}
        />
      )}
    </div>
  )
}

export default memo(MarkdownRenderer)
