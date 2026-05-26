/**
 * AppLayout — 主应用布局 (完整版)
 *
 * 参考 openhanako 的 App.tsx，集成所有面板和功能模块。
 * 使用 Zustand 状态管理 + useChatEngine 处理消息逻辑。
 */

import { useEffect, useCallback } from 'react';
import { useStore } from '../stores';
import { useChatEngine } from '../hooks/useChatEngine';
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
  const {
    isGenerating,
    handleSend,
    handleStop,
  } = useChatEngine();

  return (
    <div className={`app-layout ${previewOpen ? 'preview-open' : 'preview-closed'}`}>
      {/* Main Content */}
      <main className="app-main">
        <div className="chat-container">
          <ChatArea />
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isGenerating}
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
