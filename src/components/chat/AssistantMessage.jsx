/**
 * AssistantMessage — 助手消息组件
 *
 * 参考 openhanako 的 AssistantMessage，遍历 ContentBlock
 * 按类型渲染：thinking、mood、tool_group、text、file、
 * artifact、media_generation、screenshot、skill、subagent。
 */

import { memo, useCallback, useState } from 'react';
import { useStore } from '../../stores';
import MarkdownRenderer from '../MarkdownRenderer';
import { ArtifactPreview } from './ArtifactPreview';
import './messages.css';

export const AssistantMessage = memo(function AssistantMessage({
  message,
  showAvatar,
  sessionId,
  isLatest,
  retrySource,
}) {
  const agentName = useStore(s => s.agentName);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const blocks = message.blocks || [];

  const handleCopy = useCallback(() => {
    const textBlocks = blocks.filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.html || b.source || '').join('\n');
    navigator.clipboard.writeText(text || message.text || '').catch(() => {});
  }, [blocks, message.text]);

  const handleRetry = useCallback(() => {
    // Retry: re-send the last user message
    if (retrySource?.text) {
      const state = useStore.getState();
      // Trigger re-send via the existing flow
      window.dispatchEvent(new CustomEvent('retry-message', {
        detail: { sessionId, text: retrySource.text },
      }));
    }
  }, [retrySource, sessionId]);

  const handleDelete = useCallback(() => {
    const { deleteMessage } = useStore.getState();
    if (sessionId && message.id) {
      deleteMessage(sessionId, message.id);
    }
  }, [message.id, sessionId]);

  return (
    <div className={`message assistant-message ${isLatest ? 'latest' : ''}`} data-message-id={message.id}>
      <div className="message-row">
        {showAvatar && (
          <div className="message-avatar assistant-avatar">
            {agentAvatarUrl ? (
              <img src={agentAvatarUrl} alt={agentName} />
            ) : (
              <span>{agentName.charAt(0).toUpperCase()}</span>
            )}
          </div>
        )}
        <div className="message-body">
          {showAvatar && (
            <div className="message-header">
              <span className="message-name">{agentName}</span>
            </div>
          )}
          <div className="message-content assistant-content">
            {blocks.length === 0 && message.text && (
              <MarkdownRenderer content={message.text} />
            )}
            {blocks.map((block, i) => (
              <ContentBlockRenderer key={`${message.id}-block-${i}`} block={block} />
            ))}
          </div>
          <AssistantActions
            onCopy={handleCopy}
            onRetry={handleRetry}
            onDelete={handleDelete}
            canRetry={!!retrySource && isLatest}
          />
        </div>
      </div>
    </div>
  );
});

/**
 * ContentBlockRenderer — 根据 block 类型渲染对应内容
 */
function ContentBlockRenderer({ block }) {
  if (!block || !block.type) return null;

  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} />;
    case 'text':
      return <TextBlock html={block.html} source={block.source} />;
    case 'file':
      return <FileBlock file={block} />;
    case 'artifact':
      return <ArtifactBlock artifact={block} />;
    case 'media_generation':
      return <MediaGenerationBlock task={block} />;
    case 'screenshot':
      return <ScreenshotBlock base64={block.base64} mimeType={block.mimeType} />;
    case 'skill':
      return <SkillBlock skill={block} />;
    case 'subagent':
      return <SubagentBlock subagent={block} />;
    default:
      return null;
  }
}

/* ── Thinking Block ── */
function ThinkingBlock({ content, sealed }) {
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;

  return (
    <div className={`content-block thinking-block ${sealed ? 'sealed' : 'streaming'}`}>
      <button
        className="thinking-header"
        onClick={() => setExpanded(!expanded)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>{sealed ? '思考过程' : '思考中...'}</span>
      </button>
      {expanded && (
        <pre className="thinking-content">{content}</pre>
      )}
    </div>
  );
}

/* ── Mood Block ── */
function MoodBlock({ yuan, text }) {
  if (!text) return null;
  return (
    <div className="content-block mood-block" data-yuan={yuan}>
      <MarkdownRenderer content={text} />
    </div>
  );
}

/* ── Tool Group Block ── */
function ToolGroupBlock({ tools }) {
  if (!tools || tools.length === 0) return null;
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="content-block tool-group-block">
      <button className="tool-group-header" onClick={() => setCollapsed(!collapsed)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.2s' }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>使用了 {tools.length} 个工具</span>
      </button>
      {!collapsed && (
        <div className="tool-list">
          {tools.map((tool, i) => (
            <ToolCallItem key={i} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallItem({ tool }) {
  const [expanded, setExpanded] = useState(false);
  const status = tool.done
    ? (tool.success ? 'success' : 'error')
    : 'running';

  return (
    <div className={`tool-call-item tool-${status}`}>
      <button className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-status-icon">
          {status === 'running' && <span className="tool-spinner" />}
          {status === 'success' && '✓'}
          {status === 'error' && '✗'}
        </span>
        <span className="tool-name">{tool.name}</span>
      </button>
      {expanded && tool.args && (
        <pre className="tool-args">{JSON.stringify(tool.args, null, 2)}</pre>
      )}
    </div>
  );
}

/* ── Text Block ── */
function TextBlock({ html, source }) {
  const content = html || source || '';
  if (!content) return null;
  return (
    <div className="content-block text-block">
      <MarkdownRenderer content={content} />
    </div>
  );
}

/* ── File Block ── */
function FileBlock({ file }) {
  return (
    <div className="content-block file-block">
      <div className="file-output-card">
        <div className="file-output-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div className="file-output-info">
          <span className="file-output-name">{file.label || file.filePath}</span>
          <span className="file-output-meta">{file.ext} · {file.status}</span>
        </div>
        <div className="file-output-actions">
          <button className="file-output-btn" title="预览" onClick={() => openPreview(file)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function openPreview(file) {
  const state = useStore.getState();
  state.openPreview({
    id: file.fileId || file.filePath,
    type: file.ext || 'file',
    title: file.label || file.filePath,
    content: '',
    language: file.ext,
    fileId: file.fileId,
    filePath: file.filePath,
  });
}

/* ── Artifact Block ── */
function ArtifactBlock({ artifact }) {
  const state = useStore.getState();
  return (
    <div className="content-block artifact-block">
      <div className="artifact-card">
        <div className="artifact-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>{artifact.title || '代码片段'}</span>
          <span className="artifact-type">{artifact.artifactType}</span>
        </div>
        <div className="artifact-preview">
          <ArtifactPreview
            content={artifact.content}
            language={artifact.language}
          />
        </div>
        <div className="artifact-actions">
          <button onClick={() => {
            state.openPreview({
              id: artifact.artifactId,
              type: 'artifact',
              title: artifact.title || '代码片段',
              content: artifact.content,
              language: artifact.language,
            });
          }}>
            查看完整代码
          </button>
          <button onClick={() => {
            navigator.clipboard.writeText(artifact.content).catch(() => {});
            state.addToast('已复制到剪贴板', 'success', 3000);
          }}>
            复制
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Media Generation Block ── */
function MediaGenerationBlock({ task }) {
  return (
    <div className="content-block media-gen-block">
      <div className={`media-gen-card media-${task.status}`}>
        <div className="media-gen-status">
          {task.status === 'pending' && <span className="media-spinner" />}
          {task.status === 'failed' && '❌'}
          {task.status === 'done' && '✓'}
          <span>{task.status === 'pending' ? '生成中...' : task.status}</span>
        </div>
        {task.prompt && (
          <div className="media-gen-prompt">{task.prompt}</div>
        )}
      </div>
    </div>
  );
}

/* ── Screenshot Block ── */
function ScreenshotBlock({ base64, mimeType }) {
  if (!base64) return null;
  const src = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
  return (
    <div className="content-block screenshot-block">
      <div className="screenshot-card">
        <img src={src} alt="截图" className="screenshot-img" />
      </div>
    </div>
  );
}

/* ── Skill Block ── */
function SkillBlock({ skill }) {
  return (
    <div className="content-block skill-block">
      <div className="skill-card">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <span>技能: {skill.skillName}</span>
      </div>
    </div>
  );
}

/* ── Subagent Block ── */
function SubagentBlock({ subagent }) {
  return (
    <div className="content-block subagent-block">
      <div className={`subagent-card subagent-${subagent.streamStatus}`}>
        <div className="subagent-header">
          {subagent.streamStatus === 'running' && <span className="subagent-spinner" />}
          <span className="subagent-title">{subagent.taskTitle || subagent.task}</span>
        </div>
        {subagent.agentName && (
          <div className="subagent-agent">执行者: {subagent.agentName}</div>
        )}
        {subagent.summary && (
          <div className="subagent-summary">{subagent.summary}</div>
        )}
      </div>
    </div>
  );
}

/* ── Assistant Actions ── */
function AssistantActions({ onCopy, onRetry, onDelete, canRetry }) {
  return (
    <div className="message-actions assistant-actions">
      <button className="msg-action-btn" onClick={onCopy} title="复制">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      {canRetry && (
        <button className="msg-action-btn" onClick={onRetry} title="重试">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      )}
      <button className="msg-action-btn" onClick={onDelete} title="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
}
