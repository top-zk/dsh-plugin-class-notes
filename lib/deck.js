/**
 * Deck ingestion: hand the uploaded .pptx to Python, get canonical slides back.
 *
 * Everything that talks to PowerPoint formats lives in `python/`; this module is
 * the thin, framework-free seam between that subprocess and the session store.
 *
 * @module dsh-plugin-class-notes/deck
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { runPythonJson, writeJsonFile } from './runtime.js'
import { normalizeSlide, str } from './model.js'
import { PDF_EXTENSIONS, pdfToDeck } from './pdf.js'

/** Extensions the panel accepts: a deck, or a PDF it will turn into one. */
export const DECK_EXTENSIONS = ['.pptx', '.pdf']

/** True when this path needs the PDF pipeline first. */
export function isPdfPath(path) {
  const value = str(path).toLowerCase()
  return PDF_EXTENSIONS.some((extension) => value.endsWith(extension))
}

/** Error with an HTTP-ish status the route can map. */
function badRequest(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Parse one deck file into canonical slides.
 * @param {string} file - absolute path of the .pptx.
 * @param {object} [options] - `{ signal, timeoutMs }`.
 * @returns {Promise<{slideCount: number, slideWidth: number, slideHeight: number, slides: object[]}>}
 */
export async function parseDeck(file, options = {}) {
  const path = str(file)
  if (path === '') throw badRequest('请先选择要上传的 PPT 文件')
  if (!DECK_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw badRequest('只支持 .pptx 或 .pdf（如果是老版 .ppt，请先用 PowerPoint 另存为 .pptx）')
  }
  if (isPdfPath(path)) throw badRequest('这是 PDF，要先转成 PPT 再解析')

  let payload
  try {
    payload = await runPythonJson('extract_pptx.py', ['--input', path], {
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw badRequest(`读取 PPT 失败：${String(error?.message ?? error)}`, 500)
  }

  if (payload?.ok !== true) {
    throw badRequest(`读取 PPT 失败：${str(payload?.error, '未知错误')}`, 500)
  }

  const rawSlides = Array.isArray(payload.slides) ? payload.slides : []
  const slides = rawSlides.map((slide, position) => {
    const texts = Array.isArray(slide?.texts) ? slide.texts.map((item) => str(item)).filter((item) => item !== '') : []
    const title = str(slide?.title)
    const body = texts
      .filter((item) => item !== title)
      .join('\n')
      .trim()
    return normalizeSlide(
      {
        index: Number(slide?.index) || position + 1,
        title,
        body,
        notes: str(slide?.notes),
        keywords: [],
        keywordSource: 'pending',
        segments: [],
      },
      position + 1,
    )
  })

  if (slides.length === 0) {
    throw badRequest('这份 PPT 里没有找到任何幻灯片')
  }

  return {
    slideCount: slides.length,
    slideWidth: Number(payload.slideWidth) || 0,
    slideHeight: Number(payload.slideHeight) || 0,
    slides,
    raw: rawSlides,
  }
}

/**
 * Turn whatever the user dropped in into usable slides.
 *
 * A .pptx is parsed as-is. A .pdf is first rebuilt as a .pptx (one page image per
 * slide, plus the page text Python pulled out of the PDF), then parsed the same
 * way — from there on the panel cannot tell the two apart.
 *
 * @param {object} job - `{ local, target, workDir, signal, logger }`.
 *   `local` is the file on disk, `target` is where `source.pptx` must end up.
 * @returns {Promise<{parsed: object, pdf: object|null}>}
 */
export async function importDeck(job) {
  const local = str(job.local)
  const target = str(job.target)
  const workDir = str(job.workDir, join(target, '..'))
  if (local === '') throw badRequest('请先选择要上传的课件')

  if (!isPdfPath(local)) {
    return { parsed: await parseDeck(local, { signal: job.signal }), pdf: null }
  }

  const converted = await pdfToDeck(local, {
    target,
    workDir,
    signal: job.signal,
    logger: job.logger,
  })
  const parsed = await parseDeck(target, { signal: job.signal })

  // Image slides carry no text of their own, so push the PDF's text into the
  // session model: keyword extraction, the panel and the export all read it.
  // `pdf_to_pptx.py` already parks that text on the picture's alt text, but a
  // deck made by another tool may still come back with just the file name.
  const byIndex = new Map(converted.pages.map((page) => [page.index, page]))
  for (const slide of parsed.slides) {
    const page = byIndex.get(slide.index)
    if (page === undefined) continue
    const text = str(page.text).trim()
    if (text === '') continue
    const blank = slide.body.trim() === '' || /^page-\d+\.png$/i.test(slide.body.trim())
    if (blank) slide.body = text
    if (slide.title.trim() === '') slide.title = str(page.title)
  }

  return { parsed, pdf: converted }
}

/**
 * Store the uploaded deck as the session's immutable `source.pptx`.
 * @param {string} bytes - base64 payload.
 * @param {string} target - destination path.
 * @param {string} [label] - original file name, used for error messages only.
 */
export async function saveDeckBytes(bytes, target, label = '') {
  const encoded = typeof bytes === 'string' ? bytes.trim() : ''
  if (encoded === '') throw badRequest('没有收到文件内容')
  let buffer
  try {
    buffer = Buffer.from(encoded, 'base64')
  } catch {
    throw badRequest('文件内容解码失败，请重新选择文件')
  }
  if (buffer.byteLength < 1024) {
    throw badRequest(`文件看起来不完整（${buffer.byteLength} 字节）：${label}`)
  }
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, buffer)
  return buffer.byteLength
}

/**
 * Copy an absolute deck path (already on the machine) into the session folder.
 * @param {string} source - readable .pptx path.
 * @param {string} target - destination path.
 */
export async function copyDeckFile(source, target) {
  const path = str(source)
  if (path === '') throw badRequest('请提供 PPT 路径')
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    throw badRequest(`打不开这个文件：${path}（${String(error?.message ?? error)}）`)
  }
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, buffer)
  return { bytes: buffer.byteLength, fileName: basename(path) }
}

/**
 * Run the notes/pages writer.
 *
 * @param {object} job - `{ mode, source, target, pagesOut, title, date, bySlide }`.
 * @param {object} [options] - `{ signal, timeoutMs }`.
 * @returns {Promise<object>} Python's JSON payload.
 */
export async function writeDeckNotes(job, options = {}) {
  const workDir = str(options.workDir, join(str(job.source), '..'))
  const jobFile = join(workDir, `job-${Date.now()}.json`)
  writeJsonFile(jobFile, job)
  const payload = await runPythonJson('write_notes.py', ['--json', jobFile], {
    timeoutMs: options.timeoutMs ?? 180_000,
    signal: options.signal,
  })
  if (payload?.ok !== true) {
    throw badRequest(`写入备注失败：${str(payload?.error, '未知错误')}`, 500)
  }
  return payload
}
