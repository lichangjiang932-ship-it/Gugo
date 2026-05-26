/**
 * BrowserPanel — 浏览器控制面板
 *
 * 参考 openhanako 的 BrowserCard / browser-slice，
 * 提供浏览器状态显示和控制界面。
 */

import { memo } from 'react';
import { useStore } from '../../stores';
import './panels.css';

export const BrowserPanel = memo(function BrowserPanel() {
  const browserRunning = useStore(s => s.browserRunning);
  const browserUrl = useStore(s => s.browserUrl);
  const browserThumbnail = useStore(s => s.browserThumbnail);

  if (!browserRunning) return null;

  return (
    <div className="panel-card browser-panel" id="browserPanel">
      <div className="panel-header">
        <div className="panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span>浏览器</span>
        </div>
        <div className="panel-badge running">运行中</div>
      </div>
      {browserThumbnail && (
        <div className="browser-thumbnail">
          <img src={browserThumbnail} alt="浏览器截图" />
        </div>
      )}
      {browserUrl && (
        <div className="browser-url">{browserUrl}</div>
      )}
    </div>
  );
});
