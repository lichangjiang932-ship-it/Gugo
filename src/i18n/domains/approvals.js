const translations = {
  "zh": {
    "nav": "审批",
    "risk": {
      "high": "高风险",
      "medium": "中风险",
      "low": "低风险"
    },
    "source": {
      "label": "风险来源",
      "declared": "显式声明",
      "fallback": "兼容兜底"
    },
    "origin": {
      "job": "后台任务",
      "subagent": "子代理",
      "chat": "对话"
    },
    "mode": {
      "label": "权限",
      "normal": "正常",
      "normalHint": "写文件、执行命令、对外请求都会先问你",
      "acceptEdits": "自动接受编辑",
      "acceptEditsHint": "改文件不再问，执行命令和对外请求仍然问",
      "plan": "计划模式",
      "planHint": "只读。模型只能看和想，任何写操作直接拒绝",
      "bypass": "全部放行",
      "bypassHint": "不再询问任何操作。仅在完全信任的本机环境使用",
      "escalationConfirm": "此操作会放宽模型权限。确认继续吗？",
      "bypassJustification": "请输入切换到“全部放行”的理由（必填）：",
      "escalationPendingTitle": "权限升级等待审批",
      "escalationPendingBody": "当前权限未改变。请在审批收件箱批准后生效。"
    },
    "inbox": {
      "title": "审批收件箱",
      "subtitle": "无人值守的后台任务和定时任务需要批准时，会排队到这里。日常对话里的审批直接在对话中完成。",
      "refresh": "刷新",
      "statPending": "待审批",
      "statHighRisk": "高风险",
      "empty": "没有待审批的操作。",
      "emptyHint": "后台任务调用 shell、写文件或代你操作浏览器时，会出现在这里。",
      "approve": "批准",
      "deny": "拒绝",
      "edit": "改写参数",
      "approveEdited": "按改写后批准",
      "cancelEdit": "取消",
      "jsonMustBeObject": "参数必须是一个 JSON 对象。"
    }
  },
  "en": {
    "nav": "Approvals",
    "risk": {
      "high": "High risk",
      "medium": "Medium risk",
      "low": "Low risk"
    },
    "source": {
      "label": "Risk source",
      "declared": "Declared metadata",
      "fallback": "Compatibility fallback"
    },
    "origin": {
      "job": "Background job",
      "subagent": "Subagent",
      "chat": "Chat"
    },
    "mode": {
      "label": "Permissions",
      "normal": "Normal",
      "normalHint": "Ask before writing files, running commands, or outbound requests",
      "acceptEdits": "Accept edits",
      "acceptEditsHint": "File edits go through; commands and outbound requests still ask",
      "plan": "Plan mode",
      "planHint": "Read-only. The model can look and think; writes are refused",
      "bypass": "Bypass all",
      "bypassHint": "Never ask. Only for a fully trusted local machine",
      "escalationConfirm": "This change broadens model permissions. Continue?",
      "bypassJustification": "Enter a required reason for enabling “Bypass all”:",
      "escalationPendingTitle": "Permission upgrade pending",
      "escalationPendingBody": "Permissions are unchanged until you approve the request in the approval inbox."
    },
    "inbox": {
      "title": "Approval inbox",
      "subtitle": "Unattended background and scheduled jobs queue their approval requests here. Approvals during a chat happen inline in the conversation.",
      "refresh": "Refresh",
      "statPending": "Pending",
      "statHighRisk": "High risk",
      "empty": "Nothing waiting for approval.",
      "emptyHint": "Shell commands, file writes, and browser actions from background jobs appear here.",
      "approve": "Approve",
      "deny": "Deny",
      "edit": "Edit arguments",
      "approveEdited": "Approve with edits",
      "cancelEdit": "Cancel",
      "jsonMustBeObject": "Arguments must be a JSON object."
    }
  }
}

export default translations
