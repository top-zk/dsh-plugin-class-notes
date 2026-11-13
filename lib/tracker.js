/**
 * Live "which slide is the teacher on?" tracker.
 *
 * The recorder posts five-second transcript chunks. Each chunk is scored against
 * the keywords of the slide we are on and the keywords of the slide after it; a
 * page turn is declared only when the later slide clearly wins, and once a slide
 * is left behind the tracker never walks back — teachers digress, they do not
 * un-teach a page.
 *
 * The thresholds below are the whole product decision, so they are named and
 * kept in one place. They were tuned on the 9-slide demo deck: about twelve
 * seconds between unambiguous keyword hits is what ordinary lecture speech
 * looks like, and a two-chunk confirmation keeps a single "我们下节课……" aside
 * from jumping the deck forward.
 *
 * @module dsh-plugin-class-notes/tracker
 */

import { normalizeForMatch, scoreKeyword } from './keywords.js'
import { lastIndex, slideAt, str } from './model.js'

/** A slide must have been open at least this long before it can be left. */
export const MIN_DWELL_MS = 9_000
/** Recent chunks summed per side when deciding ("the last N chunks"). */
export const WINDOW_CHUNKS = 3
/** The next slide's own window score must reach this. */
export const ADVANCE_MIN_SCORE = 1.4
/** Confirmed consecutive chunks required before the page turn. */
export const CONFIRM_CHUNKS = 2
/** Ignore chunks that recognizer clearly produced badly (too little text). */
export const MIN_CHUNK_CHARS = 4

/**
 * Every wording that counts as evidence for one slide.
 *
 * A Chinese lecture over an English deck says 反向传播 where the slide says
 * backpropagation, so each keyword carries a gloss in the lecture's language and
 * both spellings are scored; the best spelling of a term counts once, never twice.
 *
 * @param {object} slide
 * @returns {{term: string, text: string, source: string}[]}
 */
function slideVariants(slide) {
  const out = []
  // `keywordGlosses` is keyed by the keyword as written, but a hand edit or an
  // older session can leave the case off; fall back to a case-insensitive hit.
  const glosses = slide?.keywordGlosses !== null && typeof slide?.keywordGlosses === 'object'
    ? slide.keywordGlosses
    : {}
  const looseKeys = new Map(Object.keys(glosses).map((term) => [term.trim().toLowerCase(), term]))
  for (const keyword of Array.isArray(slide?.keywords) ? slide.keywords : []) {
    out.push({ term: keyword, text: keyword, source: 'original' })
    const direct = glosses[keyword]
    const alias = typeof direct === 'string' ? keyword : looseKeys.get(str(keyword).trim().toLowerCase())
    const gloss = typeof direct === 'string' ? direct : (alias === undefined ? '' : glosses[alias])
    if (typeof gloss === 'string' && gloss !== '' && gloss !== keyword) {
      out.push({ term: keyword, text: gloss, source: 'gloss' })
    }
  }
  // Keywords written straight into Chinese (decks that were mostly English but
  // the model already gave the Chinese wording as the keyword itself).
  for (const extra of Array.isArray(slide?.keywordsZh) ? slide.keywordsZh : []) {
    out.push({ term: extra, text: extra, source: 'zh' })
  }
  return out
}

/** Score one chunk against one slide's keywords (and their Chinese glosses). */
export function scoreSlide(slide, normalizedChunk) {
  if (slide === null || slide === undefined) return { score: 0, hits: [] }
  let score = 0
  const hits = []
  const best = new Map()
  for (const variant of slideVariants(slide)) {
    const value = scoreKeyword(variant.text, normalizedChunk)
    if (value <= 0) continue
    const previous = best.get(variant.term)
    if (previous === undefined || previous.value < value) {
      best.set(variant.term, { value, text: variant.text })
    }
  }
  for (const entry of best.values()) {
    score += entry.value
    hits.push(entry.text)
  }
  return { score: Math.round(score * 100) / 100, hits }
}

/**
 * Keywords of the next slide that the current slide never mentions.
 *
 * Every deck repeats its topic words on page after page; only terms the current
 * page does not carry are evidence that the teacher actually moved on.
 *
 * The comparison is in the lecture's language: when the current page says
 * "Weight decay", the gloss 「权重衰减」 is the same word, so the raw English
 * term must not count as news just because the page spells it differently.
 */
function specificKeywords(next, current) {
  const keywords = Array.isArray(next?.keywords) ? next.keywords : []
  if (current === null || current === undefined) return keywords
  const glossOf = (slide, keyword) => {
    const glosses = slide?.keywordGlosses
    if (glosses === null || typeof glosses !== 'object') return []
    const direct = glosses[keyword]
    if (typeof direct === 'string') return [direct]
    const key = String(keyword).trim().toLowerCase()
    return Object.entries(glosses)
      .filter(([term]) => term.trim().toLowerCase() === key)
      .map(([, value]) => value)
  }
  const describe = (slide, keyword) => [keyword, ...glossOf(slide, keyword)]
  const currentWords = []
  for (const keyword of Array.isArray(current.keywords) ? current.keywords : []) {
    currentWords.push(...describe(current, keyword))
  }
  currentWords.push(...(Array.isArray(current.keywordsZh) ? current.keywordsZh : []))
  const currentText = normalizeForMatch(
    [current.title, current.body, ...currentWords]
      .filter((part) => typeof part === 'string')
      .join(' '),
  )
  return keywords.filter((keyword) => {
    const needle = normalizeForMatch(keyword)
    if (needle === '') return false
    if (currentText.includes(needle)) return false
    // Also drop the next page's term when its gloss is already on this page.
    return !glossOf(next, keyword).some((gloss) => {
      const other = normalizeForMatch(gloss)
      return other !== '' && currentText.includes(other)
    })
  })
}

/** Tracker state lives on the session, under `tracker`. */
export function emptyTracker() {
  return {
    /** `{at, text, slideIndex, score, hits, aheadIndex, aheadScore, aheadHits}[]`, capped. */
    history: [],
    /** Chunks that look like the next slide but are not confirmed yet. */
    pending: [],
    /** Consecutive chunks the later slide has been winning. */
    streak: 0,
    /** Wall clock of the last page turn. */
    lastAdvanceAt: null,
    /** Last computed scores, for the panel. */
    lastDecision: null,
  }
}

/** Cap the rolling history so a three-hour lecture cannot grow it forever. */
const HISTORY_LIMIT = 400
/** Cap the held-chunk buffer: a long digression must not grow without bound. */
const PENDING_LIMIT = 6

/**
 * Score a new chunk and decide whether the deck advanced.
 *
 * `carry` is the part that keeps the notes honest: a chunk that only looks like
 * the next slide is held back until the following chunk confirms it, and then
 * both are written to the *new* page. Without that buffer the first sentence of
 * every page would stay behind in the previous page's notes.
 *
 * @param {object} options
 *   - `session`: the session whose `slides` we read.
 *   - `tracker`: previous tracker state (or `emptyTracker()`).
 *   - `chunk`: transcript text of this chunk.
 *   - `now`: epoch milliseconds.
 *   - `manual`: set when the user pressed next by hand (no auto-advance).
 * @returns {{advance: boolean, holding: boolean, index: number, from: number, carry: object[], decision: object, tracker: object, text: string}}
 */
export function evaluateChunk(options) {
  const session = options.session
  const tracker = options.tracker ?? emptyTracker()
  const now = options.now ?? Date.now()
  const text = typeof options.chunk === 'string' ? options.chunk.trim() : ''
  const normalized = normalizeForMatch(text)

  const currentIndex = Number(session?.recording?.currentIndex) || 0
  const current = slideAt(session, currentIndex)
  const nextIndex = currentIndex + 1
  const next = slideAt(session, nextIndex)
  const finalIndex = lastIndex(session)

  const pending = Array.isArray(tracker.pending) ? tracker.pending.slice(-PENDING_LIMIT) : []
  const here = scoreSlide(current, normalized)
  const ahead = scoreSlide(next, normalized)
  // The specific terms still need their glosses: a Chinese lecture says 「过拟合」
  // where the next page spells "Overfitting", and that is the whole evidence.
  const specific = specificKeywords(next, current)
  const specificGlosses = {}
  for (const term of specific) {
    const gloss = next?.keywordGlosses?.[term]
    if (typeof gloss === 'string' && gloss !== '') specificGlosses[term] = gloss
  }
  const aheadSpecific = scoreSlide({ keywords: specific, keywordGlosses: specificGlosses }, normalized)

  const history = [...tracker.history.slice(-(HISTORY_LIMIT - 1)), {
    at: new Date(now).toISOString(),
    text: text.slice(0, 200),
    slideIndex: currentIndex,
    score: here.score,
    aheadIndex: nextIndex,
    aheadScore: ahead.score,
    aheadSpecificScore: aheadSpecific.score,
    evidenceScore: here.score === 0 ? ahead.score : aheadSpecific.score,
    hits: here.hits,
    aheadHits: ahead.hits,
  }]

  const usable = text.length >= MIN_CHUNK_CHARS
  const dwellMs = tracker.lastAdvanceAt === null ? null : now - tracker.lastAdvanceAt
  const dwellOk = dwellMs === null || dwellMs >= MIN_DWELL_MS

  // Evidence: the chunk must carry something the next slide owns. When the
  // current slide shares no wording at all, any next-slide hit is itself the news.
  // `evidenceScore` is whichever of the two counts here, so the confirmation
  // window can add up comparable numbers instead of adding zeros.
  const evidenceScore = here.score === 0 ? ahead.score : aheadSpecific.score
  const evidence = usable && next !== null && evidenceScore > 0

  // Accumulated evidence over the confirmation run, so one lucky word is not enough.
  const runStart = Math.max(0, history.length - Math.max(1, Math.min(CONFIRM_CHUNKS, tracker.streak + 1)))
  let windowAhead = 0
  for (let position = runStart; position < history.length; position += 1) {
    const entry = history[position]
    if (entry.aheadIndex !== nextIndex) continue
    windowAhead += entry.evidenceScore ?? 0
  }
  windowAhead = Math.round(windowAhead * 100) / 100

  let streak = tracker.streak
  if (evidence) streak += 1
  else if (!usable) {
    // Silence or a failed recognition is not evidence either way; keep the run.
  } else streak = 0

  const decision = {
    at: new Date(now).toISOString(),
    currentIndex,
    nextIndex,
    here: here.score,
    ahead: ahead.score,
    aheadSpecific: aheadSpecific.score,
    hereHits: here.hits,
    aheadHits: ahead.hits,
    aheadSpecificHits: aheadSpecific.hits,
    dwellMs,
    streak,
    windowAhead,
    advance: false,
    reason: '',
  }

  let advance = false
  if (options.manual === true) {
    decision.reason = '手动翻页'
  } else if (next === null) {
    decision.reason = currentIndex >= finalIndex ? '已经是最后一页' : '没有下一页'
  } else if (!usable) {
    decision.reason = '这一片没有识别到内容'
  } else if (!evidence) {
    decision.reason = here.score > 0 ? '还在讲这一页' : '没有命中下一页的关键词'
  } else if (streak < CONFIRM_CHUNKS) {
    decision.reason = '等下一片确认'
  } else if (!dwellOk) {
    decision.reason = '这一页刚开始讲'
  } else if (windowAhead < ADVANCE_MIN_SCORE) {
    decision.reason = '下一页命中还不够多'
  } else {
    advance = true
    decision.reason = `识别到第 ${nextIndex} 页的关键词`
  }
  decision.advance = advance
  // Anything that smells like the next page but did not commit the turn is held
  // instead of being written: it is very likely page N+1's opening sentence, and
  // the next chunk decides whether it travels forward or falls back here.
  const holding = evidence && !advance
  decision.holding = holding

  const row = { at: new Date(now).toISOString(), text, score: here.score }
  // Held rows travel with the chunk that settles the question, so the notes get
  // the whole sentence even though the decision came one chunk later. While the
  // question is still open nothing is written at all — otherwise the held row
  // would be attached twice, once now and once after the turn.
  const carry = holding ? [] : [...pending, row]
  decision.carryCount = carry.length

  const nextTracker = {
    history,
    pending: holding ? [...pending, row].slice(-PENDING_LIMIT) : [],
    streak: advance ? 0 : streak,
    lastAdvanceAt: advance ? now : tracker.lastAdvanceAt,
    lastDecision: decision,
  }

  return {
    advance,
    holding,
    from: currentIndex,
    index: advance ? nextIndex : currentIndex,
    carry,
    decision,
    tracker: nextTracker,
    text,
  }
}

/**
 * Manual page jump: flush whatever was held into the page the user chose and
 * reset the confirmation state so the auto tracker starts fresh from there.
 */
export function trackerAfterManualJump(previous, now = Date.now()) {
  return {
    history: Array.isArray(previous?.history) ? previous.history : [],
    pending: [],
    streak: 0,
    lastAdvanceAt: now,
    lastDecision: previous?.lastDecision ?? null,
  }
}
