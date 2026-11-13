/**
 * Real HTTP check of the PDF import path against the running plugin.
 *
 *   node test/live-pdf.mjs [--pdf <path>]
 *
 * Uses the demo PDF produced by `test/pdf-import.mjs`
 * (`test/out/pdf-work/demo-lecture.pdf`); falls back to the path given on the
 * command line. Everything happens over `http://127.0.0.1:65039`, so this is the
 * same route the panel's "放课件" button hits.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:65039'
const API = `${BASE}/dsh-class-notes`

const argIndex = process.argv.indexOf('--pdf')
const pdfPath = argIndex > 0 ? process.argv[argIndex + 1] : join(here, 'out', 'pdf-work', 'demo-lecture.pdf')

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

async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${path} 返回的不是 JSON（${response.status}）：${text.slice(0, 160)}`)
  }
  if (payload.ok === false) throw new Error(`${path}: ${payload.error}`)
  return payload
}

const health = await json('/health', { method: 'GET' })
ok('插件在线', health.ok === true, health.dataDir)

// The other tests clean `test/out`, so rebuild the demo PDF when it is missing.
async function ensurePdf() {
  try {
    await stat(pdfPath)
    return pdfPath
  } catch {
    const { loadKitModule } = await import('../lib/pdf.js')
    const kit = await loadKitModule()
    if (kit === null) throw new Error(`没有 ${pdfPath}，本机也没有 LibreOfficeKit 可以现造一份`)
    await mkdir(join(here, 'out', 'pdf-work'), { recursive: true })
    const converter = await kit.createConverter({ timeoutMs: 180_000 })
    try {
      await converter.render({ inputPath: join(here, 'demo-lecture.pptx'), outputPath: pdfPath })
    } finally {
      await converter.dispose()
    }
    console.log(`  现造了一份 ${pdfPath}`)
    return pdfPath
  }
}
await ensurePdf()

const state = await json('/state', { method: 'GET' })
ok('state 报出了 PDF 渲染能力', typeof state.pdf?.rasterizer === 'boolean', JSON.stringify(state.pdf))
console.log(`  本机 PDF 渲染：${state.pdf?.rasterizer ? '可用' : '不可用（pdf 只能按文字导入）'}`)

let created = null
try {
  const pdfStat = await stat(pdfPath)
  console.log(`\n用 ${pdfPath}（${Math.round(pdfStat.size / 1024)} KB）`)

  created = await json('/sessions', { method: 'POST', body: JSON.stringify({ title: 'PDF 导入测试' }) })
  const id = created.session.id

  const bytes = new Uint8Array(await readFile(pdfPath))
  const started = Date.now()
  const uploaded = await fetch(`${API}/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('demo-lecture.pdf'),
    },
    body: bytes,
  })
  const uploadText = await uploaded.text()
  let upload
  try {
    upload = JSON.parse(uploadText)
  } catch {
    throw new Error(`上传返回的不是 JSON（${uploaded.status}）：${uploadText.slice(0, 200)}`)
  }
  ok('上传成功', upload.ok === true, String(upload.error ?? ''))
  console.log(`  用时 ${Date.now() - started} ms，converted=${JSON.stringify(upload.converted)}`)

  const session = upload.session ?? {}
  ok('转出了 9 页', (session.slides ?? []).length === 9, `实际 ${(session.slides ?? []).length}`)
  ok('记下了是 PDF 导入', session.meta?.importKind === 'pdf', String(session.meta?.importKind))
  ok('每页都按原样渲染', session.meta?.pdfRenderedPages === 9, String(session.meta?.pdfRenderedPages))
  const page2 = (session.slides ?? []).find((slide) => slide.index === 2) ?? {}
  ok('第 2 页带了 PDF 文字', String(page2.body ?? '').includes('机器'), String(page2.body ?? '').slice(0, 50))
  ok('第 2 页有启发式关键词', (page2.keywords ?? []).length > 0, JSON.stringify(page2.keywords))

  const keywords = await json(`/sessions/${encodeURIComponent(id)}/keywords`, { method: 'POST', body: '{}' })
  const llmPage = (keywords.session?.slides ?? []).find((slide) => slide.index === 5) ?? {}
  ok('模型跑出了关键词', (llmPage.keywords ?? []).length > 0 && keywords.keywordSource === 'llm',
    `${keywords.keywordSource} ${JSON.stringify(llmPage.keywords)}`)
  console.log(`  第 5 页：${(llmPage.keywords ?? []).join(' / ')}`)

  await json(`/sessions/${encodeURIComponent(id)}/slides/3`, {
    method: 'POST',
    body: JSON.stringify({ notes: '老师说下次课要交作业' }),
  })
  const exported = await json(`/sessions/${encodeURIComponent(id)}/export`, { method: 'POST', body: '{}' })
  ok('导出了带备注的 PPT', Boolean(exported.downloads?.pptx), JSON.stringify(exported.downloads ?? {}))
  const download = await fetch(`${BASE}${exported.downloads.pptx}`)
  ok('导出文件能下载', download.status === 200, String(download.status))

  const saved = join(here, 'out', 'pdf-export.pptx')
  await writeFile(saved, new Uint8Array(await download.arrayBuffer()))
  const { runPythonJson } = await import('../lib/runtime.js')
  const check = await runPythonJson('extract_pptx.py', ['--input', saved])
  const page3 = (check.slides ?? []).find((slide) => slide.index === 3) ?? {}
  ok('导出的 PPT 里第 3 页备注写进去了', String(page3.notes ?? '').includes('作业'), String(page3.notes ?? '').slice(0, 60))
  ok('导出的 PPT 还是 9 页', check.slideCount === 9, String(check.slideCount))
} catch (error) {
  failures += 1
  console.log(`  ✗ 异常：${String(error?.message ?? error)}`)
} finally {
  if (created !== null) {
    const id = created.session.id
    await json(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
    console.log('  已删除测试会话')
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
