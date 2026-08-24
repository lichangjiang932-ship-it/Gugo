import { memo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import FullscreenMediaModal from './FullscreenMediaModal.jsx'
import { findArtifactReferenceByHref, findArtifactReferenceByLocalPath, normalizeArtifactLocalPath, remarkArtifactReferences, remarkLocalPathLinks } from '../lib/artifactReferences.js'
import { CodeBlock, SelectableFileLink } from './markdown/MarkdownControls.jsx'
import { nodeText } from './markdown/markdownUtils.js'

/**
 * MarkdownRenderer —— 安全渲染 Markdown + 代码高亮
 *
 * 流程：
 * 1. ReactMarkdown 把 markdown 解析为 hast
 * 2. rehype-sanitize 清洗危险 HTML（XSS 防护，schema 见 sanitizeSchema）
 * 3. rehype-highlight 给代码块加语法高亮 className
 *
 * highlight.js 只负责生成 token class，主题色由 index.css 的语义变量提供。
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

function isManagedArtifactHref(href = '') {
  try {
    return new URL(String(href || ''), 'http://artifact.local').pathname.startsWith('/api/artifacts/')
  } catch {
    return String(href || '').startsWith('/api/artifacts/')
  }
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

function MarkdownRenderer({ artifactReferences = [], children, className = '', onLinkClick, streaming = false }) {
  const [fullscreen, setFullscreen] = useState(null)

  return (
    <div className={`chat-markdown prose prose-sm max-w-none leading-[1.75] ${streaming ? 'chat-markdown-streaming' : ''} ${className}`}>
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
                    ? 'inline-flex rounded-control border border-ink/10 bg-paper-2 px-1.5 py-0.5 font-medium text-[0.88em] text-ink-soft no-underline hover:border-accent/40 hover:text-accent-ink'
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
                <code className="rounded-control border border-ink/10 bg-paper-2 px-1.5 py-0.5 text-[0.86em] font-medium text-ink-soft" {...props}>
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
              className="h-auto max-w-full cursor-zoom-in rounded-control border border-ink-fade/30"
              onClick={() => src && setFullscreen({ src, alt: alt || '' })}
            />
          ),
          // 引用块
          blockquote: ({ children, ...props }) => (
            <blockquote className="my-3 rounded-r-control border-l-2 border-ink/15 bg-paper-2/60 py-2 pl-3.5 pr-3 text-ink-soft" {...props}>
              {children}
            </blockquote>
          ),
          // 表格
          table: ({ children, ...props }) => (
            <div className="my-2.5 overflow-x-auto rounded-card border border-ink/15">
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
