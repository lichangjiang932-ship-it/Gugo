import { artifactInstructionText } from './artifactIntentSupport.js'
import { isToolFreeResponseRequest } from './toolFreeResponseIntent.js'

// Revision disposition is independent of artifact type discovery and path
// ownership: preserve the original, replace it, or create a separate copy.
export const ARTIFACT_REPLACE_ORIGINAL_CUE = /(?:原地(?:修改|编辑|更新|覆盖)|(?:修改|编辑|更新|覆盖|改动?|调整)(?:原版|原文件|原文档|原表格|原演示|当前文件|当前版本|上一版)|(?:在|基于)(?:原版|原文件|当前文件|当前版本|上一版)(?:上|中|直接)?(?:修改|编辑|更新|覆盖|改动?|调整)|直接覆盖(?:原版|原文件|当前文件|上一版)|(?:edit|update|modify|overwrite)\s+(?:the\s+)?(?:original|existing|same)\s+(?:file|artifact|document|deck|workbook|page)|in[ -]?place)/i
export const ARTIFACT_OBJECT_TRANSFORMATION = /(?:^|[\s,，。；;!！])(?:请|帮我|麻烦(?:你)?|继续|直接)?\s*(?:把|将)\s*(?:它|这个(?:网页|网站|页面|文件|文档|表格|演示)?|该(?:网页|网站|页面|文件|文档|表格|演示)|当前(?:网页|网站|页面|文件|文档|表格|演示)|网页|网站|页面)\s*(?:做成|改成|改为|改造(?:成|为)|变成|转成|转为)/i
export const ARTIFACT_CREATE_COPY_CUE = /(?:(?:新建|另建|另做|另生成|另外生成|重新创建)(?:一|1)?(?:个|份)?(?:新)?(?:文件|版本|副本)?|(?:创建|生成|制作)(?:一|1)?(?:个|份)?新(?:文件|版本|副本)|另存为|(?:create|make|save)\s+(?:a\s+)?(?:new|separate)\s+(?:file|copy|version))/i
export const ARTIFACT_CREATE_COPY_DENIAL = /(?:(?:不要|别|无需)(?:再)?(?:新建|另建|另做|新生成|创建新(?:文件|版本|副本))|without\s+creating\s+(?:a\s+)?new\s+(?:file|copy))/gi
export const ARTIFACT_REPLACE_ORIGINAL_DENIAL = /(?:(?:保留|不改|不要修改|不要覆盖)(?:原版|原文件|当前文件|上一版)|keep\s+(?:the\s+)?original)/gi
export const ARTIFACT_FILENAME_PRESERVATION = /(?:(?:保留|保持|维持|不改|不修改|别修改|不要修改|不要更改|不要改变|别更改|别改变)\s*(?:(?:原|当前)\s*)?文件\s*(?:名(?:称)?|的\s*(?:文件\s*)?名(?:称)?)|(?:keep|preserve|retain|do\s+not\s+change|don't\s+change|dont\s+change)\s+(?:the\s+)?(?:(?:original|existing|same|current)\s+)?(?:file\s*name|filename))/gi

export function resolveArtifactRevisionMode(prompt = '') {
  if (isToolFreeResponseRequest(prompt)) return 'unspecified'
  const text = artifactInstructionText(prompt).trim()
  if (!text) return 'unspecified'
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const preserveFilename = ARTIFACT_FILENAME_PRESERVATION.test(text)
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const dispositionText = text.replace(ARTIFACT_FILENAME_PRESERVATION, ' ')
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopyDenied = ARTIFACT_CREATE_COPY_DENIAL.test(dispositionText)
  const replaceOriginalDenied = ARTIFACT_REPLACE_ORIGINAL_DENIAL.test(dispositionText)
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopy = replaceOriginalDenied
    || ARTIFACT_CREATE_COPY_CUE.test(dispositionText.replace(ARTIFACT_CREATE_COPY_DENIAL, ''))
  const replaceOriginal = createCopyDenied
    || ARTIFACT_REPLACE_ORIGINAL_CUE.test(dispositionText.replace(ARTIFACT_REPLACE_ORIGINAL_DENIAL, ''))
    || (!createCopy && ARTIFACT_OBJECT_TRANSFORMATION.test(dispositionText))
    || (preserveFilename && !createCopy)
  if (replaceOriginal && createCopy) return 'conflict'
  if (replaceOriginal) return 'replace_original'
  if (createCopy) return 'create_copy'
  return 'unspecified'
}
