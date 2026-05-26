/**
 * useChatEngine — 聊天引擎 Hook
 *
 * 从 ChatSplit 提取核心消息发送逻辑，
 * 使用 Zustand 状态管理，消除循环依赖。
 */

import { useState, useRef, useCallback } from 'react';
import { useStore } from '../stores';
import { buildToolSpecs, executeToolCall } from '../lib/tools/index.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function isTextLikeFile(file) {
  return /^text\/|json|xml|csv|markdown|javascript|typescript/.test(file.type) ||
    /\.(txt|md|json|csv|xml|yml|yaml|log|js|jsx|ts|tsx|css|html)$/i.test(file.name);
}

export function useChatEngine() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const abortCtrlRef = useRef(null);

  const currentSessionId = useStore(s => s.currentSessionId);
  const sessions = useStore(s => s.sessions);
  const messagesBySession = useStore(s => s.messagesBySession);
  const apiConfig = useStore(s => s.apiConfig);

  const activeSession = sessions.find(s => s.id === currentSessionId);
  const messages = activeSession ? (messagesBySession[currentSessionId] || []) : [];

  const handleSend = useCallback(async (text, files) => {
    if (!text?.trim() && !files?.length) return;

    const sessionId = currentSessionId || `session-${Date.now()}`;

    // Ensure session exists
    const state = useStore.getState();
    if (!state.currentSessionId) {
      state.setCurrentSessionId(sessionId);
      state.setSessions([...state.sessions, {
        id: sessionId,
        title: text?.slice(0, 30) || '新对话',
        firstMessage: text || '',
        modified: new Date().toISOString(),
        messageCount: 0,
        agentId: null,
        agentName: null,
        cwd: null,
      }]);
    }

    // Add user message
    const userMsg = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      text: text || '',
      blocks: text ? [{ type: 'text', html: text, source: text }] : [],
      timestamp: Date.now(),
    };

    const currentMsgs = state.messagesBySession[sessionId] || [];
    state.setSessionMessages(sessionId, [...currentMsgs, userMsg]);
    state.setWelcomeVisible(false);

    // Process attachments
    if (files?.length) {
      for (const file of files) {
        if (file.file?.type?.startsWith('image/') && file.file.size <= MAX_IMAGE_BYTES) {
          try {
            const dataUrl = await readFileAsDataUrl(file.file);
            file.dataUrl = dataUrl;
          } catch (e) {
            console.warn('Failed to read image:', e);
          }
        }
      }
    }

    // Start generating
    setIsGenerating(true);
    state.addStreamingSession(sessionId);

    try {
      // Build content with attachments
      let content = text || '';
      for (const att of (files || [])) {
        if (att.dataUrl) {
          content += `\n\n[图片: ${att.name}]\n${att.dataUrl}`;
        } else if (att.text) {
          content += `\n\n[文件: ${att.name}]\n${att.text}`;
        } else {
          content += `\n\n[附件: ${att.name}]`;
        }
      }

      // Call model
      const abortCtrl = new AbortController();
      abortCtrlRef.current = abortCtrl;

      const { callModel } = await import('../lib/modelClient.js');
      const result = await callModel({
        messages: [...currentMsgs, userMsg].map(m => ({
          role: m.role,
          content: m.text || m.blocks?.map(b => b.source || b.html).join('\n') || '',
        })),
        tools: buildToolSpecs(),
        signal: abortCtrl.signal,
      });

      // Add assistant message
      const assistantMsg = {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        text: result.text || '',
        blocks: result.blocks || [{ type: 'text', html: result.text || '', source: result.text || '' }],
        timestamp: Date.now(),
      };

      const latestState = useStore.getState();
      const latestMsgs = latestState.messagesBySession[sessionId] || [];
      latestState.setSessionMessages(sessionId, [...latestMsgs, assistantMsg]);

      // Update session title if needed
      if (latestMsgs.length <= 2) {
        const newTitle = text?.slice(0, 30) || '新对话';
        latestState.setSessions(latestState.sessions.map(s =>
          s.id === sessionId ? { ...s, title: newTitle, messageCount: latestMsgs.length + 1 } : s
        ));
      }

    } catch (err) {
      if (err.message !== '已停止生成') {
        console.error('Model call failed:', err);

        const errorMsg = {
          id: `msg-${Date.now()}-error`,
          role: 'assistant',
          text: `调用失败: ${err.message}`,
          blocks: [{ type: 'text', html: `<p style="color:#ef4444">调用失败: ${err.message}</p>`, source: `调用失败: ${err.message}` }],
          timestamp: Date.now(),
        };

        const latestState = useStore.getState();
        const latestMsgs = latestState.messagesBySession[sessionId] || [];
        latestState.setSessionMessages(sessionId, [...latestMsgs, errorMsg]);
      }
    } finally {
      setIsGenerating(false);
      const latestState = useStore.getState();
      latestState.removeStreamingSession(sessionId);
      abortCtrlRef.current = null;
    }
  }, [currentSessionId]);

  const handleStop = useCallback(() => {
    abortCtrlRef.current?.abort();
  }, []);

  return {
    input,
    setInput,
    attachments,
    setAttachments,
    isGenerating,
    messages,
    currentSessionId,
    handleSend,
    handleStop,
  };
}
