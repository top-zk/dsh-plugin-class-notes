/**
 * Render pages of a deck (or PDF) to PNG so a human can eyeball the result.
 *
 *   node test/render-pages.mjs test/out/pdf-export.pptx 1,2,3
 *
 * Writes `test/out/render/<basename>-page-0001.png` and prints the paths.
 */
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadKitModule } from '../lib/pdf.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('用法：node test/render-pages.mjs <课件或 PDF> [页码，如 1,2,3]')
  process.exit(2)
}

const input = resolve(args[0])
const pages = (args[1] ?? '1').split(',').map((value) => Number(value.trim())).filter(Number.isFinite)

const kit = await loadKitModule()
if (kit === null) {
  console.log('没有 LibreOfficeKit，渲染不了')
  process.exit(3)
}

const base = basename(input, extname(input))
const outputDir = join(here, 'out', 'render', `${base}-${Date.now()}`)
await mkdir(dirname(outputDir), { recursive: true })
await rm(outputDir, { recursive: true, force: true })

const converter = await kit.createConverter({ timeoutMs: 180_000 })
try {
  const manifest = await converter.renderImages({ inputPath: input, outputDir, pages, dpi: 120 })
  for (const image of manifest.images ?? []) {
    console.log(`${pathToFileURL(image.path).pathname.replace(/^\//, '')}  ${image.width}×${image.height}`)
  }
} finally {
  await converter.dispose()
}
