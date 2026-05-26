/**
 * ChatArea — 聊天消息列表
 *
 * 参考 openhanako 的 ChatArea，管理消息滚动、
 * sticky 检测、加载更多等。
 */

import { memo, useRef, useEffect, useState, useCallback } from 'react';
import { useStore, useCurrentSessionMessages } from '../../stores';
import { WelcomeScreen } from './WelcomeScreen';
import { ChatTranscript } from './ChatTranscript';
import './chat-area.css';

const SCROLL_THRESHOLD = 50;

export function ChatArea() {
  const currentSessionId = useStore(s => s.currentSessionId);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const messages = useCurrentSessionMessages();

  const hasMessages = messages.length > 0;
  const showWelcome = welcomeVisible && !hasMessages;

  return (
    <div className="chat-area">
      {showWelcome && <WelcomeScreen />}
      {hasMessages && currentSessionId && (
        <ChatPanel sessionId={currentSessionId} messages={messages} />
      )}
      {!showWelcome && !hasMessages && (
        <EmptyChat />
      )}
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="empty-chat">
      <div className="empty-chat-hint">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p>发送消息开始对话</p>
      </div>
    </div>
  );
}

// ChatPanel: per-session scroll container
const ChatPanel = memo(function ChatPanel({ sessionId, messages }) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const [sticky, setSticky] = useState(true);
  const isStreaming = useStore(s => s.streamingSessions.includes(sessionId));
  const prevLen = useRef(messages.length);

  // Check sticky state
  const checkSticky = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    return atBottom;
  }, []);

  // Auto scroll to bottom on new messages (when streaming or sticky)
  useEffect(() => {
    if (!scrollRef.current) return;
    if (messages.length > prevLen.current) {
      const lastMsg = messages[messages.length - 1];
      // User message: instant scroll
      if (lastMsg?.role === 'user') {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        setSticky(true);
      } else if (isStreaming || sticky) {
        // Assistant message: smooth follow
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    prevLen.current = messages.length;
  }, [messages, isStreaming, sticky]);

  // Scroll to bottom on mount
  useEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sessionId]);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const isSticky = checkSticky();
    setSticky(isSticky);
  }, [checkSticky]);

  // Scroll to bottom button
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setSticky(true);
    }
  }, []);

  return (
    <div className="chat-panel-shell">
      <div
        ref={scrollRef}
        className="chat-scroll-panel"
        onScroll={handleScroll}
      >
        <div ref={contentRef} className="chat-messages">
          <ChatTranscript messages={messages} sessionId={sessionId} />
          {isStreaming && <div className="typing-indicator" />}
          <div className="chat-footer-spacer" />
        </div>
      </div>

      {!sticky && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label="滚动到底部"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
});
