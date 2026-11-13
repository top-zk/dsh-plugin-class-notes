/**
 * PDF import pipeline, no browser and no web server.
 *
 *   node test/pdf-import.mjs
 *
 * Phase 1 turns the demo deck into a real PDF through LibreOfficeKit (so we test
 * against a PDF that looks like a teacher's slide export), then drives the exact
 * code the route uses: `pdfToDeck` → `importDeck` → heuristic keywords.
 * Phase 2 checks the text-only fallback used when the rasterizer is missing.
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { importDeck, isPdfPath } from '../lib/deck.js'
import { loadKitModule } from '../lib/pdf.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
const work = join(out, 'pdf-work')
await mkdir(work, { recursive: true })

let failures = 0
function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return true
  }
  failures += 1
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

/* Phase 1 — build a PDF that came from a real deck. */
const kit = await loadKitModule()
if (kit === null) {
  console.log('没有 LibreOfficeKit，跳过 PDF 渲染用例（文字兜底仍会跑）')
}

let pdfPath = ''
if (kit !== null) {
  console.log('\n[1] pptx → pdf（造一份真实的课件 PDF）')
  const converter = await kit.createConverter({ timeoutMs: 180_000 })
  try {
    pdfPath = join(work, 'demo-lecture.pdf')
    await rm(pdfPath, { force: true })
    const info = await converter.render({ inputPath: join(here, 'demo-lecture.pptx'), outputPath: pdfPath })
    ok('转换成功', (await stat(pdfPath)).size > 1000, `backend ${info.backend}`)
  } finally {
    await converter.dispose()
  }
}

if (pdfPath !== '') {
  console.log('\n[2] pdf → pptx → 关键词（走 importDeck，和路由同一条路）')
  const target = join(work, 'source.pptx')
  await rm(target, { force: true })
  const started = Date.now()
  const { parsed, pdf } = await importDeck({ local: pdfPath, target, workDir: work })
  console.log(`  用时 ${Date.now() - started} ms`)
  ok('识别为 PDF', isPdfPath(pdfPath))
  ok('页数和原课件一致（9）', parsed.slides.length === 9, `实际 ${parsed.slides.length}`)
  ok('每页都渲染成图', pdf.renderedPages === 9, `实际 ${pdf.renderedPages}`)
  ok('读到了文字', pdf.textChars > 200, `实际 ${pdf.textChars}`)
  ok('没有警告', pdf.warning === '', pdf.warning)

  const byIndex = new Map(parsed.slides.map((slide) => [slide.index, slide]))
  const second = byIndex.get(2) ?? {}
  ok('第 2 页有正文（图片页本来没文字）', String(second.body ?? '').includes('机器'), JSON.stringify(String(second.body ?? '').slice(0, 60)))
  const seventh = byIndex.get(7) ?? {}
  ok('第 7 页读到了过拟合', String(seventh.body ?? '').includes('过拟合'), String(seventh.body ?? '').slice(0, 40))

  const { extractDeckKeywords } = await import('../lib/keywords.js')
  const keywords = await extractDeckKeywords({
    slides: parsed.slides.map((slide) => ({
      index: slide.index,
      title: slide.title,
      texts: [slide.title, slide.body].filter((item) => item !== ''),
    })),
  })
  const page2 = keywords.slides.find((entry) => entry.index === 2)
  ok('第 2 页启发式关键词含「机器学习」', (page2?.keywords ?? []).some((word) => word.includes('机器学习')), JSON.stringify(page2?.keywords))

  ok('页尺寸来自转换后的 PPT', Number(parsed.slideWidth) > 0 && Number(parsed.slideHeight) > 0, `${parsed.slideWidth}×${parsed.slideHeight}`)
  ok('convert 记录的页数', pdf.slideCount === 9, `实际 ${pdf.slideCount}`)
}

/* Phase 2 — no rasterizer: text slides only. */
console.log('\n[3] 纯文字兜底（不渲染页面）')
{
  const textPdf = pdfPath === '' ? '' : pdfPath
  if (textPdf === '') {
    console.log('  跳过：没有 PDF 可用')
  } else {
    const { runPythonJson } = await import('../lib/runtime.js')
    const target = join(work, 'text-only.pptx')
    await rm(target, { force: true })
    const payload = await runPythonJson('pdf_to_pptx.py', ['--input', textPdf, '--out', target, '--images', ''])
    ok('兜底转换成功', payload?.ok === true, String(payload?.error ?? ''))
    ok('兜底页数一致', payload?.slideCount === 9, `实际 ${payload?.slideCount}`)
    ok('兜底没有图片页', payload?.imagePages === 0, `实际 ${payload?.imagePages}`)
    ok('兜底保留了文字', payload?.textChars > 200, `实际 ${payload?.textChars}`)
    const parsed = await importDeck({ local: target, target: join(work, 'source2.pptx'), workDir: work })
    ok('兜底课件能解析出 9 页', parsed.parsed.slides.length === 9, `实际 ${parsed.parsed.slides.length}`)
    const page5 = parsed.parsed.slides.find((slide) => slide.index === 5) ?? {}
    ok('兜底第 5 页有文字', String(page5.body ?? '').includes('反向传播'), String(page5.body ?? '').slice(0, 40))
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
