/**
 * SlashCommandMenu — 斜杠命令菜单
 *
 * 参考 openhanako 的 SlashCommandMenu，显示可用的 / 命令列表。
 */

import { useRef, useEffect } from 'react';

export function SlashCommandMenu({ commands, selectedIndex, onSelect, onClose }) {
  const menuRef = useRef(null);
  const itemRefs = useRef([]);

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el && menuRef.current) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Click outside to close
  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div ref={menuRef} className="slash-menu" id="slashMenu">
      <div className="slash-menu-header">命令</div>
      <div className="slash-menu-list">
        {commands.map((cmd, i) => (
          <button
            key={cmd.name}
            ref={el => itemRefs.current[i] = el}
            className={`slash-menu-item ${i === selectedIndex ? 'selected' : ''}`}
            onClick={() => onSelect(cmd)}
          >
            <span className="slash-icon" dangerouslySetInnerHTML={{ __html: cmd.icon }} />
            <div className="slash-info">
              <span className="slash-label">{cmd.label}</span>
              <span className="slash-desc">{cmd.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
