const translations = {
  "zh": {
    "menuLabel": "斜杠命令",
    "sourceCore": "内置",
    "sourcePlugin": "插件",
    "sourceSkill": "技能",
    "noMatches": "没有匹配的操作",
    "navigate": "选择",
    "select": "执行",
    "close": "关闭",
    "actionLabels": {
      "clear": "清空聊天",
      "context": "上下文",
      "copy": "复制回复",
      "help": "帮助",
      "model": "模型",
      "new": "新聊天",
      "permissions": "权限",
      "retry": "重试",
      "status": "状态"
    },
    "confirmClear": "清空当前会话的所有消息？此操作不可撤销。",
    "helpTitle": "可用斜杠命令",
    "commands": {
      "new": {
        "description": "新建会话，可附带标题",
        "defaultTitle": "新对话",
        "done": "已新建会话：{title}"
      },
      "status": {
        "description": "查看当前模型、消息与任务状态",
        "done": "模型：{model} · 消息：{messages} · 运行中任务：{running}",
        "noModel": "未选择"
      },
      "model": {
        "description": "打开模型列表或直接切换模型",
        "list": "当前：{current}\n可用：{models}",
        "none": "暂无可用模型",
        "unknown": "未找到模型：{model}",
        "done": "已切换模型：{model}"
      },
      "theme": {
        "description": "切换浅色、纯白、深色或系统主题",
        "missing": "用法：/theme light|white|dark|system",
        "done": "主题已切换为：{theme}"
      },
      "context": {
        "description": "显示或隐藏上下文占用条",
        "invalid": "用法：/context show|hide|toggle",
        "shown": "已显示上下文占用条。",
        "hidden": "已隐藏上下文占用条。"
      },
      "permissions": {
        "description": "打开真实权限中心",
        "done": "已打开权限中心。"
      },
      "access": {
        "description": "打开应用连接中心",
        "done": "已打开连接中心。"
      },
      "tasks": {
        "description": "打开后台任务面板",
        "done": "已打开任务面板。"
      },
      "copy": {
        "description": "复制最近一条助手回复",
        "done": "已复制最近一条助手回复。",
        "empty": "没有可复制的助手回复。"
      },
      "export": {
        "description": "导出当前会话为 Markdown 或 JSON",
        "done": "已导出当前会话为 {format}。",
        "empty": "没有当前会话可导出。"
      },
      "clear": {
        "description": "清空当前会话所有消息",
        "done": "已清空当前会话。"
      },
      "retry": {
        "description": "重发上一条用户消息",
        "done": "正在重发上一条用户消息。",
        "empty": "没有可重发的用户消息。"
      },
      "title": {
        "description": "修改当前会话标题",
        "done": "已将标题改为：{title}",
        "missing": "请在 /title 后输入新标题。"
      },
      "search": {
        "description": "打开会话搜索并预填关键词",
        "done": "已打开搜索：{query}",
        "opened": "已打开会话搜索。"
      },
      "archive": {
        "description": "归档当前会话",
        "done": "已归档当前会话。",
        "empty": "没有当前会话可归档。"
      },
      "help": {
        "description": "列出所有可用斜杠命令"
      }
    }
  },
  "en": {
    "menuLabel": "Slash commands",
    "sourceCore": "core",
    "sourcePlugin": "plugin",
    "sourceSkill": "skill",
    "noMatches": "No matching actions",
    "navigate": "Navigate",
    "select": "Select",
    "close": "Close",
    "actionLabels": {
      "clear": "Clear chat",
      "context": "Context",
      "copy": "Copy reply",
      "help": "Help",
      "model": "Model",
      "new": "New chat",
      "permissions": "Permissions",
      "retry": "Retry",
      "status": "Status"
    },
    "confirmClear": "Clear all messages in the current session? This cannot be undone.",
    "helpTitle": "Available slash commands",
    "commands": {
      "new": {
        "description": "Start a new session with an optional title",
        "defaultTitle": "New chat",
        "done": "Created session: {title}"
      },
      "status": {
        "description": "Show the current model, messages, and running tasks",
        "done": "Model: {model} · Messages: {messages} · Running tasks: {running}",
        "noModel": "not selected"
      },
      "model": {
        "description": "Open the model list or switch models directly",
        "list": "Current: {current}\nAvailable: {models}",
        "none": "No models available",
        "unknown": "Model not found: {model}",
        "done": "Switched model to: {model}"
      },
      "theme": {
        "description": "Switch light, pure white, dark, or system theme",
        "missing": "Usage: /theme light|white|dark|system",
        "done": "Theme switched to: {theme}"
      },
      "context": {
        "description": "Show or hide the context usage bar",
        "invalid": "Usage: /context show|hide|toggle",
        "shown": "Context usage bar shown.",
        "hidden": "Context usage bar hidden."
      },
      "permissions": {
        "description": "Open the real permissions center",
        "done": "Opened permissions."
      },
      "access": {
        "description": "Open app connections",
        "done": "Opened connections."
      },
      "tasks": {
        "description": "Open background tasks",
        "done": "Opened tasks."
      },
      "copy": {
        "description": "Copy the latest assistant response",
        "done": "Copied the latest assistant response.",
        "empty": "No assistant response to copy."
      },
      "export": {
        "description": "Export the current session as Markdown or JSON",
        "done": "Exported the session as {format}.",
        "empty": "No current session to export."
      },
      "clear": {
        "description": "Clear all messages in the current session",
        "done": "Current session cleared."
      },
      "retry": {
        "description": "Retry the previous user message",
        "done": "Retrying the previous user message.",
        "empty": "No user message to retry."
      },
      "title": {
        "description": "Rename the current session",
        "done": "Renamed session to: {title}",
        "missing": "Type a new title after /title."
      },
      "search": {
        "description": "Open session search with a prefilled query",
        "done": "Opened search for: {query}",
        "opened": "Opened session search."
      },
      "archive": {
        "description": "Archive the current session",
        "done": "Current session archived.",
        "empty": "No current session to archive."
      },
      "help": {
        "description": "List all available slash commands"
      }
    }
  }
}

export default translations
