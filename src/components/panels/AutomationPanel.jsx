/**
 * AutomationPanel — 自动化面板
 *
 * 参考 openhanako 的 AutomationPanel，管理自动化工作流和CRON任务。
 */

import { memo } from 'react';
import { useStore } from '../../stores';
import './panels.css';

export const AutomationPanel = memo(function AutomationPanel() {
  const activePanel = useStore(s => s.activePanel);
  const automations = useStore(s => s.automations);
  const cronJobs = useStore(s => s.cronJobs);

  if (activePanel !== 'automation') return null;

  return (
    <div className="side-panel automation-panel" id="automationPanel">
      <div className="side-panel-header">
        <span>自动化</span>
        <button onClick={() => useStore.getState().setActivePanel(null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="side-panel-body">
        {cronJobs.length > 0 && (
          <div className="automation-section">
            <h4>定时任务</h4>
            {cronJobs.map((job, i) => (
              <div key={i} className="cron-item">
                <span className="cron-schedule">{job.schedule}</span>
                <span className="cron-command">{job.command}</span>
              </div>
            ))}
          </div>
        )}
        {automations.length > 0 && (
          <div className="automation-section">
            <h4>工作流</h4>
            {automations.map((a, i) => (
              <div key={i} className="automation-item">
                <span className="automation-trigger">{a.trigger}</span>
                <span className="automation-count">{a.actions?.length || 0} 动作</span>
              </div>
            ))}
          </div>
        )}
        {cronJobs.length === 0 && automations.length === 0 && (
          <div className="side-panel-empty">暂无自动化任务</div>
        )}
      </div>
    </div>
  );
});
