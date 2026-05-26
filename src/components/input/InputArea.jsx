/**
 * InputArea — 聊天输入区域
 *
 * 参考 openhanako 的 InputArea，支持：
 * - 斜杠命令 (/diary, /xing, /compact, /stop, /new, /reset)
 * - 文件附件
 * - Agent 模式切换 (operate | ask | read_only)
 * - 发送/停止/引导按钮
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../../stores';
import { SlashCommandMenu } from './SlashCommandMenu';
import './input-area.css';

// 斜杠命令定义
function buildSlashCommands(t, actions) {
  return [
    {
      name: 'diary',
      label: '/diary',
      description: t('记录对话要点到日记'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      execute: actions.onDiary,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('从对话提取技能'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      execute: actions.onXing,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('压缩对话历史'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      execute: actions.onCompact,
    },
    {
      name: 'stop',
      label: '/stop',
      description: t('停止生成'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
      execute: actions.onStop,
    },
    {
      name: 'new',
      label: '/new',
      description: t('新建会话'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
      execute: actions.onNew,
    },
    {
      name: 'reset',
      label: '/reset',
      description: t('重置会话'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>',
      execute: actions.onReset,
    },
  ];
}

export function InputArea({ onSend, onStop, isStreaming }) {
  const currentSessionId = useStore(s => s.currentSessionId);
  const draft = useStore(s => currentSessionId ? s.sessionDrafts[currentSessionId] || '' : '');
  const attachedFiles = useStore(s => s.attachedFiles);
  const agentMode = useStore(s => s.agentMode);
  const addToast = useStore(s => s.addToast);

  const [input, setInput] = useState(draft);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMatches, setSlashMatches] = useState([]);
  const [slashSelected, setSlashSelected] = useState(0);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Sync with store draft
  useEffect(() => {
    setInput(draft);
  }, [draft, currentSessionId]);

  // Save draft on change
  const handleChange = useCallback((e) => {
    const value = e.target.value;
    setInput(value);
    if (currentSessionId) {
      useStore.getState().setSessionDraft(currentSessionId, value);
    }

    // Check for slash commands
    if (value.startsWith('/')) {
      const commands = buildSlashCommands((k) => k, {});
      const query = value.slice(1).toLowerCase();
      const matches = commands.filter(c => c.name.startsWith(query));
      setSlashMatches(matches);
      setSlashMenuOpen(matches.length > 0);
      setSlashSelected(0);
    } else {
      setSlashMenuOpen(false);
      setSlashMatches([]);
    }
  }, [currentSessionId]);

  const handleSend = useCallback(() => {
    if (!input.trim() && attachedFiles.length === 0) return;
    onSend?.(input, attachedFiles);
    setInput('');
    setSlashMenuOpen(false);
    if (currentSessionId) {
      useStore.getState().setSessionDraft(currentSessionId, '');
      useStore.getState().clearAttachedFiles();
    }
  }, [input, attachedFiles, onSend, currentSessionId]);

  const handleKeyDown = useCallback((e) => {
    if (slashMenuOpen && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelected(i => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelected(i => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = slashMatches[slashSelected];
        if (cmd) {
          executeSlashCommand(cmd);
        }
        return;
      }
      if (e.key === 'Escape') {
        setSlashMenuOpen(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [slashMenuOpen, slashMatches, slashSelected, handleSend]);

  const executeSlashCommand = useCallback((cmd) => {
    const state = useStore.getState();
    switch (cmd.name) {
      case 'stop':
        onStop?.();
        break;
      case 'new':
        window.dispatchEvent(new CustomEvent('new-session'));
        break;
      case 'reset':
        if (state.currentSessionId) {
          state.clearSessionMessages(state.currentSessionId);
          addToast('会话已重置', 'success', 3000);
        }
        break;
      case 'compact':
        addToast('压缩对话功能开发中...', 'info', 3000);
        break;
      case 'diary':
        addToast('日记功能开发中...', 'info', 3000);
        break;
      case 'xing':
        addToast('技能提取功能开发中...', 'info', 3000);
        break;
      default:
        cmd.execute?.();
    }
    setInput('');
    setSlashMenuOpen(false);
    if (state.currentSessionId) {
      state.setSessionDraft(state.currentSessionId, '');
    }
  }, [onStop, addToast]);

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      useStore.getState().addAttachedFile({
        fileId: `file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        path: file.name,
        isDirectory: false,
        file,
      });
    });
    e.target.value = '';
  }, []);

  const handleRemoveFile = useCallback((fileId) => {
    useStore.getState().removeAttachedFile(fileId);
  }, []);

  const handleModeChange = useCallback(() => {
    const modes = ['ask', 'operate', 'read_only'];
    const idx = modes.indexOf(agentMode);
    const next = modes[(idx + 1) % modes.length];
    useStore.getState().setAgentMode(next);
  }, [agentMode]);

  const modeLabels = { ask: '询问', operate: '操作', read_only: '只读' };
  const modeColors = { ask: '#3B82F6', operate: '#22c55e', read_only: '#f59e0b' };

  const canSend = input.trim().length > 0 || attachedFiles.length > 0;

  return (
    <div className="input-area">
      {/* Slash Command Menu */}
      {slashMenuOpen && slashMatches.length > 0 && (
        <SlashCommandMenu
          commands={slashMatches}
          selectedIndex={slashSelected}
          onSelect={(cmd) => executeSlashCommand(cmd)}
          onClose={() => setSlashMenuOpen(false)}
        />
      )}

      {/* Attached Files */}
      {attachedFiles.length > 0 && (
        <div className="input-attached-files">
          {attachedFiles.map(file => (
            <span key={file.fileId || file.path} className="input-file-chip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              {file.name}
              <button onClick={() => handleRemoveFile(file.fileId || file.path)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input Card */}
      <div className="input-card">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Shift+Enter 换行, / 查看命令)"
          rows={1}
          disabled={isStreaming}
        />

        <div className="input-toolbar">
          <div className="input-left-actions">
            <button className="input-btn" onClick={handleAttach} title="附加文件">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="input-btn mode-btn"
              onClick={handleModeChange}
              title={`Agent 模式: ${modeLabels[agentMode]}`}
              style={{ color: modeColors[agentMode] }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {agentMode === 'ask' && <circle cx="12" cy="12" r="10"/>}
                {agentMode === 'operate' && <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>}
                {agentMode === 'read_only' && <circle cx="12" cy="12" r="10"/>}
                {agentMode === 'read_only' && <line x1="12" y1="16" x2="12" y2="16"/>}
                {agentMode === 'read_only' && <line x1="12" y1="8" x2="12" y2="12"/>}
              </svg>
              <span className="mode-label">{modeLabels[agentMode]}</span>
            </button>
          </div>

          <div className="input-right-actions">
            {isStreaming ? (
              <button className="input-btn stop-btn" onClick={onStop} title="停止">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                className={`input-btn send-btn ${canSend ? 'active' : ''}`}
                onClick={handleSend}
                disabled={!canSend}
                title="发送"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}
