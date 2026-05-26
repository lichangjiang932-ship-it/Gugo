/**
 * previewSlice — 预览面板状态管理
 *
 * 参考 openhanako 的 preview-slice，管理文件预览、
 * Artifact 预览、标签页等。
 */

export const createPreviewSlice = (set) => ({
  // Preview tabs
  previewTabs: [],
  activePreviewId: null,

  openPreview: (item) => set(s => {
    const exists = s.previewTabs.find(t => t.id === item.id);
    if (exists) {
      return { activePreviewId: item.id };
    }
    return {
      previewTabs: [...s.previewTabs, item],
      activePreviewId: item.id,
      previewOpen: true,
    };
  }),

  closePreview: (id) => set(s => {
    const tabs = s.previewTabs.filter(t => t.id !== id);
    const activeId = s.activePreviewId === id
      ? (tabs[tabs.length - 1]?.id || null)
      : s.activePreviewId;
    return {
      previewTabs: tabs,
      activePreviewId: activeId,
      previewOpen: tabs.length > 0 && s.previewOpen,
    };
  }),

  setActivePreview: (id) => set({ activePreviewId: id }),

  updatePreviewContent: (id, content) => set(s => ({
    previewTabs: s.previewTabs.map(t =>
      t.id === id ? { ...t, content } : t
    ),
  })),

  // Markdown preview mode for editable files
  markdownPreviewActive: false,
  setMarkdownPreviewActive: (active) => set({ markdownPreviewActive: active }),

  // Preview item type: 'artifact' | 'file' | 'media' | 'code'
  previewMode: 'artifact',
  setPreviewMode: (mode) => set({ previewMode: mode }),
});
