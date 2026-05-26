/**
 * Store — Zustand 主 store
 *
 * 参考 openhanako 的多 slice 架构，整合所有功能 slice。
 * 使用简单合并模式，不依赖中间件。
 */

import { create } from 'zustand';
import { createUiSlice } from './uiSlice';
import { createSessionSlice } from './sessionSlice';
import { createChatSlice } from './chatSlice';
import { createPreviewSlice } from './previewSlice';
import { createToastSlice } from './toastSlice';
import { createAgentSlice } from './agentSlice';

export const useStore = create((set, get) => ({
  ...createUiSlice(set, get),
  ...createSessionSlice(set),
  ...createChatSlice(set, get),
  ...createPreviewSlice(set),
  ...createToastSlice(set),
  ...createAgentSlice(set),
}));

// Selector hooks for common patterns
export function useIsStreaming(sessionId) {
  return useStore(s => s.streamingSessions.includes(sessionId));
}

export function useSessionMessages(sessionId) {
  return useStore(s => s.messagesBySession[sessionId] || []);
}

export function useCurrentSessionMessages() {
  return useStore(s => {
    const sid = s.currentSessionId;
    return sid ? (s.messagesBySession[sid] || []) : [];
  });
}

export function useActivePreviewItem() {
  return useStore(s => {
    return s.previewTabs.find(t => t.id === s.activePreviewId) || null;
  });
}
