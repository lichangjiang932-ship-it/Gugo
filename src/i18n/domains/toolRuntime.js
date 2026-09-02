const translations = {
  "zh": {
    "unavailable": "工具 {name} 在当前环境不可用（已失败 {count} 次，接口未注册或无权限）。换参数重试没有意义，请改用其他工具，并在最终回复里说明该功能不可用。",
    "repeated": "同一工具调用已重复 {count} 次，未取得新进展",
    "consecutiveErrors": "工具已连续失败 {count} 次",
    "clippedHint": "结果过长，请缩小查询范围、分页或只读取相关片段。",
    "undeclared": "工具 {name} 未在本轮声明，已拒绝执行。只有用户本轮明确要求的文件类型才能生成。",
    "artifactNotRequested": "用户没有明确要求生成 {name} 文件，本轮拒绝执行。",
    "labels": {
      "readFile": "读取文件",
      "writeFile": "写入文件",
      "applyPatch": "修改文件",
      "listDirectory": "浏览目录",
      "codeSearch": "搜索代码",
      "bashExec": "执行命令",
      "gitStatus": "查看 Git 状态",
      "gitDiff": "查看改动",
      "gitCommit": "提交改动",
      "gitPush": "推送",
      "webSearch": "搜索网页",
      "fetchUrl": "抓取网页",
      "createDocx": "生成 Word 文档",
      "createPptx": "生成 PPT",
      "createXlsx": "生成表格",
      "unknown": "未知工具"
    },
    "summary": {
      "outputBudget": "模型的输出预算（max_tokens）在写总结前就用完了，所以没有生成文字说明。",
      "reasoningBudget": "推理模型的“思考过程”也算进这个预算。可以在设置里调大 Max Tokens，或换一个非推理模型。",
      "noText": "模型执行完工具后没有给出文字总结。以下是根据实际执行记录自动生成的说明。",
      "completed": "已完成的操作",
      "changes": "改动的内容",
      "more": "另有 {count} 项",
      "failed": "失败的步骤",
      "moreFailed": "另有 {count} 项失败",
      "artifact": "产出文件",
      "file": "文件",
      "next": "接下来",
      "incomplete": "上面失败的步骤可能导致任务不完整，建议先确认这些错误。",
      "unverified": "以上是自动汇总，**没有经过模型确认**，请核对实际改动。",
      "askSummary": "可以直接回复“总结一下你刚才做了什么”让模型补一份说明。"
    }
  },
  "en": {
    "unavailable": "Tool {name} is unavailable in this environment after {count} failures. Changing arguments will not help; use another tool and report the limitation.",
    "repeated": "The same tool call was repeated {count} times without progress",
    "consecutiveErrors": "Tools failed {count} times in a row",
    "clippedHint": "The result is too long. Narrow the query, paginate, or read only the relevant section.",
    "undeclared": "Tool {name} was not declared for this turn and was blocked. File types are available only when explicitly requested.",
    "artifactNotRequested": "The user did not explicitly request a {name} file, so this turn blocked the operation.",
    "labels": {
      "readFile": "Read file",
      "writeFile": "Write file",
      "applyPatch": "Modify file",
      "listDirectory": "List directory",
      "codeSearch": "Search code",
      "bashExec": "Run command",
      "gitStatus": "Check Git status",
      "gitDiff": "View changes",
      "gitCommit": "Commit changes",
      "gitPush": "Push changes",
      "webSearch": "Search the web",
      "fetchUrl": "Fetch URL",
      "createDocx": "Create Word document",
      "createPptx": "Create presentation",
      "createXlsx": "Create spreadsheet",
      "unknown": "Unknown tool"
    },
    "summary": {
      "outputBudget": "The model exhausted its output budget (max_tokens) before writing a summary.",
      "reasoningBudget": "Reasoning also consumes this budget. Increase Max Tokens or use a non-reasoning model.",
      "noText": "The model finished its tools without a written summary. This summary was generated from the execution record.",
      "completed": "Completed operations",
      "changes": "Changes made",
      "more": "{count} more",
      "failed": "Failed steps",
      "moreFailed": "{count} more failures",
      "artifact": "Generated file",
      "file": "File",
      "next": "Next",
      "incomplete": "The failed steps may leave the task incomplete. Review those errors first.",
      "unverified": "This is an automatic summary and **was not confirmed by the model**. Verify the actual changes.",
      "askSummary": "Reply “summarize what you just did” to ask the model for a full explanation."
    }
  }
}

export default translations
