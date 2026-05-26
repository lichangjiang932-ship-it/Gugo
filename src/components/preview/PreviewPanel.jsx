/**
 * PreviewPanel — 预览面板
 *
 * 参考 openhanako 的 PreviewPanel，支持：
 * - 多标签页预览
 * - Markdown/Code/Artifact 预览和编辑
 * - 浮动操作按钮
 */

import { memo, useCallback } from 'react';
import { useStore, useActivePreviewItem } from '../../stores';
import './preview.css';

export const PreviewPanel = memo(function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const previewTabs = useStore(s => s.previewTabs);
  const activePreviewId = useStore(s => s.activePreviewId);
  const activeItem = useActivePreviewItem();

  const handleClose = useCallback((e, id) => {
    e.stopPropagation();
    useStore.getState().closePreview(id);
  }, []);

  const handleSelect = useCallback((id) => {
    useStore.getState().setActivePreview(id);
  }, []);

  const handleClosePanel = useCallback(() => {
    useStore.getState().setPreviewOpen(false);
  }, []);

  if (!previewOpen || previewTabs.length === 0) return null;

  return (
    <div className="preview-panel" id="previewPanel">
      <div className="resize-handle resize-handle-left" />
      <div className="preview-panel-inner">
        {/* Tab Bar */}
        <div className="preview-tab-bar">
          <div className="preview-tabs">
            {previewTabs.map(tab => (
              <button
                key={tab.id}
                className={`preview-tab ${tab.id === activePreviewId ? 'active' : ''}`}
                onClick={() => handleSelect(tab.id)}
              >
                <span className="preview-tab-title">{tab.title || '未命名'}</span>
                <span
                  className="preview-tab-close"
                  onClick={(e) => handleClose(e, tab.id)}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
          <button className="preview-panel-close" onClick={handleClosePanel}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Preview Body */}
        <div className="preview-body">
          {activeItem && (
            <PreviewContent item={activeItem} />
          )}
          {!activeItem && (
            <div className="preview-empty">
              选择一个文件预览
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function PreviewContent({ item }) {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(item.content || '').catch(() => {});
    useStore.getState().addToast('已复制到剪贴板', 'success', 3000);
  }, [item.content]);

  if (item.type === 'markdown' || item.language === 'markdown') {
    return (
      <div className="preview-markdown">
        <div className="preview-floating-actions">
          <button onClick={handleCopy} title="复制">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
        <pre className="preview-code">{item.content}</pre>
      </div>
    );
  }

  if (item.type === 'code' || item.language) {
    return (
      <div className="preview-code-view">
        <div className="preview-floating-actions">
          <button onClick={handleCopy} title="复制">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
        <pre className="preview-code">
          <code className={item.language ? `language-${item.language}` : ''}>
            {item.content}
          </code>
        </pre>
      </div>
    );
  }

  if (item.type === 'artifact') {
    return (
      <div className="preview-code-view">
        <div className="preview-floating-actions">
          <button onClick={handleCopy} title="复制">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
        <pre className="preview-code">
          <code className={item.language ? `language-${item.language}` : ''}>
            {item.content}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <div className="preview-generic">
      <div className="preview-floating-actions">
        <button onClick={handleCopy} title="复制">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
      <pre className="preview-code">{item.content}</pre>
    </div>
  );
}
