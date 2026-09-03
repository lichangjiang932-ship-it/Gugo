const translations = {
  "zh": {
    "compactedTitle": "浏览器兼容存储配额不足",
    "compactedBody": "IndexedDB 不可用时已改用受限兼容存储；全部会话和消息正文仍保留，仅省略可重新生成的大型元数据。建议导出备份。",
    "quotaTitle": "浏览器会话存储配额已满",
    "quotaBody": "最新更改尚未持久化，上一次成功保存的快照仍然保留。请先导出当前会话，再清理当前站点的浏览器存储。",
    "unavailableTitle": "浏览器会话存储不可用",
    "unavailableBody": "浏览器阻止了当前站点使用持久存储。当前内容可能只存在于本页面，请立即导出会话备份。",
    "errorTitle": "会话保存失败",
    "errorBody": "浏览器存储发生异常，上一次成功保存的快照仍然保留。请导出备份后重试。",
    "exportSessions": "导出全部会话",
    "dismiss": "关闭存储提醒"
  },
  "en": {
    "compactedTitle": "Browser fallback storage is limited",
    "compactedBody": "IndexedDB was unavailable, so limited fallback storage was used. All conversation text remains; only regenerable large metadata was omitted. Export a backup.",
    "quotaTitle": "Browser session storage quota is full",
    "quotaBody": "The latest changes were not persisted. The last successful snapshot remains intact. Export current conversations before clearing this site’s browser storage.",
    "unavailableTitle": "Browser session storage is unavailable",
    "unavailableBody": "The browser blocked persistent storage for this site. Current content may exist only in this page; export a backup now.",
    "errorTitle": "Conversation save failed",
    "errorBody": "Browser storage returned an unexpected error. The last successful snapshot remains intact. Export a backup and retry.",
    "exportSessions": "Export all conversations",
    "dismiss": "Dismiss storage warning"
  }
}

export default translations
