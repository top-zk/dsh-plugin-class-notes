/**
 * Live check against the running host: the Chinese gloss pass on a real deck.
 *
 *   node test/live-gloss.mjs
 *
 * Talks to http://127.0.0.1:52296 (override with DSH_WEB_URL). Uploads the demo
 * deck, runs the keyword pass (which also runs the gloss pass), then checks that
 * English terms now carry Chinese wording, that the `gloss` route works on its
 * own, and that a hand-edited keyword list keeps only the surviving glosses.
 * The session it creates is deleted at the end.
 */
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52296'
const API = `${BASE}/dsh-class-notes`
const DECK = new URL('./demo-lecture.pptx', import.meta.url)

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}${detail === '' ? '' : `  → ${detail}`}`)
  if (!ok) failures += 1
}

async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const payload = await response.json().catch(() => ({}))
  if (response.ok !== true) throw new Error(`${path} → ${response.status} ${payload.error ?? ''}`)
  return payload
}

async function upload(id) {
  const bytes = await (await import('node:fs/promises')).readFile(DECK)
  const response = await fetch(`${API}/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('demo-lecture.pptx') },
    body: bytes,
  })
  const payload = await response.json()
  if (response.ok !== true) throw new Error(`deck → ${response.status} ${payload.error ?? ''}`)
  return payload
}

const created = await json('/sessions', { method: 'POST', body: { title: '中文说法联调', course: '联调', asrMode: 'zh' } })
const id = created.session.id
console.log(`session ${id}`)
try {
  const uploaded = await upload(id)
  check(uploaded.session.slides.length === 9, '传了 9 页', String(uploaded.session.slides.length))

  const picked = await json(`/sessions/${encodeURIComponent(id)}/keywords`, { method: 'POST', body: {} })
  const slides = picked.session.slides
  check(picked.keywordSource === 'llm', '关键词走的是模型', picked.keywordSource)
  const glossed = slides.filter((slide) => Object.keys(slide.keywordGlosses ?? {}).length > 0).length
  const latinSlides = slides.filter((slide) => (slide.keywords ?? []).some((word) => /[A-Za-z]/.test(word))).length
  check(latinSlides > 0, '这份 demo 课件有英文术语', `${latinSlides} 页含英文`)
  check(
    latinSlides === 0 || glossed >= Math.min(2, latinSlides),
    '英文术语配上了中文说法（中文词本身不用配）',
    `${glossed} 页有 · ${latinSlides} 页含英文`,
  )
  check(picked.session.meta.glossAt !== null, 'glossAt 有值', String(picked.session.meta.glossAt))
  const sample = slides.find((slide) => slide.index === 3)
  console.log('       第 3 页关键词：', (sample?.keywords ?? []).join('、'))
  console.log('       第 3 页中文说法：', JSON.stringify(sample?.keywordGlosses ?? {}))
  const anyGloss = slides.some((slide) => Object.values(slide.keywordGlosses ?? {}).some((value) => /[\u4e00-\u9fff]/.test(value)))
  check(anyGloss, '有词配上了中文说法')

  const regloss = await json(`/sessions/${encodeURIComponent(id)}/gloss`, { method: 'POST', body: {} })
  check(regloss.ok === true, '单独的 gloss 接口能跑', String(regloss.session.slides.length))

  // Deleting a keyword must delete its gloss too.
  const target = regloss.session.slides.find((slide) => Object.keys(slide.keywordGlosses ?? {}).length > 0)
  if (target !== undefined) {
    const [first] = Object.keys(target.keywordGlosses)
    const kept = target.keywords.filter((word) => word !== first)
    const after = await json(`/sessions/${encodeURIComponent(id)}/slides/${target.index}`, { method: 'POST', body: { keywords: kept } })
    const edited = after.session.slides.find((slide) => slide.index === target.index)
    check(edited.keywordGlosses?.[first] === undefined, '删掉关键词，它的中文说法也一起走')
  } else {
    check(false, '删掉关键词，它的中文说法也一起走', '没有可删的样本')
  }
} finally {
  await json(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  console.log(`deleted ${id}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
