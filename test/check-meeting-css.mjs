/**
 * Check the meeting-minutes dialog after the "purple sheet over the UI" fix.
 *
 * Two things are verified in real Chrome:
 *   1. the plugin stylesheet still parses and the scrim is a plain translucent
 *      mask (no backdrop-filter, no opaque fill);
 *   2. the glass wallpaper plugin's `[role="dialog"]` solid-base rule can no
 *      longer paint the full-screen wrapper — only the real panel keeps the
 *      dialog role, so the area around the dialog stays see-through.
 *
 * usage: node test/check-meeting-css.mjs
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const CLIENT = process.env.MEETING_CLIENT
  ?? 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-plugin-meeting-minutes/lib/client.js'
const puppeteerEntry = pathToFileURL('C:/Users/Administrator/.dsh/profiles/desktop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js').href
const puppeteer = (await import(puppeteerEntry)).default

const source = await readFile(CLIENT, 'utf8')
const styleMatch = source.match(/const CSS = `\r?\n([\s\S]*?)\r?\n`\r?\n/)
if (!styleMatch) throw new Error('stylesheet not found in client.js')
const css = styleMatch[1]
console.log('css bytes', css.length)

// The rule the glass/wallpaper plugin injects for any unclaimed ARIA dialog.
// Copied from dsh-plugin-wallpaper-engine-glass/lib/client.glass.js so the check
// fails if the plugin starts painting the wrapper again.
const GLASS_RULE = `
body[data-we-glass-page][data-we-floater-solid] :where([role="dialog"]):not([data-we-surface-runtime]):not([data-we-host-dialog]) {
  background-color: var(--we-readability-base, #ffffff) !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
body[data-we-glass-page] { --we-readability-base: #6b4ce6; }
`

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
const problems = []
try {
  await page.setContent('<!doctype html><html><head></head><body data-we-glass-page data-we-floater-solid></body></html>')

  const report = await page.evaluate((text, glassRule) => {
    const style = document.createElement('style')
    style.textContent = text
    document.head.appendChild(style)
    const glass = document.createElement('style')
    glass.textContent = glassRule
    document.head.appendChild(glass)

    const sheet = style.sheet
    const rules = Array.from(sheet?.cssRules ?? []).map((rule) => rule.cssText)
    const maskRule = rules.find((rule) => rule.startsWith('.dsm-modal-mask'))
    const rootRule = rules.find((rule) => rule.startsWith('.dsm-modal-root'))

    // markup as Modal() renders it now: role lives on the panel, not the wrapper
    const wrapper = (rootAttrs, panelAttrs) => {
      const root = document.createElement('div')
      root.className = 'dsm-modal-root'
      for (const [name, value] of Object.entries(rootAttrs)) root.setAttribute(name, value)
      root.innerHTML = '<div class="dsm-modal-mask"></div>'
      const panel = document.createElement('div')
      panel.className = 'dsm-modal'
      for (const [name, value] of Object.entries(panelAttrs)) panel.setAttribute(name, value)
      panel.innerHTML = '<div class="dsm-modal">x</div>'
      root.appendChild(panel)
      document.body.appendChild(root)
      return root
    }

    const after = wrapper({}, { role: 'dialog', 'aria-modal': 'true' })
    const before = wrapper({ role: 'dialog', 'aria-modal': 'true' }, {})

    const read = (root) => {
      const mask = root.querySelector('.dsm-modal-mask')
      const panel = root.children[1]
      return {
        rootBackground: getComputedStyle(root).backgroundColor,
        maskBackground: getComputedStyle(mask).backgroundColor,
        maskBackdrop: getComputedStyle(mask).backdropFilter,
        panelBackground: getComputedStyle(panel).backgroundColor,
        rootIsolation: getComputedStyle(root).isolation,
      }
    }

    return {
      ruleCount: rules.length,
      maskRule: maskRule ?? null,
      rootRule: rootRule ?? null,
      after: read(after),
      before: read(before),
    }
  }, css, GLASS_RULE)

  console.log('rules parsed', report.ruleCount)
  console.log('mask rule   ', report.maskRule)
  console.log('before      ', JSON.stringify(report.before))
  console.log('after       ', JSON.stringify(report.after))

  const expect = (ok, message) => {
    console.log(`${ok ? '  ok ' : 'FAIL '} ${message}`)
    if (!ok) problems.push(message)
  }

  expect(report.ruleCount > 250, `stylesheet parsed into ${report.ruleCount} rules`)
  expect(report.maskRule !== null, '.dsm-modal-mask rule survived')
  expect(!String(report.maskRule ?? '').includes('backdrop-filter'), '.dsm-modal-mask paints no backdrop-filter')
  expect(report.after.maskBackdrop === 'none', `scrim has no backdrop-filter (${report.after.maskBackdrop})`)
  expect(/rgba?\(/.test(report.after.maskBackground), `scrim is a translucent colour (${report.after.maskBackground})`)
  expect(report.after.rootIsolation === 'isolate', '.dsm-modal-root isolates itself')

  const alpha = Number((report.after.maskBackground.match(/rgba?\([^)]*?,\s*([\d.]+)\)$/) ?? [])[1] ?? '1')
  expect(alpha > 0 && alpha < 0.6, `scrim alpha stays dimming-only (${alpha})`)

  // The regression itself: the glass theme paints every unclaimed [role="dialog"]
  // with a solid themed base. On the wrapper that solid base covered the screen.
  expect(report.before.rootBackground === 'rgb(107, 76, 230)', `reproduced: wrapper with role=dialog turns purple (${report.before.rootBackground})`)
  expect(report.after.rootBackground !== 'rgb(107, 76, 230)', `wrapper no longer takes the solid dialog base (${report.after.rootBackground})`)
  expect(report.after.panelBackground === 'rgb(107, 76, 230)', `real panel keeps a readable base (${report.after.panelBackground})`)
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.log(`${problems.length} problem(s)`)
  process.exit(1)
}
console.log('all css checks passed')
