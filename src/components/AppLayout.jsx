/**
 * AppLayout — 主应用布局 (完整版)
 *
 * 参考 openhanako 的 App.tsx，集成所有面板和功能模块。
 */

import { useEffect, useCallback } from 'react';
import { useStore } from '../stores';
import { ChatArea } from './chat/ChatArea';
import { InputArea } from './input/InputArea';
import { PreviewPanel } from './preview/PreviewPanel';
import { ToastContainer } from './toast/ToastContainer';
import { BrowserPanel } from './panels/BrowserPanel';
import { ActivityPanel } from './panels/ActivityPanel';
import { BridgePanel } from './panels/BridgePanel';
import { AutomationPanel } from './panels/AutomationPanel';
import { ComputerOverlay } from './panels/ComputerOverlay';
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

function ContextRing() {
  const contextPercent = useStore(s => s.contextPercent);
  if (contextPercent === null) return null;
  const color = contextPercent > 90 ? '#ef4444' : contextPercent > 70 ? '#f59e0b' : '#22c55e';
  return (
    <div className="context-ring" title={`上下文用量: ${contextPercent.toFixed(1)}%`}>
      <svg width="18" height="18" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(0,0,0,0.1)" strokeWidth="3" />
        <circle
          cx="18" cy="18" r="15" fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${contextPercent * 0.94} ${100}`}
          strokeLinecap="round" transform="rotate(-90 18 18)"
        />
      </svg>
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
        <BrowserPanel />
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

      {/* Side Panels */}
      <ActivityPanel />
      <BridgePanel />
      <AutomationPanel />

      {/* Overlays */}
      <ComputerOverlay />
      <ToastContainer />
      <ConnectionStatus />
    </div>
  );
}
