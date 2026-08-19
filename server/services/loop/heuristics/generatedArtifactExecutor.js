import path from 'node:path'
import {
  createDocx,
  createHtmlArtifact,
  createImageArtifact,
  createPdf,
  createPptx,
  createXlsx,
} from '../../artifactGen.js'
import {
  dispatchPdfTool,
} from '../../../adapters/pdfTools.js'
import {
  generateImage,
} from '../../mediaModelService.js'
import {
  artifactReplacementError,
  cleanupGeneratedArtifactBatch,
  docxParagraphsFromArtifactArgs,
  pdfBlocksFromArtifactArgs,
  pptxSlidesFromArtifactArgs,
  publishGeneratedArtifact,
  publishGeneratedArtifactBatch,
  publishedArtifactResult,
  xlsxSheetsFromArtifactArgs,
} from './artifactPublishing.js'
import {
  resolveHtmlArtifactArgs,
  resolveOfficeArtifactArgs,
} from './htmlArtifactInput.js'
import {
  attachVisionFeedback,
} from './visionFeedback.js'

const GENERATED_ARTIFACT_TOOL_NAMES = new Set([
  'generate_image',
  'render_pdf_pages',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_pdf',
  'create_html_app',
])

export function isGeneratedArtifactTool(name) {
  return GENERATED_ARTIFACT_TOOL_NAMES.has(name)
}

export async function executeGeneratedArtifactTool({
  name,
  args,
  job,
  step,
  signal,
  requiresLocalArtifactDelivery,
}) {
  if (name === 'generate_image') {
    const generated = await generateImage({ userId: job.userId, ...args })
    const generatedArtifact = createImageArtifact({
      title: args.title || args.prompt,
      buffer: generated.buffer,
      mimeType: generated.mimeType,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args, job, step })
    return await attachVisionFeedback({
      name,
      buffer: generated.buffer,
      result: publishedArtifactResult({
        name,
        artifact,
        args,
        job,
        requiresLocalArtifactDelivery,
        extra: {
          revisedPrompt: generated.revisedPrompt,
          imageMime: generated.mimeType,
        },
      }),
    })
  }
  if (name === 'render_pdf_pages') {
    const rendered = await dispatchPdfTool(name, args || {}, {
      userId: job?.userId || null,
      signal,
    })
    if (String(args?.replace_artifact_id || '').trim() && rendered.pages.length !== 1) {
      throw artifactReplacementError(
        'artifact_replacement_requires_single_page',
        'Replacing one existing image requires exactly one rendered PDF page.',
      )
    }
    const inputName = path.basename(String(rendered.input || args?.input || 'document.pdf'))
    const baseTitle = String(args?.title || path.parse(inputName).name || 'PDF-page').trim()
    const stagedPages = []
    try {
      for (const page of rendered.pages) {
        const pageTitle = rendered.pages.length === 1 && args?.title
          ? String(args.title)
          : `${baseTitle}-page-${page.page}`
        const pageArgs = { ...args, title: pageTitle, pages: [page.page] }
        const artifact = createImageArtifact({
          title: pageTitle,
          buffer: page.buffer,
          mimeType: page.mimeType,
        })
        stagedPages.push({
          page,
          artifact,
          args: pageArgs,
          extra: {
            page: page.page,
            width: page.width,
            height: page.height,
            dpi: page.dpi,
            imageMime: page.mimeType,
          },
        })
      }
    } catch (error) {
      cleanupGeneratedArtifactBatch({ artifacts: stagedPages.map(({ artifact }) => artifact) })
      throw error
    }

    let publishedPages
    if (String(args?.replace_artifact_id || '').trim()) {
      const [{ page, artifact: stagedArtifact, args: pageArgs, extra }] = stagedPages
      const artifact = await publishGeneratedArtifact({
        name,
        artifact: stagedArtifact,
        args: pageArgs,
        job,
        step,
      })
      const delivery = publishedArtifactResult({
        name,
        artifact,
        args: pageArgs,
        job,
        requiresLocalArtifactDelivery,
        extra,
      })
      publishedPages = [{ page, artifact, delivery }]
    } else {
      let deliveries
      try {
        deliveries = await publishGeneratedArtifactBatch({
          name,
          entries: stagedPages,
          job,
          step,
          requiresLocalArtifactDelivery,
        })
      } catch (error) {
        cleanupGeneratedArtifactBatch({ artifacts: stagedPages.map(({ artifact }) => artifact) })
        throw error
      }
      publishedPages = stagedPages.map(({ page, artifact }, index) => ({
        page,
        artifact,
        delivery: deliveries[index],
      }))
    }
    const artifacts = publishedPages.map(({ page, artifact, delivery }) => ({
      id: artifact.id,
      artifactId: artifact.id,
      filename: artifact.filename,
      url: artifact.url,
      type: artifact.type,
      page: page.page,
      width: page.width,
      height: page.height,
      dpi: page.dpi,
      mimeType: page.mimeType,
      replaced: artifact.replaced === true,
      deliveryStatus: delivery.deliveryStatus,
      ...(delivery.path ? { path: delivery.path, localPath: delivery.localPath } : {}),
    }))
    const failedDelivery = publishedPages.find(({ delivery }) => delivery.ok !== true)?.delivery
    const result = {
      ok: !failedDelivery,
      ...(failedDelivery
        ? {
            code: failedDelivery.code,
            error: failedDelivery.error,
            retryable: false,
          }
        : {}),
      artifactId: artifacts[0]?.id || null,
      artifactIds: artifacts.map((artifact) => artifact.id),
      artifacts,
      input: rendered.input,
      pageCount: rendered.pageCount,
      renderedPageCount: rendered.renderedPageCount,
      pages: artifacts,
      format: rendered.format,
      dpi: rendered.dpi,
      imageMime: rendered.mimeType,
      totalBytes: rendered.totalBytes,
    }
    return await attachVisionFeedback({
      name,
      result,
      buffer: publishedPages[0]?.page?.buffer || null,
    })
  }
  if (name === 'create_pptx') {
    const resolvedArgs = resolveOfficeArtifactArgs(args, { userId: job?.userId || null })
    const generatedArtifact = await createPptx({
      title: resolvedArgs.title,
      subtitle: resolvedArgs.subtitle,
      theme: resolvedArgs.theme,
      brand: resolvedArgs.brand,
      slides: pptxSlidesFromArtifactArgs(resolvedArgs),
      images: resolvedArgs._officeImages,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args: resolvedArgs, job, step })
    return publishedArtifactResult({ name, artifact, args: resolvedArgs, job, requiresLocalArtifactDelivery })
  }
  if (name === 'create_docx') {
    const resolvedArgs = resolveOfficeArtifactArgs(args, { userId: job?.userId || null })
    const generatedArtifact = await createDocx({
      title: resolvedArgs.title,
      paragraphs: docxParagraphsFromArtifactArgs(resolvedArgs),
      images: resolvedArgs._officeImages,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args: resolvedArgs, job, step })
    return publishedArtifactResult({ name, artifact, args: resolvedArgs, job, requiresLocalArtifactDelivery })
  }
  if (name === 'create_xlsx') {
    const resolvedArgs = resolveOfficeArtifactArgs(args, { userId: job?.userId || null })
    const generatedArtifact = await createXlsx({
      title: resolvedArgs.title,
      sheets: xlsxSheetsFromArtifactArgs(resolvedArgs),
      images: resolvedArgs._officeImages,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args: resolvedArgs, job, step })
    return publishedArtifactResult({ name, artifact, args: resolvedArgs, job, requiresLocalArtifactDelivery })
  }
  if (name === 'create_pdf') {
    const resolvedArgs = resolveOfficeArtifactArgs(args, { userId: job?.userId || null })
    const generatedArtifact = await createPdf({
      title: resolvedArgs.title,
      blocks: pdfBlocksFromArtifactArgs(resolvedArgs),
      images: resolvedArgs._officeImages,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args: resolvedArgs, job, step })
    return publishedArtifactResult({ name, artifact, args: resolvedArgs, job, requiresLocalArtifactDelivery })
  }
  if (name === 'create_html_app') {
    const resolvedArgs = await resolveHtmlArtifactArgs(args, {
      userId: job?.userId || null,
      prompt: job?.userPrompt || job?.prompt || '',
    })
    const generatedArtifact = createHtmlArtifact({
      title: resolvedArgs.title,
      html: resolvedArgs.html,
      files: resolvedArgs.files,
      assetIds: resolvedArgs._htmlAssetIds,
    })
    const artifact = await publishGeneratedArtifact({ name, artifact: generatedArtifact, args: resolvedArgs, job, step })
    return publishedArtifactResult({
      name,
      artifact,
      args: resolvedArgs,
      job,
      requiresLocalArtifactDelivery,
      extra: { mediaAssetCount: resolvedArgs._htmlCollectionCount || resolvedArgs._htmlAssetIds.length },
    })
  }
  throw new Error(`unsupported generated artifact tool: ${name}`)
}
