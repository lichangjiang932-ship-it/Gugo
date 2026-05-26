/**
 * ComputerOverlay — 计算机视觉覆盖层
 *
 * 参考 openhanako 的 ComputerUseOverlay，显示屏幕控制状态。
 */

import { memo } from 'react';
import { useStore } from '../../stores';

export const ComputerOverlay = memo(function ComputerOverlay() {
  const computerOverlay = useStore(s => s.computerOverlay);

  if (!computerOverlay) return null;

  const { phase, action, errorCode } = computerOverlay;

  return (
    <div className="computer-overlay" id="computerOverlay">
      <div className={`computer-overlay-card computer-${phase}`}>
        <div className="computer-overlay-status">
          {phase === 'running' && <span className="computer-spinner" />}
          <span>{action}</span>
        </div>
        {errorCode && (
          <div className="computer-overlay-error">{errorCode}</div>
        )}
      </div>
    </div>
  );
});
