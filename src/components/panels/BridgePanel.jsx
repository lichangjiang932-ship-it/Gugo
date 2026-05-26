/**
 * BridgePanel — 桥接连接面板
 *
 * 参考 openhanako 的 BridgePanel，管理外部平台连接。
 */

import { memo } from 'react';
import { useStore } from '../../stores';
import './panels.css';

export const BridgePanel = memo(function BridgePanel() {
  const activePanel = useStore(s => s.activePanel);
  const bridgeConnected = useStore(s => s.bridgeConnected);
  const bridgePlatforms = useStore(s => s.bridgePlatforms);

  if (activePanel !== 'bridge') return null;

  return (
    <div className="side-panel bridge-panel" id="bridgePanel">
      <div className="side-panel-header">
        <span>桥接</span>
        <button onClick={() => useStore.getState().setActivePanel(null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="side-panel-body">
        <div className="bridge-status">
          <span className={`bridge-dot ${bridgeConnected ? 'connected' : ''}`} />
          <span>{bridgeConnected ? '已连接' : '未连接'}</span>
        </div>
        {bridgePlatforms.length > 0 && (
          <div className="bridge-platforms">
            {bridgePlatforms.map((p, i) => (
              <div key={i} className="bridge-platform-item">{p}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
