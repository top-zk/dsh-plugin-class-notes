/**
 * Boot the real DSH web GUI in headless Chrome, open 会议纪要 → 录音, and
 * screenshot the modal so the overlay colour can be judged by eye.
 *
 * usage: node test/shot-meeting.mjs [outDir]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const puppeteerEntry = pathToFileURL('C:/Users/Administrator/.dsh/profiles/desktop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js').href
const puppeteer = (await import(puppeteerEntry)).default

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:55716'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const outDir = resolve(process.argv[2] ?? 'test/out/shots')
await mkdir(outDir, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,960', '--font-render-hinting=none'],
  defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
})

const page = await browser.newPage()
const log = []
page.on('console', (msg) => log.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (error) => log.push(`[pageerror] ${error.message}`))

const shot = async (name) => {
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  console.log('shot', file)
  return file
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3500)
  await shot('01-boot')

  // Sidebar entries render as buttons/links with a label somewhere inside.
  const openPanel = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    const hit = nodes.find((node) => (node.textContent ?? '').includes('会议纪要') || (node.getAttribute('aria-label') ?? '').includes('会议纪要') || (node.getAttribute('title') ?? '').includes('会议纪要'))
    if (!hit) return { ok: false, seen: nodes.slice(0, 40).map((n) => (n.textContent ?? '').trim().slice(0, 20)) }
    hit.click()
    return { ok: true, label: (hit.textContent ?? '').trim().slice(0, 30) }
  })
  console.log('openPanel', JSON.stringify(openPanel).slice(0, 400))
  await sleep(2000)
  await shot('02-panel')

  const clicked = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const hit = nodes.find((node) => /录音转文字|录音/.test(node.textContent ?? '') && (node.textContent ?? '').trim().length <= 12)
    if (!hit) return { ok: false, seen: nodes.map((n) => (n.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 30) }
    hit.click()
    return { ok: true, label: (hit.textContent ?? '').trim() }
  })
  console.log('clicked', JSON.stringify(clicked).slice(0, 400))
  await sleep(1800)
  await shot('03-modal')

  const info = await page.evaluate(() => {
    const mask = document.querySelector('.dsm-modal-mask')
    const root = document.querySelector('.dsm-modal-root')
    const modal = document.querySelector('.dsm-modal')
    const read = (node) => {
      if (!node) return null
      const style = getComputedStyle(node)
      return { background: style.backgroundColor, backdrop: style.backdropFilter, zIndex: style.zIndex, opacity: style.opacity }
    }
    const bodyStyle = getComputedStyle(document.body)
    return {
      mask: read(mask),
      root: read(root),
      modal: read(modal),
      maskVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-mask-1').trim(),
      overlayVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-overlay').trim(),
      bodyBg: bodyStyle.backgroundColor,
      theme: document.documentElement.getAttribute('data-theme') ?? '',
    }
  })
  console.log('info', JSON.stringify(info, null, 2))

  const errors = log.filter((line) => line.startsWith('[error]') || line.startsWith('[pageerror]'))
  console.log('errors', errors.length, errors.slice(0, 10).join('\n'))
  await writeFile(join(outDir, 'console.log'), log.join('\n'), 'utf8')
} finally {
  await browser.close()
}
