/**
 * Labels for the ReAct completion report and its folded trajectory.
 *
 * Kept in its own domain so it stays a cohesive unit: these label what the
 * *agent* produced (Thought / Action / Observation) rather than chat chrome.
 */
const translations = {
  "zh": {
    "thought": "思考",
    "action": "行动",
    "observation": "观察",
    "fileWrote": "写入",
    "fileMany": "{count} 个文件",
    "fileChanges": "变更 {count} 处",
    "fileBytes": "{count} 字节",
    "fileAdditions": "+{count} 行",
    "fileDeletions": "-{count} 行",
    "badgeChanges": "变更 {value}",
    "badgeAdditions": "+{value}",
    "badgeDeletions": "-{value}",
    "badgeBytes": "{value} 字节",
    "badgeSha256": "sha {value}"
  },
  "en": {
    "thought": "Thought",
    "action": "Action",
    "observation": "Observation",
    "fileWrote": "Wrote",
    "fileMany": "{count} files",
    "fileChanges": "{count} changes",
    "fileBytes": "{count} bytes",
    "fileAdditions": "+{count} lines",
    "fileDeletions": "-{count} lines",
    "badgeChanges": "{value} changes",
    "badgeAdditions": "+{value}",
    "badgeDeletions": "-{value}",
    "badgeBytes": "{value} bytes",
    "badgeSha256": "sha {value}"
  }
}

export default translations
