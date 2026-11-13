import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDeck } from '../lib/deck.js'
import { heuristicKeywordsForDeck } from '../lib/keywords.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const parsed = await parseDeck(join(HERE, 'demo-lecture.pptx'))
const map = heuristicKeywordsForDeck(parsed.raw)
for (const slide of parsed.raw) {
  console.log(`${slide.index}. ${slide.title}`)
  console.log(`   ${(map.get(slide.index) ?? []).join(' | ')}`)
}
