/**
 * PDF ingestion: rasterize the pages, then let Python rebuild them as a deck.
 *
 * A PDF is not a deck, and LibreOffice refuses to convert one into a .pptx. What
 * it *can* do is paint every page as a PNG through PDFium, so a PDF deck becomes
 * one full-bleed picture per slide — visually identical to the original — while
 * `pdf_to_pptx.py` keeps each page's real text for keyword matching.
 *
 * @module dsh-plugin-class-notes/pdf
 */

import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runPythonJson } from './runtime.js'
import { str } from './model.js'

/** Extensions that get the PDF pipeline. */
export const PDF_EXTENSIONS = ['.pdf']

/** Hard cap so a 400-page scanned book cannot wedge the panel. */
export const MAX_PDF_PAGES = 150

/** Rasterization density: readable at full width, still small enough to store. */
const RENDER_DPI = 150

/** LibreOfficeKit needs a few seconds of engine startup per batch. */
const RENDER_TIMEOUT_MS = 300_000

/** Error with an HTTP-ish status the route can map. */
function badRequest(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Candidate locations of `@deepseek-ai/libreoffice-kit` inside the desktop app. */
function kitCandidates() {
  const out = []
  const fromEnv = str(process.env.DSH_LIBREOFFICE_KIT)
  if (fromEnv !== '') out.push(fromEnv)
  const resources = str(process.resourcesPath)
  if (resources !== '') {
    out.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit'))
    out.push(join(resources, 'app.asar', 'node_modules', '@deepseek-ai', 'libreoffice-kit'))
    out.push(join(resources, 'node_modules', '@deepseek-ai', 'libreoffice-kit'))
  }
  return out
}

let kitPromise

/**
 * Load LibreOfficeKit once. Resolves to the module or `null` when the desktop app
 * does not ship it (the text-only fallback still works).
 */
export async function loadKitModule() {
  if (kitPromise !== undefined) return kitPromise
  kitPromise = (async () => {
    for (const dir of kitCandidates()) {
      const entry = join(dir, 'lib', 'index.js')
      if (!existsSync(entry)) continue
      try {
        return await import(pathToFileURL(entry).href)
      } catch {
        continue
      }
    }
    // Last resort: hoisted into the profile's node_modules by some other plugin.
    try {
      return await import('@deepseek-ai/libreoffice-kit')
    } catch {
      return null
    }
  })()
  return kitPromise
}

/**
 * Paint every PDF page into `outputDir` as `page-0001.png` style files.
 *
 * @param {string} source - absolute .pdf path.
 * @param {string} outputDir - must not exist yet (the kit owns it).
 * @param {object} [options] - `{ dpi, maxPages, signal }`.
 * @returns {Promise<{images: object[], backend: string}>}
 */
export async function renderPdfPages(source, outputDir, options = {}) {
  const kit = await loadKitModule()
  if (kit === null) throw badRequest('本机没有可用的 PDF 渲染组件，PDF 只能按文字导入', 503)

  const converter = await kit.createConverter({ timeoutMs: RENDER_TIMEOUT_MS })
  try {
    const manifest = await converter.renderImages(
      {
        inputPath: source,
        outputDir,
        pages: 'all',
        dpi: options.dpi ?? RENDER_DPI,
        maxPages: options.maxPages ?? MAX_PDF_PAGES,
      },
      options.signal,
    )
    const images = Array.isArray(manifest?.images) ? manifest.images : []
    if (images.length === 0) throw badRequest('这份 PDF 没能渲染出页面')
    return { images, backend: str(manifest?.rasterEngine, 'unknown') }
  } finally {
    try {
      await converter.dispose?.()
    } catch {
      // Disposal is best-effort; a failed close must not mask the real error.
    }
  }
}

/** True when the deck pipeline can rasterize PDFs on this machine. */
export async function pdfRasterizerAvailable() {
  return (await loadKitModule()) !== null
}

/**
 * Convert a PDF into the session's `source.pptx`.
 *
 * @param {string} source - absolute .pdf path.
 * @param {object} options - `{ target, workDir, title, signal, logger }`.
 * @returns {Promise<{slideCount: number, slideWidth: number, slideHeight: number,
 *   slideCountRendered: number, textChars: number, warning: string,
 *   pages: {index: number, title: string, text: string, image: string}[]}>}
 */
export async function pdfToDeck(source, options = {}) {
  const target = str(options.target)
  const workDir = str(options.workDir)
  if (target === '') throw badRequest('缺少转换目标路径')
  if (workDir === '') throw badRequest('缺少转换工作目录')

  let imagesDir = ''
  let warning = ''
  const raster = await loadKitModule()
  if (raster === null) {
    warning = '本机没有 PDF 渲染组件，已按文字导入'
  } else {
    imagesDir = join(workDir, `pdf-pages-${Date.now()}`)
    try {
      await renderPdfPages(source, imagesDir, { signal: options.signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      options.logger?.('warn', `PDF 渲染失败，改按文字导入：${String(error?.message ?? error)}`)
      await rm(imagesDir, { recursive: true, force: true }).catch(() => {})
      imagesDir = ''
      warning = `页面渲染没成功（${String(error?.message ?? error)}），已按文字导入`
    }
  }

  let payload
  try {
    payload = await runPythonJson(
      'pdf_to_pptx.py',
      ['--input', source, '--out', target, '--images', imagesDir],
      { timeoutMs: 300_000, signal: options.signal },
    )
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw badRequest(`PDF 转 PPT 失败：${String(error?.message ?? error)}`, 500)
  } finally {
    if (imagesDir !== '') {
      await rm(imagesDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (payload?.ok !== true) {
    throw badRequest(`PDF 转 PPT 失败：${str(payload?.error, '未知错误')}`, 500)
  }

  const pages = Array.isArray(payload.pages)
    ? payload.pages.map((page, position) => ({
        index: Number(page?.index) || position + 1,
        title: str(page?.title),
        text: str(page?.text),
        image: str(page?.image),
      }))
    : []

  return {
    slideCount: Number(payload.slideCount) || pages.length,
    slideWidth: Number(payload.slideWidth) || 0,
    slideHeight: Number(payload.slideHeight) || 0,
    renderedPages: Number(payload.imagePages) || 0,
    textChars: Number(payload.textChars) || 0,
    warning: [warning, str(payload.warning)].filter((item) => item !== '').join('；'),
    pages,
  }
}

/** Files the PDF pipeline leaves behind in a work directory. */
export async function cleanupPdfWork(workDir) {
  const dir = str(workDir)
  if (dir === '') return
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (name.startsWith('pdf-pages-')) await rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
}
