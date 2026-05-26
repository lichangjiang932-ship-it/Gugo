/**
 * Store — Zustand 主 store (完整版)
 *
 * 整合所有功能 slice，参考 openhanako 的完整架构。
 */

import { create } from 'zustand';
import { createUiSlice } from './uiSlice';
import { createSessionSlice } from './sessionSlice';
import { createChatSlice } from './chatSlice';
import { createPreviewSlice } from './previewSlice';
import { createToastSlice } from './toastSlice';
import { createAgentSlice } from './agentSlice';
import { createEngineSlice } from './engineSlice';

export const useStore = create((set, get) => ({
  ...createUiSlice(set, get),
  ...createSessionSlice(set),
  ...createChatSlice(set, get),
  ...createPreviewSlice(set),
  ...createToastSlice(set),
  ...createAgentSlice(set),
  ...createEngineSlice(set, get),
}));

// Selector hooks
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
  return useStore(s => s.previewTabs.find(t => t.id === s.activePreviewId) || null);
}

export function useCurrentAgent() {
  return useStore(s => s.agents.find(a => a.id === s.currentAgentId) || s.agents[0]);
}

export function useToolSchema(toolName) {
  return useStore(s => s.toolRegistry[toolName] || null);
}

export function useEnabledTools() {
  return useStore(s => s.enabledTools.map(name => s.toolRegistry[name]).filter(Boolean));
}
