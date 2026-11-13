/**
 * Probe: can the bundled LibreOffice kit take a PDF and give back a .pptx?
 *   node test/probe-libreoffice.mjs
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
await mkdir(out, { recursive: true })

const candidates = []
if (process.env.DSH_LIBREOFFICE_KIT) candidates.push(process.env.DSH_LIBREOFFICE_KIT)
if (process.resourcesPath) {
  candidates.push(resolve(process.resourcesPath, 'app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit'))
  candidates.push(resolve(process.resourcesPath, 'app/node_modules/@deepseek-ai/libreoffice-kit'))
}
candidates.push(resolve(here, '../../../..', 'node_modules/@deepseek-ai/libreoffice-kit'))

let kit = null
for (const candidate of candidates) {
  try {
    kit = await import(pathToFileURL(join(candidate, 'lib/index.js')).href)
    console.log('kit:', candidate)
    break
  } catch (error) {
    console.log('miss:', candidate, String(error?.message ?? error).slice(0, 80))
  }
}
if (kit === null) {
  try {
    kit = await import('@deepseek-ai/libreoffice-kit')
    console.log('kit: bare specifier')
  } catch (error) {
    console.log('no kit at all:', String(error?.message ?? error))
    process.exit(2)
  }
}

console.log('exports:', Object.keys(kit).join(', '))
const converter = await kit.createConverter({ timeoutMs: 180_000 })
try {
  const pdf = join(out, 'demo.pdf')
  const first = await converter.render({ inputPath: join(here, 'demo-lecture.pptx'), outputPath: pdf })
  console.log('pptx→pdf', first.backend, first.missingFonts?.length ?? 0, 'missing fonts')

  const back = join(out, 'demo-from-pdf.pptx')
  const second = await converter.render({ inputPath: pdf, outputPath: back })
  console.log('pdf→pptx', second.backend, second.missingFonts?.length ?? 0, 'missing fonts')
  console.log('back:', back)
} catch (error) {
  console.log('CONVERT FAILED:', String(error?.message ?? error))
  process.exitCode = 1
} finally {
  await converter.dispose()
}
