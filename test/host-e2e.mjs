/**
 * End-to-end harness for the host half: no browser, no HTTP.
 *
 * It walks the exact path the panel drives — create a session, ingest the demo
 * deck, extract keywords, feed synthetic lecture speech chunk by chunk, and
 * export the annotated deck — and asserts the page turns landed where a human
 * would have turned them.
 *
 *   node test/host-e2e.mjs
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { ClassNotesStore } from '../lib/store.js'
import { attachChunk } from '../lib/server.js'
import { extractDeckKeywords, heuristicKeywords } from '../lib/keywords.js'
import { parseDeck, saveDeckBytes, writeDeckNotes } from '../lib/deck.js'
import { trackerAfterManualJump } from '../lib/tracker.js'
import { lastIndex, slideAt, slideNote, viewSession } from '../lib/model.js'
import { LECTURE } from './lecture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEMO = join(HERE, 'demo-lecture.pptx')
const OUT = join(HERE, 'out')

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label} ${detail}`)
    failures.push(label)
  }
}

/** A synthetic lecture: what the recognizer would hand back, page by page. */
async function main() {
  await rm(OUT, { recursive: true, force: true })
  const root = join(OUT, 'storages')
  const store = new ClassNotesStore({ root })

  console.log('1. 建一节听课')
  const created = await store.create({ title: '第 3 讲 机器学习入门', course: '数据科学导论' })
  check('session created', typeof created.id === 'string' && created.id.startsWith('cls-'), created.id)

  console.log('2. 上传 PPT')
  const bytes = await readFile(DEMO)
  await saveDeckBytes(bytes.toString('base64'), store.sourcePath(created.id), 'demo-lecture.pptx')
  const parsed = await parseDeck(store.sourcePath(created.id))
  check('slide count is 9', parsed.slideCount === 9, String(parsed.slideCount))
  check('slide 3 keeps the teacher note', parsed.raw[2].notes.includes('思考题'), parsed.raw[2].notes)

  console.log('3. 提取关键词（无模型时走启发式）')
  const extracted = await extractDeckKeywords({ slides: parsed.raw })
  check('keyword source is heuristic', extracted.source === 'heuristic', extracted.source)
  const keywordsByIndex = new Map(extracted.slides.map((entry) => [entry.index, entry.keywords]))
  for (const index of [2, 3, 4, 5, 6, 7]) {
    const list = keywordsByIndex.get(index) ?? []
    check(`slide ${index} has keywords`, list.length >= 3, JSON.stringify(list))
  }
  console.log(`     slide 2: ${(keywordsByIndex.get(2) ?? []).join(' / ')}`)
  console.log(`     slide 5: ${(keywordsByIndex.get(5) ?? []).join(' / ')}`)

  console.log('4. 写入 session 并模拟录音')
  let session = await store.update(created.id, (draft) => {
    const byIndex = new Map(extracted.slides.map((entry) => [entry.index, entry]))
    const slides = draft.slides
    slides.length = 0
    for (const slide of parsed.slides) {
      slides.push({
        ...slide,
        keywords: byIndex.get(slide.index)?.keywords ?? [],
        keywordSource: 'heuristic',
      })
    }
    draft.meta.fileName = 'demo-lecture.pptx'
    draft.meta.sourcePath = store.sourcePath(created.id)
    draft.recording.currentIndex = 1
    draft.status = 'ready'
    return draft
  })
  check('9 slides stored', session.slides.length === 9, String(session.slides.length))
  check('current slide is 1', session.recording.currentIndex === 1)

  let now = Date.now()
  const turns = []
  session = await store.update(created.id, (draft) => {
    draft.recording.active = true
    draft.status = 'recording'
    draft.tracker = trackerAfterManualJump(draft.tracker, now)
    return draft
  })

  for (const [expected, text] of LECTURE) {
    now += 5_500
    const before = session.recording.currentIndex
    session = await attachChunk({ store }, created.id, text, { now, audioSeconds: 5 })
    const moved = session.recording.currentIndex !== before
    if (moved) turns.push([expected, session.recording.currentIndex, text.slice(0, 18)])
  }

  console.log('5. 翻页结果')
  for (const [expected, actual, text] of turns) {
    console.log(`     ${expected === actual ? 'ok  ' : 'BAD '} 期望第 ${expected} 页 → 实际第 ${actual} 页  「${text}…」`)
  }
  const wrong = turns.filter(([expected, actual]) => expected !== actual)
  check('每一次翻页都落在期望的页', wrong.length === 0, JSON.stringify(wrong))

  const landed = session.recording.currentIndex
  check('最后停在最后一页', landed === 8, String(landed))
  for (const index of [2, 4, 5, 6, 7, 8]) {
    const slide = slideAt(session, index)
    check(`第 ${index} 页有话`, slide.segments.length >= 2, `${slide.segments.length} 段`)
  }
  check('第 1 页（封面）没有说话', slideAt(session, 1).segments.length === 0)
  check('第 3 页没有串到第 2 页的话', slideAt(session, 3).segments.every((segment) => !segment.text.includes('机器学习')))

  console.log('6. 手动加备注 + 导出')
  session = await store.update(created.id, (draft) => {
    const slide = slideAt(draft, 3)
    slide.notes = '老师说这一页要背下来'
    return draft
  })
  const bySlide = session.slides.map((slide) => ({
    index: slide.index,
    title: slide.title,
    note: slideNote(slide),
    keywords: slide.keywords,
  }))
  const target = join(OUT, '第3讲-听课笔记.pptx')
  const pages = join(OUT, '第3讲-听课笔记.md')
  const written = await writeDeckNotes({
    mode: 'both',
    source: store.sourcePath(created.id),
    target,
    pagesOut: pages,
    title: session.title,
    date: session.date,
    bySlide,
  })
  check('写备注页数 >= 7', (written.notesWritten ?? 0) >= 7, String(written.notesWritten))

  const markdown = await readFile(pages, 'utf8')
  check('markdown 有标题', markdown.includes('# 第 3 讲 机器学习入门'))
  check('markdown 有第 3 页老师补充', markdown.includes('老师说这一页要背下来'))
  check('markdown 有第 4 页线性回归内容', /##\s*4\./.test(markdown) && markdown.includes('最小二乘法'))

  console.log('7. 幂等：再导出一次不应该重复堆备注')
  await writeDeckNotes({
    mode: 'notes',
    source: store.sourcePath(created.id),
    target,
    title: session.title,
    date: session.date,
    bySlide,
  })
  const again = await parseDeck(target)
  const merged = again.raw[2].notes
  check('原老师的思考题还在', merged.includes('思考题'), merged)
  check('听课笔记标记只出现一次', merged.split('【听课笔记 · 录音整理】').length - 1 === 1, merged)

  const view = viewSession(session)
  check('view 带 progress', view.progress.slides === 9 && view.progress.noted >= 6, JSON.stringify(view.progress))
  check('view 的 tracker history 被裁剪', view.tracker.history.length <= 8, String(view.tracker.history.length))
  check('原 session 的 history 不止 8 条', session.tracker.history.length > 8, String(session.tracker.history.length))
  check('lastIndex 是 8', lastIndex(session) === 8 || lastIndex(session) === 9, String(lastIndex(session)))

  console.log('')
  if (failures.length === 0) {
    console.log(`全部通过。导出文件：${target}`)
    return 0
  }
  console.log(`${failures.length} 项失败：${failures.join('；')}`)
  return 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(2)
  },
)
