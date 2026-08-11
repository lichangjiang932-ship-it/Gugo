---
name: image-operator
description: >
  Inspect and transform image files: convert format, resize, crop, rotate,
  flip, grayscale, blur, sharpen, normalize, or batch related operations. Use
  for 图片格式转换、缩放、裁剪、滤镜、EXIF/元数据 and image-processing requests.
---

# Image Operator

1. Call `image_info` before transformation to inspect dimensions, format, alpha, animation/pages, orientation, and available EXIF metadata.
2. Use `image_transform` with an explicit output path. Preserve the source and keep `overwrite` false unless replacement was requested.
3. When resizing, specify the intended fit behavior. Use crop coordinates only when the user supplied or approved them.
4. Preserve metadata only when requested; metadata can contain location or device information.
5. Reopen the output with `image_info` and verify format and pixel dimensions. For exact crop work, also verify output width/height.
6. Do not use `generate_image` for deterministic edits to an existing image; use `image_transform`.

The path-based Sharp pipeline enforces pixel and output limits without loading binary data through `read_file`.
