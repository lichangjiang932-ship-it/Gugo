const translations = {
  "zh": {
    "title": "记忆中心",
    "subtitle": "长期记住的用户偏好、反馈和项目背景，并注入到每次对话",
    "add": "新增",
    "all": "全部",
    "allAgents": "所有 agent",
    "globalOnly": "仅全局",
    "agentOnly": "仅 {name}",
    "search": "搜索标题或内容…",
    "loading": "加载中…",
    "empty": "还没有记忆，点击「新增」开始。",
    "selectHint": "左侧选择记忆，或点「新增」创建一条",
    "editTitle": "编辑记忆",
    "newTitle": "新建记忆",
    "close": "关闭",
    "type": "类型",
    "titleLabel": "标题",
    "titlePlaceholder": "一句话描述这条记忆",
    "bodyLabel": "内容 (markdown)",
    "bodyPlaceholder": "比如：\n用户偏好用 TypeScript + Vite，不喜欢冗长注释。\n相关：[[design-style]]",
    "linkHint": "支持 [[slug]] 形式链接其他记忆",
    "pinned": "置顶（优先注入到模型上下文）",
    "bindAgent": "绑定到 agent",
    "globalAgent": "全局（所有 agent 可见）",
    "current": "（当前）",
    "agentHint": "选“全局”则任何 agent 谈话都能看到；选具体 agent 则仅该 agent 生效。",
    "saving": "保存中…",
    "save": "保存",
    "delete": "删除",
    "confirmDelete": "删除这条记忆？此操作不可撤销。",
    "loadFailed": "加载失败",
    "saveFailed": "保存失败",
    "deleteFailed": "删除失败",
    "types": {
      "user": [
        "用户",
        "关于用户的长期事实（角色、偏好）"
      ],
      "feedback": [
        "反馈",
        "校正过的工作方式，下次重复"
      ],
      "project": [
        "项目",
        "项目背景、约束、决策"
      ],
      "reference": [
        "引用",
        "用户指定要记住的资料片段"
      ]
    }
  },
  "en": {
    "title": "Memory",
    "subtitle": "Long-term user preferences, feedback, and project context injected into each conversation",
    "add": "Add",
    "all": "All",
    "allAgents": "All agents",
    "globalOnly": "Global only",
    "agentOnly": "{name} only",
    "search": "Search title or content…",
    "loading": "Loading…",
    "empty": "No memories yet. Select Add to create one.",
    "selectHint": "Select a memory on the left or choose Add to create one",
    "editTitle": "Edit memory",
    "newTitle": "New memory",
    "close": "Close",
    "type": "Type",
    "titleLabel": "Title",
    "titlePlaceholder": "Describe this memory in one sentence",
    "bodyLabel": "Content (Markdown)",
    "bodyPlaceholder": "Example:\nThe user prefers TypeScript + Vite and concise comments.\nRelated: [[design-style]]",
    "linkHint": "Use [[slug]] to link another memory",
    "pinned": "Pin (inject into model context first)",
    "bindAgent": "Bind to agent",
    "globalAgent": "Global (visible to all agents)",
    "current": " (current)",
    "agentHint": "Global memories are visible to every agent; agent-specific memories apply only to that agent.",
    "saving": "Saving…",
    "save": "Save",
    "delete": "Delete",
    "confirmDelete": "Delete this memory? This cannot be undone.",
    "loadFailed": "Failed to load",
    "saveFailed": "Failed to save",
    "deleteFailed": "Failed to delete",
    "types": {
      "user": [
        "User",
        "Long-term facts about the user, role, and preferences"
      ],
      "feedback": [
        "Feedback",
        "Corrected working patterns to repeat next time"
      ],
      "project": [
        "Project",
        "Project background, constraints, and decisions"
      ],
      "reference": [
        "Reference",
        "Material the user explicitly asked to remember"
      ]
    }
  }
}

export default translations
