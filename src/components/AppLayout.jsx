/**
 * AppLayout — 主应用布局
 *
 * 参考 openhanako 的 App.tsx，实现三栏布局：
 * Sidebar + MainContent(ChatArea + InputArea) + PreviewPanel
 * 以及全局覆盖层：ToastContainer、ConnectionStatus 等。
 */

import { useEffect, useCallback } from 'react';
import { useStore } from '../stores';
import { ChatArea } from './chat/ChatArea';
import { InputArea } from './input/InputArea';
import { PreviewPanel } from './preview/PreviewPanel';
import { ToastContainer } from './toast/ToastContainer';
import './app-layout.css';

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  if (connected) return null;
  return (
    <div className="connection-status-bar">
      <span className="connection-dot" />
      <span>离线模式</span>
    </div>
  );
}

export function AppLayout() {
  const previewOpen = useStore(s => s.previewOpen);
  const currentSessionId = useStore(s => s.currentSessionId);
  const streamingSessions = useStore(s => s.streamingSessions);
  const isStreaming = currentSessionId ? streamingSessions.includes(currentSessionId) : false;

  // Handle retry-message event
  useEffect(() => {
    const handleRetry = (e) => {
      const { text } = e.detail;
      if (text && currentSessionId) {
        window.dispatchEvent(new CustomEvent('send-message', {
          detail: { text, sessionId: currentSessionId },
        }));
      }
    };
    window.addEventListener('retry-message', handleRetry);
    return () => window.removeEventListener('retry-message', handleRetry);
  }, [currentSessionId]);

  const handleSend = useCallback((text, files) => {
    window.dispatchEvent(new CustomEvent('send-message', {
      detail: { text, files, sessionId: currentSessionId },
    }));
  }, [currentSessionId]);

  const handleStop = useCallback(() => {
    window.dispatchEvent(new CustomEvent('stop-streaming', {
      detail: { sessionId: currentSessionId },
    }));
  }, [currentSessionId]);

  return (
    <div className={`app-layout ${previewOpen ? 'preview-open' : 'preview-closed'}`}>
      {/* Main Content */}
      <main className="app-main">
        <div className="chat-container">
          <ChatArea />
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
          />
        </div>
      </main>

      {/* Right Preview Panel */}
      <PreviewPanel />

      {/* Global Overlays */}
      <ToastContainer />
      <ConnectionStatus />
    </div>
  );
}
