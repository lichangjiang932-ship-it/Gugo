import { archiveList } from './batchArchiveCatalog.js'
import { archiveCreate } from './batchArchiveZip.js'
import { archiveExtract } from './batchArchiveExtract.js'
import { batchRename } from './batchRenameRuntime.js'
import { BATCH_FILE_TOOL_SPECS } from './batchFileToolSpecs.js'
import { toolError } from './batchFileSupport.js'
import { fileHashManifest } from './batchHashManifest.js'

export { BATCH_FILE_TOOL_SPECS }

export async function dispatchBatchFileTool(name, args = {}, { userId = null, signal = null } = {}) {
  const context = { userId, signal }
  switch (name) {
    case 'archive_create': return archiveCreate(args, context)
    case 'archive_list': return archiveList(args, context)
    case 'archive_extract': return archiveExtract(args, context)
    case 'batch_rename': return batchRename(args, context)
    case 'file_hash_manifest': return fileHashManifest(args, context)
    default: throw toolError(`未知批量文件工具：${name}`, 404, 'BATCH_FILE_TOOL_NOT_FOUND')
  }
}
