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
    "errors": {
      "unauthorized": "当前会话不可用或已过期。请刷新页面后重试。",
      "forbidden": "当前会话无权操作此审批。请刷新并检查可用的审批。",
      "notFound": "此审批不可用。请刷新审批列表。",
      "expired": "此审批已过期。请刷新状态；仍需执行时，请重新发起审批。",
      "conflict": "审批状态已变化，未能确认本次操作。请刷新状态后再决定。",
      "stalePermissions": "此审批创建后权限已变化。请刷新状态并重新发起权限升级。",
      "escalationRequired": "放宽权限需要你的明确批准。请先检查并确认权限升级请求。",
      "editForbidden": "权限升级审批不能改写参数。请审核原请求，或重新发起审批。",
      "rememberForbidden": "权限升级审批不能保存为长期授权。请单独审核本次请求。",
      "invalidArguments": "改写参数必须是有效的 JSON 对象，并符合工具要求。",
      "invalidRequest": "审批请求无效。请检查操作与参数，并刷新审批状态。",
      "unavailable": "审批服务未能确认此次请求。请先刷新状态，不要重复提交。",
      "unknown": "未能确认审批请求的结果。请先刷新状态，不要重复提交。"
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
    "errors": {
      "unauthorized": "Your session is unavailable or expired. Reload the page and try again.",
      "forbidden": "Your session cannot access this approval. Refresh and review the available approvals.",
      "notFound": "This approval is unavailable. Refresh the approval list.",
      "expired": "This approval expired. Refresh its status and request a new approval if the action is still needed.",
      "conflict": "The approval state changed, so this action could not be confirmed. Refresh its status before deciding again.",
      "stalePermissions": "Permissions changed after this approval was created. Refresh the status and request a new permission upgrade.",
      "escalationRequired": "Broader permissions require your explicit approval. Review and confirm the permission upgrade request first.",
      "editForbidden": "Permission upgrade arguments cannot be edited. Review the original request or request a new approval.",
      "rememberForbidden": "A permission upgrade cannot be saved as a standing grant. Review this request individually.",
      "invalidArguments": "Edited arguments must be a valid JSON object that meets the tool requirements.",
      "invalidRequest": "The approval request is invalid. Check the action and arguments, then refresh the approval status.",
      "unavailable": "The approval service could not confirm this request. Refresh its status before submitting again.",
      "unknown": "The approval request outcome could not be confirmed. Refresh its status before submitting again."
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
