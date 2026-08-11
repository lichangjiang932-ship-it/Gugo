---
name: archive-operator
description: >
  Inspect ZIP or RAR4/RAR5 archives, create ZIP archives, or safely extract ZIP
  and RAR4/RAR5 archives; perform staged bulk file or directory renames; and
  find exact duplicates by SHA-256. Use for ZIP/RAR 内容预览、ZIP 压缩、
  ZIP/RAR 解压、批量重命名文件或文件夹、整理目录、查重 and related local-file tasks.
---

# Archive Operator

Use only tools exposed in the current turn and only authorized paths.

1. For an unfamiliar ZIP or RAR archive, call `archive_list` before extraction. Review entry paths, types, expanded size, and compression ratios; do not extract an archive that fails validation.
2. Use `archive_create` or `archive_extract` with `overwrite=false` by default. Verify a newly created ZIP with `archive_list`, or inspect the extracted destination after completion.
3. `archive_create` supports ZIP32 only. `archive_list` and `archive_extract` additionally support single-volume, unencrypted RAR4/RAR5 archives. Do not promise RAR creation, ZIP64, encrypted, or multi-volume archive support; use an explicitly authorized external tool only when available.
4. For `batch_rename`, construct the full source-to-destination map first. A selected directory moves recursively, so never include both that directory and one of its descendants in the same batch. Keep `overwrite=false` unless replacement is explicit.
5. Use one `batch_rename` call for swaps or cycles so the two-stage transaction can preserve every source. Inspect the destination tree after completion.
6. Use `file_hash_manifest` for exact duplicate detection. Report duplicate groups before deleting or replacing anything; the hash tool never removes files.

These path-based tools handle large files without loading binary data into the UTF-8 `read_file` channel.
