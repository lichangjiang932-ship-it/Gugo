/**
 * WelcomeScreen — 欢迎屏幕
 *
 * 参考 openhanako 的 WelcomeScreen，显示 Agent 头像、
 * 欢迎语、快捷操作。
 */

import { useMemo } from 'react';
import { useStore } from '../../stores';
import './welcome.css';

const WELCOME_MESSAGES = [
  '你好！我是你的 AI 助手，准备好帮助你完成各种任务了。',
  '有什么我可以帮你的吗？无论是编程、写作还是分析，我都在这里。',
  '很高兴见到你！让我们开始一段高效的协作吧。',
  '欢迎来到 AI 工作台。我可以帮你写代码、分析数据、生成图表等等。',
];

function AgentAvatar({ name, avatarUrl, size = 64 }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className="welcome-avatar-img"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="welcome-avatar-fallback"
      style={{ width: size, height: size }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function SuggestionCard({ icon, title, description, onClick }) {
  return (
    <button className="suggestion-card" onClick={onClick}>
      <span className="suggestion-icon">{icon}</span>
      <span className="suggestion-title">{title}</span>
      <span className="suggestion-desc">{description}</span>
    </button>
  );
}

export function WelcomeScreen() {
  const agentName = useStore(s => s.agentName);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const welcomeVisible = useStore(s => s.welcomeVisible);

  const greeting = useMemo(() => {
    return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
  }, [welcomeVisible]);

  const handleSuggestion = (text) => {
    const setWelcomeVisible = useStore.getState().setWelcomeVisible;
    const state = useStore.getState();
    const sid = state.currentSessionId;
    if (sid) {
      state.setSessionDraft(sid, text);
    }
    setWelcomeVisible(false);
  };

  if (!welcomeVisible) return null;

  return (
    <div className="welcome-screen" id="welcome">
      <div className="welcome-content">
        <AgentAvatar name={agentName} avatarUrl={agentAvatarUrl} size={72} />
        <h1 className="welcome-title">{agentName}</h1>
        <p className="welcome-greeting">{greeting}</p>

        <div className="suggestions-grid">
          <SuggestionCard
            icon="💻"
            title="编写代码"
            description="帮我写一个 Python 脚本处理数据"
            onClick={() => handleSuggestion('帮我写一个 Python 脚本，用于处理 CSV 数据文件，包含数据清洗、统计分析和可视化功能。')}
          />
          <SuggestionCard
            icon="📊"
            title="数据分析"
            description="分析这个数据集并生成图表"
            onClick={() => handleSuggestion('请分析以下数据，生成统计摘要和可视化图表：\n\n[请粘贴你的数据]')}
          />
          <SuggestionCard
            icon="📝"
            title="文档写作"
            description="帮我写一份技术文档"
            onClick={() => handleSuggestion('帮我写一份技术文档，介绍一个 REST API 的设计规范，包括认证、端点、请求/响应格式等。')}
          />
          <SuggestionCard
            icon="🧠"
            title="深度研究"
            description="帮我调研一个技术话题"
            onClick={() => handleSuggestion('请帮我深度调研一下当前 AI Agent 领域的主流框架和工具，对比它们的优缺点和适用场景。')}
          />
        </div>
      </div>
    </div>
  );
}
