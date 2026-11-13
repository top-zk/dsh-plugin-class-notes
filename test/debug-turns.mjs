import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClassNotesStore } from '../lib/store.js'
import { parseDeck, saveDeckBytes } from '../lib/deck.js'
import { extractDeckKeywords } from '../lib/keywords.js'
import { evaluateChunk, trackerAfterManualJump } from '../lib/tracker.js'
import { slideNote } from '../lib/model.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEMO = join(HERE, 'demo-lecture.pptx')
const OUT = join(HERE, 'out-debug')

import { LECTURE } from './lecture.mjs'

const store = new ClassNotesStore({ root: join(OUT, 'storages') })
const created = await store.create({ title: 'debug', course: 'debug' })
const bytes = await readFile(DEMO)
await saveDeckBytes(bytes.toString('base64'), store.sourcePath(created.id), 'demo.pptx')
const parsed = await parseDeck(store.sourcePath(created.id))
const extracted = await extractDeckKeywords({ slides: parsed.raw })
const byIndex = new Map(extracted.slides.map((e) => [e.index, e]))

let session = await store.update(created.id, (draft) => {
  draft.slides.length = 0
  for (const slide of parsed.slides) {
    draft.slides.push({ ...slide, keywords: byIndex.get(slide.index)?.keywords ?? [], keywordSource: 'heuristic' })
  }
  draft.recording.currentIndex = 1
  return draft
})

let now = Date.now()
session = await store.update(created.id, (draft) => {
  draft.tracker = trackerAfterManualJump(draft.tracker, now)
  draft.recording.active = true
  return draft
})

for (const [label, text] of LECTURE) {
  now += 5_500
  const line = []
  session = await store.update(created.id, (draft) => {
    const d = evaluateChunk({ session: draft, tracker: draft.tracker, chunk: text, now })
    draft.tracker = d.tracker
    draft.recording.currentIndex = d.index
    if (d.advance) draft.recording.advances += 1
    const target = draft.slides.find((s) => s.index === d.index)
    for (const row of d.carry) if (target && row.text) target.segments.push({ at: row.at, text: row.text, score: row.score, manual: false })
    line.push(
      `${label}→${d.index} here=${d.decision.here} ahead=${d.decision.ahead} spec=${d.decision.aheadSpecific} streak=${d.decision.streak} win=${d.decision.windowAhead} ${d.decision.reason} carry=${d.carry.length}`,
    )
    if (d.decision.aheadSpecificHits.length) line.push(`   specHits: ${d.decision.aheadSpecificHits.join(',')}`)
    return draft
  })
  console.log(line.join('\n'))
}

console.log('\nsegments per slide:')
for (const slide of session.slides) {
  console.log(`${slide.index}. ${slide.title} — ${slide.segments.length}`)
  for (const segment of slide.segments) console.log(`     ${segment.text}`)
}

