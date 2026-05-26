/**
 * ToastContainer — Toast 通知容器
 *
 * 参考 openhanako 的 ToastContainer，全局 Toast 通知显示。
 */

import { useEffect } from 'react';
import { useStore } from '../../stores';
import './toast.css';

function ToastItem({ toast }) {
  const removeToast = useStore(s => s.removeToast);

  useEffect(() => {
    if (toast.persistent || toast.duration <= 0) return;
    const timer = setTimeout(() => {
      removeToast(toast.id);
    }, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, toast.persistent, removeToast]);

  return (
    <div className={`toast-item toast-${toast.type}`} role="alert">
      <span className="toast-message">{toast.message}</span>
      <button
        className="toast-close"
        onClick={() => removeToast(toast.id)}
        aria-label="关闭通知"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useStore(s => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" id="toastContainer">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
