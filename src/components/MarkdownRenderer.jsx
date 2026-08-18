import { isValidElement, memo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import FullscreenMediaModal from './FullscreenMediaModal.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { findArtifactReferenceByHref, findArtifactReferenceByLocalPath, normalizeArtifactLocalPath, remarkArtifactReferences, remarkLocalPathLinks } from '../lib/artifactReferences.js'
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
  // ★ 允许 file:// 协议,供「裸绝对路径 → 可点击链接」使用。
  // 点击永远被 onLinkClick 拦截,浏览器不会真的导航到 file://。
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: [...new Set([...(defaultSchema.protocols?.href || []), 'file'])],
  },
}

function isLocalPathHref(href = '') {
  const value = String(href || '')
  return /^file:\/\//i.test(value) || Boolean(normalizeArtifactLocalPath(value))
}

function markdownUrlTransform(value) {
  // Local paths are rendered without an href below and every click is
  // intercepted by the registered-reference resolver. All other protocols
  // retain react-markdown's default URL safety policy.
  return isLocalPathHref(value) ? value : defaultUrlTransform(value)
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

function selectedTextIntersects(element) {
  const selection = element?.ownerDocument?.defaultView?.getSelection?.()
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return false
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(element)) return true
    } catch {
      // A stale selection range can disappear while React handles the click.
    }
  }
  return false
}

function referenceLocalPath(reference) {
  const candidates = [
    reference?.path,
    reference?.fullPath,
    reference?.outputPath,
    reference?.localPath,
  ]
  return candidates.find((value) => normalizeArtifactLocalPath(value)) || ''
}

function SelectableFileLink({
  anchorProps,
  children,
  href,
  localPath,
  onLinkClick,
}) {
  const { t } = useT()
  const [copyState, setCopyState] = useState('idle')
  const copyPath = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      await copyTextToClipboard(localPath)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
  }

  return (
    <span className="chat-inline-file-reference">
      <a
        {...anchorProps}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="inline-artifact-link"
        className="chat-output-file-name font-semibold decoration-current/45 underline-offset-4 hover:decoration-current"
        onClick={(event) => {
          if (selectedTextIntersects(event.currentTarget)) {
            event.preventDefault()
            return
          }
          if (onLinkClick?.(href, event)) event.preventDefault()
        }}
      >
        {children}
      </a>
      {localPath && (
        <button
          type="button"
          data-testid="copy-local-path"
          className="chat-inline-path-copy"
          aria-label={copyState === 'copied' ? t('chatMessages.copied') : t('chatMessages.copyContent')}
          title={copyState === 'copied' ? t('chatMessages.copied') : localPath}
          onClick={copyPath}
        >
          {copyState === 'copied'
            ? <Check className="h-3 w-3 text-emerald-600" />
            : <Copy className="h-3 w-3" />}
        </button>
      )}
    </span>
  )
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
    <div className="chat-code-block not-prose my-3 overflow-hidden rounded-card border border-neutral-200 bg-neutral-50 shadow-sm">
      <div className="flex h-7 items-center justify-between border-b border-ink/10 px-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-fade">{language}</span>
        {!streaming && (
          <button
            type="button"
            onClick={copy}
            className={`inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-[11px] transition-colors hover:bg-paper hover:text-ink ${copyState === 'error' ? 'text-rose-700' : 'text-ink-fade'}`}
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
    <div className={`chat-markdown prose prose-sm max-w-none leading-[1.75] ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkArtifactReferences, { references: artifactReferences }], remarkLocalPathLinks]}
        urlTransform={markdownUrlTransform}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
          rehypeHighlight,
        ]}
        components={{
          // 自定义链接：本地路径可点击打开;普通链接新标签页打开 + noopener
          a: ({ href, children, ...props }) => {
            const isLocalPath = isLocalPathHref(href)
            const artifactReference = findArtifactReferenceByHref(artifactReferences, href)
              || (isLocalPath && findArtifactReferenceByLocalPath(artifactReferences, href))
            const isArtifactReference = Boolean(artifactReference)
            const visibleLocalPath = nodeText(children).trim()
            const normalizedVisibleLocalPath = normalizeArtifactLocalPath(visibleLocalPath)
            const trustedLocalPath = referenceLocalPath(artifactReference)
            const anchorProps = { ...props }
            delete anchorProps.node
            if (!isArtifactReference && isManagedArtifactHref(href)) {
              return <span {...anchorProps} data-testid="blocked-artifact-link">{children}</span>
            }
            if (isLocalPath && !isArtifactReference) {
              return (
                <span
                  {...anchorProps}
                  data-testid="unverified-local-path"
                  className="font-mono text-[0.88em] text-ink-soft"
                >
                  {children}
                </span>
              )
            }
            if (isArtifactReference
              && normalizedVisibleLocalPath
              && normalizeArtifactLocalPath(trustedLocalPath) !== normalizedVisibleLocalPath) {
              return (
                <span
                  {...anchorProps}
                  data-testid="unverified-local-path"
                  className="font-mono text-[0.88em] text-ink-soft"
                >
                  {children}
                </span>
              )
            }
            if (isArtifactReference) {
              return (
                <SelectableFileLink
                  anchorProps={anchorProps}
                  href={artifactReference?.url || href}
                  localPath={trustedLocalPath}
                  onLinkClick={onLinkClick}
                >
                  {children}
                </SelectableFileLink>
              )
            }
            return (
              <a
                {...anchorProps}
                href={isLocalPath ? undefined : href}
                {...(isLocalPath ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
                data-testid={isLocalPath ? 'inline-local-path-link' : undefined}
                className={isLocalPath
                    ? 'inline-flex rounded-control border border-neutral-200 bg-neutral-100 px-1.5 py-0.5 font-medium text-[0.88em] text-neutral-700 no-underline hover:border-blue-300 hover:text-blue-600'
                    : anchorProps.className}
                onClick={(event) => {
                  if (isLocalPath) event.preventDefault()
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
                <code className="rounded-control border border-neutral-200 bg-neutral-100 px-1.5 py-0.5 text-[0.86em] font-medium text-neutral-700" {...props}>
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
            <blockquote className="my-3 rounded-r-control border-l-2 border-neutral-300 bg-neutral-50 py-2 pl-3.5 pr-3 text-ink-soft" {...props}>
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
