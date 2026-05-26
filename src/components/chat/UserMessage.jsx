/**
 * UserMessage — 用户消息组件
 *
 * 参考 openhanako 的 UserMessage，显示用户头像、
 * 消息内容、附件等。
 */

import { memo, useCallback } from 'react';
import { useStore } from '../../stores';
import MarkdownRenderer from '../MarkdownRenderer';
import './messages.css';

export const UserMessage = memo(function UserMessage({
  message,
  showAvatar,
  isLatest,
}) {
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);

  const handleCopy = useCallback(() => {
    const text = message.text || '';
    navigator.clipboard.writeText(text).catch(() => {});
  }, [message.text]);

  const handleDelete = useCallback(() => {
    const { currentSessionId, deleteMessage } = useStore.getState();
    if (currentSessionId && message.id) {
      deleteMessage(currentSessionId, message.id);
    }
  }, [message.id]);

  return (
    <div className={`message user-message ${isLatest ? 'latest' : ''}`} data-message-id={message.id}>
      <div className="message-row">
        {showAvatar && (
          <div className="message-avatar user-avatar">
            {userAvatarUrl ? (
              <img src={userAvatarUrl} alt={userName} />
            ) : (
              <span>{userName.charAt(0).toUpperCase()}</span>
            )}
          </div>
        )}
        <div className="message-body">
          {showAvatar && (
            <div className="message-header">
              <span className="message-name">{userName}</span>
            </div>
          )}
          <div className="message-content user-content">
            {message.text && <MarkdownRenderer content={message.text} />}
            {message.attachments && message.attachments.length > 0 && (
              <div className="message-attachments">
                {message.attachments.map((att, i) => (
                  <AttachmentChip key={i} attachment={att} />
                ))}
              </div>
            )}
          </div>
          <MessageActions onCopy={handleCopy} onDelete={handleDelete} />
        </div>
      </div>
    </div>
  );
});

function AttachmentChip({ attachment }) {
  return (
    <span className="attachment-chip">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
      {attachment.name || '附件'}
    </span>
  );
}

function MessageActions({ onCopy, onDelete }) {
  return (
    <div className="message-actions">
      <button className="msg-action-btn" onClick={onCopy} title="复制">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button className="msg-action-btn" onClick={onDelete} title="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
}
