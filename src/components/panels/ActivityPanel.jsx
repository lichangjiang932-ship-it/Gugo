/**
 * ActivityPanel — 活动追踪面板
 *
 * 参考 openhanako 的 ActivityPanel，显示 Agent 活动记录。
 */

import { memo } from 'react';
import { useStore } from '../../stores';
import './panels.css';

export const ActivityPanel = memo(function ActivityPanel() {
  const activities = useStore(s => s.activities);
  const activePanel = useStore(s => s.activePanel);

  if (activePanel !== 'activity') return null;

  return (
    <div className="side-panel activity-panel" id="activityPanel">
      <div className="side-panel-header">
        <span>活动</span>
        <button onClick={() => useStore.getState().setActivePanel(null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="side-panel-body">
        {activities.length === 0 ? (
          <div className="side-panel-empty">暂无活动记录</div>
        ) : (
          <div className="activity-list">
            {activities.map((a, i) => (
              <div key={i} className="activity-item">
                <span className="activity-type">{a.type}</span>
                <span className="activity-title">{a.title}</span>
                <span className="activity-time">{new Date(a.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
