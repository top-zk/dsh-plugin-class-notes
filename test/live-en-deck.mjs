/**
 * The motivating case, end to end: an English deck, a Chinese lecture, and the
 * page turns that only happen because the keywords get Chinese glosses.
 *
 *   node test/live-en-deck.mjs
 *
 * Uploads test/en-lecture.pptx to the running host, runs keyword extraction
 * (which also runs the gloss pass), and prints each slide's keywords and
 * glosses so the mapping can be eyeballed. Then it feeds Chinese lines through
 * the tracker to show the page turns land where the teacher is.
 */
import { readFile } from 'node:fs/promises'
import { evaluateChunk } from '../lib/tracker.js'

const API = `${process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52296'}/dsh-class-notes`
const DECK = new URL('./en-lecture.pptx', import.meta.url)
const CHUNK_MS = 5_500

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}${detail === '' ? '' : `  -> ${detail}`}`)
  if (!ok) failures += 1
}

async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const payload = await response.json().catch(() => ({}))
  if (response.ok !== true) throw new Error(`${path} -> ${response.status} ${payload.error ?? ''}`)
  return payload
}

const created = await json('/sessions', { method: 'POST', body: { title: 'en-deck live check', asrMode: 'zh' } })
const id = created.session.id
try {
  await fetch(`${API}/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('en-lecture.pptx') },
    body: await readFile(DECK),
  })
  const picked = await json(`/sessions/${encodeURIComponent(id)}/keywords`, { method: 'POST', body: {} })
  let session = picked.session
  check(session.slides.length === 4, 'deck uploaded: 4 slides', String(session.slides.length))
  for (const slide of session.slides) {
    console.log(`  ${slide.index}. ${slide.title}`)
    console.log(`     kw: ${(slide.keywords ?? []).join(' / ')}`)
    console.log(`     gloss: ${JSON.stringify(slide.keywordGlosses ?? {})}`)
  }

  const glossed = session.slides.filter((slide) => Object.keys(slide.keywordGlosses ?? {}).length >= 2).length
  check(glossed >= 3, 'at least 3 slides have Chinese glosses', `${glossed}/4`)

  // What the teacher actually says, slide by slide, in Chinese.
  const spoken = [
    ['这节课我们把反向传播再讲一遍，还是靠链式法则一层层往回推', '反向传播的每一步其实就是梯度下降的一次更新'],
    ['先讲过拟合，也就是模型把训练集背下来了', '压住过拟合的办法就是正则化，也可以叫权重衰减'],
    ['优化器再补充一个动量法，或者直接用 Adam', '批大小会影响收敛的稳定性'],
  ]
  // Timestamps must be real wall clock: the dwell guard measures against the
  // upload's `lastAdvanceAt`, so a synthetic epoch puts every chunk in the past.
  const base = Date.now()
  let position = 0
  const landed = []
  for (const group of spoken) {
    for (const line of group) {
      const decision = evaluateChunk({
        session,
        tracker: session.tracker,
        chunk: line,
        now: base + position * CHUNK_MS,
      })
      position += 1
      session = {
        ...session,
        tracker: decision.tracker,
        recording: { ...session.recording, currentIndex: decision.index },
      }
      if (decision.advance) landed.push(decision.index)
    }
  }
  check(landed.length >= 2, 'Chinese lecture turns the English deck', landed.join('->') || 'no turns')
  check(landed[0] === 2, 'first turn lands on slide 2', String(landed[0]))
  check(landed[1] === 3, 'second turn lands on slide 3', String(landed[1]))
} finally {
  await json(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  console.log(`deleted ${id}`)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
