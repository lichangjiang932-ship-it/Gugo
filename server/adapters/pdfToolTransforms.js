import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  degrees,
  rgb,
} from 'pdf-lib'
import {
  SUPPORTED_OPERATIONS,
  assertTransformable,
  embedTextFont,
  loadPdf,
  normalizeSplitOutputs,
  parsePageNumber,
  pdfError,
  readPdfInput,
  requireString,
  resolveOutput,
  selectedPages,
  throwIfPdfAborted,
} from './pdfToolSupport.js'
import { writeOutputsAtomically } from './pdfToolPublication.js'

async function loadTransformPdf(rawPath, context) {
  throwIfPdfAborted(context.signal)
  const input = await loadPdf(readPdfInput(rawPath, context))
  throwIfPdfAborted(context.signal)
  return input
}

async function mergePdfs(args, context) {
  if (!Array.isArray(args.inputs) || args.inputs.length < 1) {
    throw pdfError('merge requires a non-empty inputs array', 400, 'PDF_INPUTS_REQUIRED')
  }
  const inputs = await Promise.all(args.inputs.map(async (entry, index) => {
    const rawPath = typeof entry === 'string' ? entry : entry?.path || entry?.input
    if (!rawPath) throw pdfError(`inputs[${index}] requires a path`, 400, 'PDF_INVALID_ARGUMENT')
    return loadTransformPdf(rawPath, context)
  }))
  throwIfPdfAborted(context.signal)
  for (const input of inputs) assertTransformable(input.document, input.path, { allowForms: false })
  const outputDocument = await PDFDocument.create()
  throwIfPdfAborted(context.signal)
  for (const input of inputs) {
    throwIfPdfAborted(context.signal)
    const copied = await outputDocument.copyPages(input.document, input.document.getPageIndices())
    throwIfPdfAborted(context.signal)
    copied.forEach((page) => outputDocument.addPage(page))
  }
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await outputDocument.save({ useObjectStreams: true })
  throwIfPdfAborted(context.signal)
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: outputDocument.getPageCount() }],
    { overwrite: args.overwrite === true, signal: context.signal },
  )
  return { ok: true, operation: 'merge', inputs: inputs.map((item) => item.path), outputs }
}

async function splitPdf(args, context) {
  const input = await loadTransformPdf(args.input || args.path, context)
  assertTransformable(input.document, input.path, { allowForms: false })
  const definitions = normalizeSplitOutputs(args, input.document.getPageCount())
  const outputItems = []
  for (const definition of definitions) {
    throwIfPdfAborted(context.signal)
    const outputDocument = await PDFDocument.create()
    throwIfPdfAborted(context.signal)
    const copied = await outputDocument.copyPages(input.document, definition.pages.map((page) => page - 1))
    throwIfPdfAborted(context.signal)
    copied.forEach((page) => outputDocument.addPage(page))
    const output = resolveOutput(definition.path, { ...context, overwrite: args.overwrite === true })
    const bytes = await outputDocument.save({ useObjectStreams: true })
    throwIfPdfAborted(context.signal)
    outputItems.push({
      output,
      bytes,
      pageCount: definition.pages.length,
      pages: definition.pages,
    })
  }
  const outputs = writeOutputsAtomically(outputItems, { overwrite: args.overwrite === true, signal: context.signal })
  return { ok: true, operation: 'split', input: input.path, outputs }
}

function normalizeRightAngle(value) {
  const angle = Number(value)
  if (!Number.isFinite(angle) || !Number.isInteger(angle) || angle % 90 !== 0) {
    throw pdfError('degrees must be an integer multiple of 90', 400, 'PDF_INVALID_ROTATION')
  }
  return ((angle % 360) + 360) % 360
}

async function rotatePdf(args, context) {
  const input = await loadTransformPdf(args.input || args.path, context)
  assertTransformable(input.document, input.path)
  const amount = normalizeRightAngle(args.degrees)
  const pages = selectedPages(args, input.document.getPageCount(), { defaultAll: true })
  pages.forEach((pageNumber) => {
    throwIfPdfAborted(context.signal)
    const page = input.document.getPage(pageNumber - 1)
    const next = (page.getRotation().angle + amount) % 360
    page.setRotation(degrees(next))
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  throwIfPdfAborted(context.signal)
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages }],
    { overwrite: args.overwrite === true, signal: context.signal },
  )
  return { ok: true, operation: 'rotate', input: input.path, degrees: amount, pages, outputs }
}

function finiteNumber(value, fallback, name, { min = -Infinity, max = Infinity, minExclusive = false } = {}) {
  const candidate = value == null ? fallback : Number(value)
  const aboveMin = minExclusive ? candidate > min : candidate >= min
  if (!Number.isFinite(candidate) || !aboveMin || candidate > max) {
    throw pdfError(`${name} must be ${minExclusive ? 'greater than' : 'at least'} ${min} and at most ${max}`, 400, 'PDF_INVALID_ARGUMENT')
  }
  return candidate
}

function centeredRotatedTextBaseline(font, text, fontSize, rotation, pageWidth, pageHeight) {
  const textWidth = font.widthOfTextAtSize(text, fontSize)
  const heightWithDescender = font.heightAtSize(fontSize, { descender: true })
  const ascent = font.heightAtSize(fontSize, { descender: false })
  const descentDepth = Math.max(0, heightWithDescender - ascent)
  const radians = (rotation * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const localCenterX = textWidth / 2
  const localCenterY = (ascent - descentDepth) / 2
  return {
    x: (pageWidth / 2) - ((localCenterX * cosine) - (localCenterY * sine)),
    y: (pageHeight / 2) - ((localCenterX * sine) + (localCenterY * cosine)),
    textWidth,
    textHeight: heightWithDescender,
  }
}

async function watermarkPdf(args, context) {
  const input = await loadTransformPdf(args.input || args.path, context)
  assertTransformable(input.document, input.path)
  const text = requireString(args.text, 'watermark text')
  const opacity = finiteNumber(args.opacity, 0.25, 'opacity', { min: 0, max: 1, minExclusive: true })
  const fontSize = finiteNumber(args.fontSize ?? args.font_size, 36, 'fontSize', { min: 0, max: 1000, minExclusive: true })
  const rotation = finiteNumber(args.rotation, 45, 'rotation', { min: -3600, max: 3600 })
  const pages = selectedPages(args, input.document.getPageCount(), { defaultAll: true })
  const font = await embedTextFont(input.document, [text])
  throwIfPdfAborted(context.signal)
  pages.forEach((pageNumber) => {
    throwIfPdfAborted(context.signal)
    const page = input.document.getPage(pageNumber - 1)
    const { width, height } = page.getSize()
    const placement = centeredRotatedTextBaseline(font, text, fontSize, rotation, width, height)
    page.drawText(text, {
      x: placement.x,
      y: placement.y,
      size: fontSize,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity,
      rotate: degrees(rotation),
    })
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  throwIfPdfAborted(context.signal)
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages }],
    { overwrite: args.overwrite === true, signal: context.signal },
  )
  return { ok: true, operation: 'watermark', input: input.path, text, pages, outputs }
}

function parseHexColor(value, fallback, name) {
  const candidate = value == null || value === '' ? fallback : String(value).trim()
  const match = candidate.match(/^#([0-9a-f]{6})$/iu)
  if (!match) throw pdfError(`${name} must be a #RRGGBB color`, 400, 'PDF_INVALID_ARGUMENT')
  const packed = Number.parseInt(match[1], 16)
  return rgb(
    ((packed >> 16) & 0xff) / 255,
    ((packed >> 8) & 0xff) / 255,
    (packed & 0xff) / 255,
  )
}

async function overlayTextPdf(args, context) {
  const input = await loadTransformPdf(args.input || args.path, context)
  assertTransformable(input.document, input.path)
  if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 200) {
    throw pdfError('overlay_text requires between 1 and 200 patches', 400, 'PDF_TEXT_PATCHES_REQUIRED')
  }
  const patchTexts = args.patches.map((patch) => patch?.text ?? '')
  const font = await embedTextFont(input.document, patchTexts)
  throwIfPdfAborted(context.signal)
  const applied = args.patches.map((rawPatch, index) => {
    throwIfPdfAborted(context.signal)
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      throw pdfError(`patches[${index}] must be an object`, 400, 'PDF_INVALID_ARGUMENT')
    }
    const pageNumber = parsePageNumber(rawPatch.page, input.document.getPageCount(), `patches[${index}].page`)
    const page = input.document.getPage(pageNumber - 1)
    const pageSize = page.getSize()
    const x = finiteNumber(rawPatch.x, undefined, `patches[${index}].x`, { min: 0, max: pageSize.width })
    const y = finiteNumber(rawPatch.y, undefined, `patches[${index}].y`, { min: 0, max: pageSize.height })
    const width = finiteNumber(rawPatch.width, undefined, `patches[${index}].width`, {
      min: 0,
      max: pageSize.width,
      minExclusive: true,
    })
    const height = finiteNumber(rawPatch.height, undefined, `patches[${index}].height`, {
      min: 0,
      max: pageSize.height,
      minExclusive: true,
    })
    if (x + width > pageSize.width || y + height > pageSize.height) {
      throw pdfError(`patches[${index}] rectangle exceeds page ${pageNumber}`, 400, 'PDF_TEXT_PATCH_OUT_OF_BOUNDS')
    }
    const text = requireString(rawPatch.text, `patches[${index}].text`)
    if (/\r|\n/u.test(text)) {
      throw pdfError(`patches[${index}].text must be one line`, 400, 'PDF_TEXT_PATCH_MULTILINE_UNSUPPORTED')
    }
    const fontSize = finiteNumber(rawPatch.fontSize ?? rawPatch.font_size, 12, `patches[${index}].fontSize`, {
      min: 0,
      max: 1000,
      minExclusive: true,
    })
    const padding = finiteNumber(rawPatch.padding, 2, `patches[${index}].padding`, {
      min: 0,
      max: Math.min(width, height) / 2,
    })
    const opacity = finiteNumber(rawPatch.opacity, 1, `patches[${index}].opacity`, {
      min: 0,
      max: 1,
      minExclusive: true,
    })
    const backgroundOpacity = finiteNumber(
      rawPatch.backgroundOpacity ?? rawPatch.background_opacity,
      1,
      `patches[${index}].backgroundOpacity`,
      { min: 0, max: 1, minExclusive: true },
    )
    const textWidth = font.widthOfTextAtSize(text, fontSize)
    const textHeight = font.heightAtSize(fontSize, { descender: true })
    if (textWidth > width - (padding * 2) || textHeight > height - (padding * 2)) {
      throw pdfError(
        `patches[${index}].text does not fit its rectangle; enlarge it or reduce fontSize`,
        400,
        'PDF_TEXT_PATCH_DOES_NOT_FIT',
      )
    }
    const cover = rawPatch.cover !== false
    if (cover) {
      page.drawRectangle({
        x,
        y,
        width,
        height,
        color: parseHexColor(rawPatch.backgroundColor ?? rawPatch.background_color, '#FFFFFF', `patches[${index}].backgroundColor`),
        opacity: backgroundOpacity,
      })
    }
    page.drawText(text, {
      x: x + padding,
      y: y + ((height - textHeight) / 2),
      size: fontSize,
      font,
      color: parseHexColor(rawPatch.color, '#000000', `patches[${index}].color`),
      opacity,
    })
    return { page: pageNumber, x, y, width, height, text }
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  let bytes
  try {
    bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
    throwIfPdfAborted(context.signal)
  } catch (cause) {
    if (cause?.code === 'ABORT_ERR') throw cause
    throw pdfError(`Unable to save text overlay: ${cause?.message || 'save failed'}`, 422, 'PDF_TEXT_PATCH_SAVE_FAILED', { cause })
  }
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages: [...new Set(applied.map((patch) => patch.page))] }],
    { overwrite: args.overwrite === true, signal: context.signal },
  )
  return { ok: true, operation: 'overlay_text', input: input.path, patches: applied, outputs }
}

function setFormField(field, value) {
  if (field instanceof PDFTextField) {
    field.setText(value == null ? '' : String(value))
    return
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') {
      throw pdfError(`Checkbox field ${field.getName()} requires a boolean`, 400, 'PDF_INVALID_FIELD_VALUE')
    }
    if (value) field.check()
    else field.uncheck()
    return
  }
  if (field instanceof PDFRadioGroup) {
    if (value == null || value === '') field.clear()
    else field.select(String(value))
    return
  }
  if (field instanceof PDFDropdown) {
    if (value == null || value === '') field.clear()
    else field.select(String(value))
    return
  }
  if (field instanceof PDFOptionList) {
    if (value == null || (Array.isArray(value) && !value.length)) field.clear()
    else field.select(Array.isArray(value) ? value.map(String) : String(value))
    return
  }
  if (field instanceof PDFSignature) {
    throw pdfError(`Signature field ${field.getName()} cannot be filled`, 422, 'PDF_SIGNATURE_UNSUPPORTED')
  }
  throw pdfError(
    `Unsupported form field type ${field.constructor?.name || 'PDFField'}: ${field.getName()}`,
    422,
    'PDF_FORM_FIELD_UNSUPPORTED',
  )
}

async function fillFormPdf(args, context) {
  const input = await loadTransformPdf(args.input || args.path, context)
  const inspected = assertTransformable(input.document, input.path)
  if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) {
    throw pdfError('fill_form requires a fields object', 400, 'PDF_FIELDS_REQUIRED')
  }
  const entries = Object.entries(args.fields)
  if (!entries.length) throw pdfError('fill_form fields must not be empty', 400, 'PDF_FIELDS_REQUIRED')
  if (!inspected.fields.length) {
    throw pdfError('PDF does not contain interactive AcroForm fields', 422, 'PDF_FORM_NOT_FOUND')
  }
  const form = input.document.getForm()
  for (const [name, value] of entries) {
    throwIfPdfAborted(context.signal)
    const field = form.getFieldMaybe(name)
    if (!field) throw pdfError(`PDF form field not found: ${name}`, 404, 'PDF_FORM_FIELD_NOT_FOUND')
    try {
      setFormField(field, value)
    } catch (cause) {
      if (cause?.code) throw cause
      throw pdfError(
        `Unable to set PDF form field ${name}: ${cause?.message || 'invalid value'}`,
        422,
        'PDF_INVALID_FIELD_VALUE',
        { cause },
      )
    }
  }
  const flatten = args.flatten === true
  const appearanceFont = await embedTextFont(
    input.document,
    entries.flatMap(([, value]) => Array.isArray(value) ? value.map(String) : [String(value ?? '')]),
  )
  throwIfPdfAborted(context.signal)
  try {
    form.updateFieldAppearances(appearanceFont)
    if (flatten) form.flatten({ updateFieldAppearances: false })
  } catch (cause) {
    throw pdfError(
      `无法生成 PDF 表单字段外观：${cause?.message || '字段值或表单结构不受支持。'}`,
      422,
      'PDF_FORM_APPEARANCE_UNSUPPORTED',
      { cause },
    )
  }
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  let bytes
  try {
    bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
    throwIfPdfAborted(context.signal)
  } catch (cause) {
    if (cause?.code === 'ABORT_ERR') throw cause
    throw pdfError(
      `无法保存已填写的 PDF 表单：${cause?.message || '保存失败。'}`,
      422,
      'PDF_FORM_APPEARANCE_UNSUPPORTED',
      { cause },
    )
  }
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount() }],
    { overwrite: args.overwrite === true, signal: context.signal },
  )
  return {
    ok: true,
    operation: 'fill_form',
    input: input.path,
    fields: entries.map(([name]) => name),
    flattened: flatten,
    interactiveFormPreserved: !flatten,
    outputs,
  }
}

async function pdfTransform(args, context) {
  throwIfPdfAborted(context.signal)
  const operation = String(args?.operation || '').trim().toLowerCase()
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    throw pdfError(
      `operation must be one of: ${[...SUPPORTED_OPERATIONS].join(', ')}`,
      400,
      'PDF_OPERATION_UNSUPPORTED',
    )
  }
  let result
  switch (operation) {
    case 'merge': result = await mergePdfs(args, context); break
    case 'split': result = await splitPdf(args, context); break
    case 'rotate': result = await rotatePdf(args, context); break
    case 'watermark': result = await watermarkPdf(args, context); break
    case 'overlay_text': result = await overlayTextPdf(args, context); break
    case 'fill_form': result = await fillFormPdf(args, context); break
    default: throw pdfError(`Unsupported PDF operation: ${operation}`, 400, 'PDF_OPERATION_UNSUPPORTED')
  }
  const outputs = Array.isArray(result?.outputs) ? result.outputs : []
  const changedPaths = outputs.map((output) => output?.path).filter(Boolean)
  return {
    ...result,
    ...(outputs.length === 1 ? { path: outputs[0].path, scope: outputs[0].scope } : {}),
    changedPaths,
  }
}

export { pdfTransform }
