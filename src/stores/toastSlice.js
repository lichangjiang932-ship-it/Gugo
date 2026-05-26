/**
 * toastSlice — Toast 通知系统
 *
 * 参考 openhanako 的 toast-slice，管理全局 Toast 通知。
 */

let toastIdCounter = 0;

export const createToastSlice = (set) => ({
  // Toasts array
  toasts: [],

  addToast: (message, type = 'info', duration = 5000, opts = {}) => set(s => {
    const id = ++toastIdCounter;
    const toast = {
      id,
      message,
      type,
      duration,
      persistent: opts.persistent || false,
      dedupeKey: opts.dedupeKey || null,
      createdAt: Date.now(),
    };
    // Deduplication: remove existing toast with same dedupeKey
    const filtered = toast.dedupeKey
      ? s.toasts.filter(t => t.dedupeKey !== toast.dedupeKey)
      : s.toasts;
    return { toasts: [...filtered, toast] };
  }),

  removeToast: (id) => set(s => ({
    toasts: s.toasts.filter(t => t.id !== id),
  })),

  clearAllToasts: () => set({ toasts: [] }),
});
