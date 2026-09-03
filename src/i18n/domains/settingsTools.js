const translations = {
  "zh": {
    "title": "模型工具",
    "subtitle": "开启后会按工具调用协议把规格发送给模型，由模型自行决定何时调用。",
    "enabled": "开启",
    "disabled": "关闭",
    "tools": {
      "fetch_url": {
        "name": "抓取链接",
        "desc": "让模型把页面正文抓回来转为 Markdown 阅读。"
      },
      "create_pptx": {
        "name": "生成 PPT 文件",
        "desc": "直接生成可预览、可下载的 PPTX 文件。"
      },
      "create_docx": {
        "name": "生成 Word 文件",
        "desc": "直接产出 DOCX 文档或报告。"
      },
      "create_xlsx": {
        "name": "生成 Excel 文件",
        "desc": "直接产出 XLSX 表格。"
      },
      "create_pdf": {
        "name": "生成 PDF 文件",
        "desc": "直接生成支持中文、分页和页码的可下载 PDF 文件。"
      },
      "list_directory": {
        "name": "浏览本地目录",
        "desc": "列出已授权工作区或本地文件夹的内容。"
      },
      "read_file": {
        "name": "读取本地文件",
        "desc": "读取已授权路径内的 UTF-8 文件。"
      },
      "write_file": {
        "name": "写入本地文件",
        "desc": "在已获读写授权的路径内创建或覆盖文件。"
      },
      "edit_file": {
        "name": "编辑本地文件",
        "desc": "在已获读写授权的路径内精确替换文件内容。"
      },
      "apply_patch": {
        "name": "原子补丁",
        "desc": "以 Codex 格式对一个或多个文件执行可回滚的精确补丁。"
      },
      "patch_file": {
        "name": "精确修改文件",
        "desc": "按行范围或 Codex 补丁精确修改文件，并支持哈希校验与预演。"
      },
      "bash_exec": {
        "name": "执行代码与命令",
        "desc": "在已授权的读写目录中运行 Python、Node、PowerShell 和项目命令；是否询问由当前审批模式决定。"
      },
      "run_code": {
        "name": "受限代码计算",
        "desc": "在无文件、Shell、网络、环境变量或模块绑定的资源受限 worker 中运行纯 JavaScript；每次调用都需确认。"
      },
      "run_command": {
        "name": "运行命令",
        "desc": "在已授权工作区执行 Python、Node、PowerShell、构建或任意项目命令，并返回输出与退出码。"
      },
      "run_test": {
        "name": "运行测试",
        "desc": "自动识别或按指定命令运行 npm、pytest、Cargo、Go、Maven 或 Gradle 测试。"
      },
      "docker_exec": {
        "name": "执行 Docker 命令",
        "desc": "在已存在的 Docker 容器中执行命令，并返回标准输出、错误与退出码。"
      },
      "file_download": {
        "name": "下载文件",
        "desc": "将 HTTP/HTTPS 资源流式下载到已授权路径，可校验 SHA-256。"
      },
      "git_status": {
        "name": "Git 状态",
        "desc": "只读查看工作区的 git status。"
      },
      "git_diff": {
        "name": "Git 差异",
        "desc": "只读查看 unified diff。"
      },
      "git_commit": {
        "name": "Git 提交",
        "desc": "经审批后只提交模型明确选中的已修改文件。"
      },
      "git_push": {
        "name": "Git 推送",
        "desc": "经审批后将当前分支非强制推送到 origin。"
      },
      "git_rollback": {
        "name": "Git 回滚",
        "desc": "通过新的 revert 提交安全回滚当前 HEAD，不改写历史。"
      },
      "git_write": {
        "name": "Git 写操作",
        "desc": "以结构化方式提交、创建或切换分支、拉取及非强制推送。"
      },
      "run_project_check": {
        "name": "项目检查",
        "desc": "仅允许运行 lint、test 或 build。"
      },
      "image_info": {
        "name": "图片信息",
        "desc": "读取已授权图片的尺寸、格式、色彩空间和元数据。"
      },
      "image_transform": {
        "name": "图片处理",
        "desc": "缩放、裁剪、旋转、翻转、调整效果或转换图片格式。"
      },
      "media_probe": {
        "name": "音视频信息",
        "desc": "使用 ffprobe 读取已授权音频或视频的流与格式信息。"
      },
      "media_transform": {
        "name": "音视频处理",
        "desc": "剪辑、转码、提取音频、抽帧、变速、GIF、字幕、拼接、降噪或调整音量。"
      },
      "pdf_info": {
        "name": "PDF 信息",
        "desc": "读取页数、元数据、表单字段、加密与签名限制。"
      },
      "pdf_text": {
        "name": "读取 PDF 文本",
        "desc": "按页提取文本及可用于坐标覆盖的文本项，不执行 OCR。"
      },
      "pdf_transform": {
        "name": "PDF 处理",
        "desc": "合并、拆分、旋转、添加中文水印、覆盖文字或填写 PDF 表单。"
      },
      "archive_list": {
        "name": "查看 ZIP 内容",
        "desc": "不解压即可安全列出 ZIP 条目、目录和大小。"
      },
      "archive_create": {
        "name": "创建 ZIP 压缩包",
        "desc": "流式压缩多个已授权文件；默认不覆盖已有文件。"
      },
      "archive_extract": {
        "name": "解压 ZIP 文件",
        "desc": "安全流式解压并阻止路径穿越、符号链接和压缩炸弹。"
      },
      "batch_rename": {
        "name": "批量重命名",
        "desc": "以一次暂存操作重命名多个文件或目录，并安全处理交换与循环。"
      },
      "file_hash_manifest": {
        "name": "文件哈希与查重",
        "desc": "流式计算 SHA-256 清单并找出内容完全相同的文件。"
      }
    }
  },
  "en": {
    "title": "Model tools",
    "subtitle": "Enabled tool specifications are sent to the model, which decides when to call them.",
    "enabled": "On",
    "disabled": "Off",
    "tools": {
      "fetch_url": {
        "name": "Fetch URL",
        "desc": "Fetch a page body and convert it to Markdown for the model."
      },
      "create_pptx": {
        "name": "Create PowerPoint",
        "desc": "Generate a previewable, downloadable PPTX file."
      },
      "create_docx": {
        "name": "Create Word document",
        "desc": "Generate a DOCX document or report."
      },
      "create_xlsx": {
        "name": "Create Excel workbook",
        "desc": "Generate an XLSX workbook."
      },
      "create_pdf": {
        "name": "Create PDF document",
        "desc": "Generate a downloadable PDF with Unicode text, pagination, and page numbers."
      },
      "list_directory": {
        "name": "Browse local folders",
        "desc": "List contents in an authorized workspace or local folder."
      },
      "read_file": {
        "name": "Read local file",
        "desc": "Read a UTF-8 file from an authorized path."
      },
      "write_file": {
        "name": "Write local file",
        "desc": "Create or replace a file in a path with write access."
      },
      "edit_file": {
        "name": "Edit local file",
        "desc": "Precisely replace content in a file with write access."
      },
      "apply_patch": {
        "name": "Atomic patch",
        "desc": "Apply a rollback-safe Codex-format patch to one or more files."
      },
      "patch_file": {
        "name": "Patch file",
        "desc": "Patch an exact line range or apply a Codex patch with hash checks and dry-run support."
      },
      "bash_exec": {
        "name": "Run code and commands",
        "desc": "Run Python, Node, PowerShell, and project commands in an authorized writable folder; mutating commands still require confirmation."
      },
      "run_code": {
        "name": "Bounded code computation",
        "desc": "Run pure JavaScript in a resource-bounded worker without file, shell, network, environment, or module bindings; every call requires confirmation."
      },
      "run_command": {
        "name": "Run command",
        "desc": "Run Python, Node, PowerShell, builds, or arbitrary project commands and return output and exit status."
      },
      "run_test": {
        "name": "Run tests",
        "desc": "Auto-detect or explicitly run npm, pytest, Cargo, Go, Maven, or Gradle tests."
      },
      "docker_exec": {
        "name": "Run in Docker",
        "desc": "Execute a command in an existing Docker container and return output, errors, and exit status."
      },
      "file_download": {
        "name": "Download file",
        "desc": "Stream an HTTP/HTTPS resource into an authorized path with optional SHA-256 verification."
      },
      "git_status": {
        "name": "Git status",
        "desc": "Read the workspace git status."
      },
      "git_diff": {
        "name": "Git diff",
        "desc": "Read a unified diff."
      },
      "git_commit": {
        "name": "Git commit",
        "desc": "After approval, commit only the explicitly selected changed files."
      },
      "git_push": {
        "name": "Git push",
        "desc": "After approval, push the current branch to origin without force."
      },
      "git_rollback": {
        "name": "Git rollback",
        "desc": "Safely revert the current HEAD with a new commit without rewriting history."
      },
      "git_write": {
        "name": "Git write",
        "desc": "Commit, create or switch branches, pull, or push without force through structured actions."
      },
      "run_project_check": {
        "name": "Project checks",
        "desc": "Run only lint, test, or build commands."
      },
      "image_info": {
        "name": "Image information",
        "desc": "Read dimensions, format, color space, and metadata from an authorized image."
      },
      "image_transform": {
        "name": "Transform image",
        "desc": "Resize, crop, rotate, flip, adjust, or convert an image."
      },
      "media_probe": {
        "name": "Audio/video information",
        "desc": "Use ffprobe to inspect streams and formats in authorized audio or video."
      },
      "media_transform": {
        "name": "Transform audio/video",
        "desc": "Trim, transcode, extract audio/frames, change speed, create GIFs, burn subtitles, concatenate, denoise, or adjust volume."
      },
      "pdf_info": {
        "name": "PDF information",
        "desc": "Inspect pages, metadata, form fields, encryption, and signature limitations."
      },
      "pdf_text": {
        "name": "Read PDF text",
        "desc": "Extract page text and positioned text items without OCR."
      },
      "pdf_transform": {
        "name": "Transform PDF",
        "desc": "Merge, split, rotate, add CJK watermarks, overlay text, or fill PDF forms."
      },
      "archive_list": {
        "name": "List ZIP contents",
        "desc": "Safely list ZIP entries, folders, and sizes without extracting."
      },
      "archive_create": {
        "name": "Create ZIP archive",
        "desc": "Stream-compress authorized files without overwriting existing output by default."
      },
      "archive_extract": {
        "name": "Extract ZIP archive",
        "desc": "Stream-extract safely with path traversal, symlink, and zip-bomb protection."
      },
      "batch_rename": {
        "name": "Batch rename",
        "desc": "Rename many files or whole directories as one staged operation, including swaps and cycles."
      },
      "file_hash_manifest": {
        "name": "File hashes and duplicates",
        "desc": "Stream SHA-256 manifests and find files with exactly matching content."
      }
    }
  }
}

export default translations
