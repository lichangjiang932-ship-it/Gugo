const translations = {
  "zh": {
    "sent": "已将指令追加到当前任务",
    "failed": "追加指令失败，内容已恢复到输入框",
    "textOnly": "当前任务运行中，请输入文字指令后发送",
    "turnRunning": "当前对话仍有任务在运行，请先停止或等待完成。",
    "sendPending": "上一次发送正在确认模型状态，请稍候或重试。",
    "directoryAuthorizationRequired": "原任务正在等待目录授权，请在上方授权卡选择或确认目录后继续。",
    "directoryResumePending": "目录已授权，正在恢复原任务，请稍候。"
  },
  "en": {
    "sent": "Instruction added to the current task",
    "failed": "Could not add the instruction. Your draft was restored.",
    "textOnly": "Enter a text instruction to update the running task.",
    "turnRunning": "A task is still running in this conversation. Stop it or wait for it to finish.",
    "sendPending": "The previous send is still checking the model. Wait a moment and try again.",
    "directoryAuthorizationRequired": "The original task is waiting for directory access. Choose or confirm a directory in the authorization card above.",
    "directoryResumePending": "Directory access is granted. Resuming the original task…"
  }
}

export default translations
