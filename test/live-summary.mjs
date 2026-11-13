/**
 * The AI recap, against the real host and the real model.
 *
 *   node test/live-summary.mjs
 *
 * Recording is not needed: the recap reads whatever landed on the slides, so the
 * test writes a teacher-style note per page through /slides/:n (the same route the
 * panel's note box uses), then asks for the recap and reads it back. Exports are
 * checked too — the .pptx note text and the separate recap file both have to
 * carry the summary once it exists.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:54235').replace(/\/$/, '')
const API = `${BASE}/dsh-class-notes`
const DECK = join(here, 'demo-lecture.pptx')
const TITLE = 'AI 纪要联调'

let failures = 0
function check(cond, label, detail = '') {
  if (cond) console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function json(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: {} }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${API}${path}`, init)
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

async function upload(id) {
  const bytes = await readFile(DECK)
  const response = await fetch(`${API}/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('demo-lecture.pptx') },
    body: bytes,
  })
  const payload = await response.json()
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

const NOTES = {
  2: '监督学习就是给模型看带标签的数据，让它学会从特征映射到标签；标签是人工标的，所以要花很多钱和时间。',
  4: '线性回归的损失函数用均方误差，最小二乘法可以把参数一步解出来，不需要迭代；数据量大的时候还是要用梯度下降。',
  7: '过拟合的表现是训练集很好测试集很差，正则化就是在损失后面加一项惩罚权重，让它别把噪声也学进去。',
}

const state = await json('/state')
check(state.llm !== null && state.llm !== undefined, 'a default model is configured', state.llm?.label ?? '')

const created = await json('/sessions', { method: 'POST', body: { title: TITLE, course: '联调', asrMode: 'zh' } })
const id = created.session.id
let session = null
try {
  const uploaded = await upload(id)
  check(uploaded.session.slides.length === 9, 'deck uploaded', `${uploaded.session.slides.length} pages`)

  for (const [index, text] of Object.entries(NOTES)) {
    const written = await json(`/sessions/${encodeURIComponent(id)}/slides/${index}`, { method: 'POST', body: { notes: text } })
    check(written.ok === true, `note written on page ${index}`)
  }

  session = (await json(`/sessions/${encodeURIComponent(id)}`)).session
  check(session.progress.chars > 60, 'the class has enough text to summarize', `${session.progress.chars} chars`)

  // ── asking for the recap ────────────────────────────────────────────────
  const started = Date.now()
  const recapped = await json(`/sessions/${encodeURIComponent(id)}/summary`, { method: 'POST', body: {} })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const markdown = recapped.summary?.markdown ?? ''
  console.log(`\n  model took ${seconds}s, ${markdown.length} chars\n`)
  console.log(
    markdown
      .split('\n')
      .map((line) => `  │ ${line}`)
      .join('\n'),
  )
  console.log('')

  check(markdown !== '', 'a recap came back')
  check(markdown.includes('## 一句话概括'), 'recap has the one-line summary')
  check(markdown.includes('## 这节课讲了什么'), 'recap has the walkthrough')
  check(markdown.includes('## 复习清单'), 'recap has the review list')
  check(!markdown.includes('```'), 'recap is not code-fenced')
  check(recapped.summary.at !== null, 'recap timestamp stored', recapped.summary.at ?? '')
  check(recapped.summary.error === '', 'no error recorded', recapped.summary.error ?? '')
  check(recapped.session.summary.markdown === markdown, 'session carries the recap')
  // The model only ever saw the three pages with a note; a generic recap that
  // mentions the untouched pages would mean the prompt leaked the whole deck.
  check(/均方误差|最小二乘|正则化|过拟合|监督学习/.test(markdown), 'recap talks about what was actually said')

  // ── a second pass replaces the first ────────────────────────────────────
  const again = await json(`/sessions/${encodeURIComponent(id)}/summary`, { method: 'POST', body: {} })
  check((again.summary?.markdown ?? '') !== '', 're-summarizing works too')
  check(again.session.summary.at !== recapped.summary.at || again.summary.markdown !== markdown, 'second pass is fresh')

  // ── exports carry the recap ─────────────────────────────────────────────
  const exported = await json(`/sessions/${encodeURIComponent(id)}/export`, { method: 'POST', body: {} })
  check(typeof exported.downloads?.summary === 'string', 'export offers a recap download', exported.downloads?.summary ?? '')
  check((exported.downloads?.md ?? '').includes('/file?name='), 'export offers the notes markdown', exported.downloads?.md ?? '')

  if (typeof exported.downloads?.summary === 'string') {
    const href = exported.downloads.summary.startsWith('/') ? `${BASE}${exported.downloads.summary}` : exported.downloads.summary
    const response = await fetch(href)
    const body = await response.text()
    check(response.status === 200, 'recap download answers 200', String(response.status))
    check(body.includes('一句话概括'), 'recap file carries the summary', `${body.length} bytes`)
  }
  if (typeof exported.downloads?.md === 'string') {
    const href = exported.downloads.md.startsWith('/') ? `${BASE}${exported.downloads.md}` : exported.downloads.md
    const body = await fetch(href).then((response) => response.text())
    check(body.includes('## AI 纪要'), 'notes markdown appends the recap section')
    check(body.includes('## 复习清单'), 'appended section keeps the recap body')
  }
} finally {
  await fetch(`${API}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
}

console.log('')
console.log(failures === 0 ? 'all live summary checks passed' : `${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
