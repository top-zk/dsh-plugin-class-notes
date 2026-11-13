/**
 * Canonical shapes for one class-note session, plus the normalizers that make
 * sure a document read back from disk (or hand-edited by the user) always has
 * exactly the fields the rest of the plugin assumes.
 *
 * @module dsh-plugin-class-notes/model
 */

/** Status values a session moves through. */
export const SESSION_STATUS = {
  draft: 'draft',
  ready: 'ready',
  recording: 'recording',
  done: 'done',
}

/**
 * Transcription modes. `mixed` maps to the recognizer's language auto-detect,
 * which is what picks up English terms inside Chinese speech.
 */
export const ASR_MODES = ['zh', 'mixed', 'en']

/** Label + hint for each mode, shared by the panel and the API. */
export const ASR_MODE_INFO = [
  { id: 'zh', label: '中文', hint: '只按中文转写，英文词会尽量写成中文音', language: 'zh' },
  { id: 'mixed', label: '中英混合', hint: '中文里夹的英文单词、缩写跟着原样留下', language: 'auto' },
  { id: 'en', label: 'English', hint: '整段按英文转写，中文部分会变成拼音样的英文', language: 'en' },
]

/** Fall back to the mixed mode for anything unknown. */
export function normalizeAsrMode(value) {
  return ASR_MODES.includes(value) ? value : 'mixed'
}

/** The recognizer language a mode asks for. */
export function asrLanguage(mode) {
  const found = ASR_MODE_INFO.find((item) => item.id === normalizeAsrMode(mode))
  return found === undefined ? 'auto' : found.language
}

let idCounter = 0

/** `cls-<timestamp>-<counter>` — unique enough for a local tool. */
export function newId(prefix = 'cls', now = new Date()) {
  idCounter += 1
  const stamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${idCounter.toString(36)}`
}

/** Local `YYYY-MM-DD`. */
export function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local `YYYY-MM-DD HH:mm:ss`. */
export function formatMoment(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Coerce to a trimmed string, never throwing on odd input. */
export function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Keep only trimmed, non-empty unique strings. */
export function strList(value, limit = 64) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = str(item)
    if (text === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** Clamp a number into range with a fallback. */
export function num(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** One slide, canonical. */
export function normalizeSlide(input, index) {
  const slide = input !== null && typeof input === 'object' ? input : {}
  return {
    index: num(slide.index, index, 1, 5000),
    title: str(slide.title),
    body: str(slide.body),
    notes: str(slide.notes),
    keywords: strList(slide.keywords, 40),
    // Glosses of the deck's own terms, in the language the lecture is spoken in.
    // A Chinese lecture over an English deck says 反向传播 where the slide says
    // backpropagation, so every English term keeps the wording a teacher would
    // actually speak; an English lecture over a Chinese deck needs the reverse.
    keywordsZh: strList(slide.keywordsZh, 40),
    titleZh: str(slide.titleZh),
    titleEn: str(slide.titleEn),
    keywordGlosses: normalizeGlosses(slide.keywordGlosses),
    keywordSource: str(slide.keywordSource, 'heuristic'),
    segments: normalizeSegments(slide.segments),
    hitCount: num(slide.hitCount, 0, 0, 1_000_000),
    startedAt: str(slide.startedAt) === '' ? null : str(slide.startedAt),
    endedAt: str(slide.endedAt) === '' ? null : str(slide.endedAt),
  }
}

/** `term → 中文说法`, capped and trimmed. */
function normalizeGlosses(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    const term = str(key)
    const gloss = str(raw)
    if (term === '' || gloss === '' || term === gloss) continue
    out[term] = gloss.slice(0, 80)
    count += 1
    if (count >= 80) break
  }
  return out
}

/** The transcript rows that landed on one slide. */
export function normalizeSegments(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const text = str(item.text)
    if (text === '') continue
    out.push({
      at: str(item.at),
      text,
      score: num(item.score, 0),
      manual: item.manual === true,
    })
  }
  return out
}

/** One tracker history row. */
function normalizeHistoryRow(row) {
  if (row === null || typeof row !== 'object') return null
  return {
    at: str(row.at),
    text: str(row.text).slice(0, 240),
    slideIndex: num(row.slideIndex, 0, 0),
    score: num(row.score, 0),
    aheadIndex: num(row.aheadIndex, 0, 0),
    aheadScore: num(row.aheadScore, 0),
    aheadSpecificScore: num(row.aheadSpecificScore, 0),
    evidenceScore: num(row.evidenceScore, 0),
    hits: strList(row.hits, 24),
    aheadHits: strList(row.aheadHits, 24),
  }
}

/** One chunk held back until the page turn is confirmed. */
function normalizePendingRow(row) {
  if (row === null || typeof row !== 'object') return null
  const text = str(row.text)
  if (text === '') return null
  return {
    at: str(row.at),
    text: text.slice(0, 2000),
    score: num(row.score, 0),
  }
}

/** The rolling page-turn state. */
export function normalizeTracker(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const history = Array.isArray(source.history)
    ? source.history.map(normalizeHistoryRow).filter((row) => row !== null).slice(-400)
    : []
  const pending = Array.isArray(source.pending)
    ? source.pending.map(normalizePendingRow).filter((row) => row !== null).slice(-6)
    : []
  return {
    history,
    pending,
    streak: num(source.streak, 0, 0, 100),
    lastAdvanceAt: Number.isFinite(Number(source.lastAdvanceAt)) ? Number(source.lastAdvanceAt) : null,
    lastDecision: source.lastDecision !== null && typeof source.lastDecision === 'object' ? source.lastDecision : null,
  }
}

/**
 * The AI recap of one class. `markdown` is what the panel draws and what the
 * export appends; `at` proves a pass ran even when the model came back empty.
 */
export function normalizeSummary(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  return {
    at: str(source.at) === '' ? null : str(source.at),
    model: str(source.model),
    markdown: str(source.markdown),
    error: str(source.error),
  }
}

/** One session, canonical. */
export function normalizeSession(input, options = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const now = options.now ?? new Date()
  const slides = Array.isArray(source.slides)
    ? source.slides.map((slide, position) => normalizeSlide(slide, position + 1))
    : []
  slides.sort((a, b) => a.index - b.index)

  const meta = source.meta !== null && typeof source.meta === 'object' ? source.meta : {}
  return {
    id: str(source.id) === '' ? newId('cls', now) : str(source.id),
    title: str(source.title, '未命名听课'),
    course: str(source.course),
    date: str(source.date, localDay(now)),
    notes: str(source.notes),
    status: Object.values(SESSION_STATUS).includes(source.status) ? source.status : SESSION_STATUS.draft,
    asrMode: normalizeAsrMode(source.asrMode),
    finishedAt: str(source.finishedAt) === '' ? null : str(source.finishedAt),
    createdAt: str(source.createdAt, now.toISOString()),
    updatedAt: str(source.updatedAt, now.toISOString()),
    meta: {
      fileName: str(meta.fileName),
      sourcePath: str(meta.sourcePath),
      slideWidth: num(meta.slideWidth, 0, 0),
      slideHeight: num(meta.slideHeight, 0, 0),
      keywordsAt: str(meta.keywordsAt) === '' ? null : str(meta.keywordsAt),
      keywordsModel: str(meta.keywordsModel),
      keywordsError: str(meta.keywordsError),
      glossAt: str(meta.glossAt) === '' ? null : str(meta.glossAt),
    glossDirection: str(meta.glossDirection),
      glossModel: str(meta.glossModel),
      glossError: str(meta.glossError),
      importKind: meta.importKind === 'pdf' ? 'pdf' : 'pptx',
      pdfPages: num(meta.pdfPages, 0, 0, 10_000),
      pdfRenderedPages: num(meta.pdfRenderedPages, 0, 0, 10_000),
      pdfWarning: str(meta.pdfWarning),
    },
    recording: {
      active: source.recording?.active === true,
      currentIndex: num(source.recording?.currentIndex, slides.length > 0 ? 1 : 0, 0, 9999),
      startedAt: str(source.recording?.startedAt) === '' ? null : str(source.recording?.startedAt),
      stoppedAt: str(source.recording?.stoppedAt) === '' ? null : str(source.recording?.stoppedAt),
      chunks: num(source.recording?.chunks, 0, 0, 1_000_000),
      audioSeconds: num(source.recording?.audioSeconds, 0, 0, 1_000_000),
      advances: num(source.recording?.advances, 0, 0, 1_000_000),
    },
    slides,
    tracker: normalizeTracker(source.tracker),
    transcript: str(source.transcript),
    summary: normalizeSummary(source.summary),
  }
}

/** Index of the last slide that exists (0 when the deck is empty). */
export function lastIndex(session) {
  const slides = Array.isArray(session?.slides) ? session.slides : []
  return slides.length === 0 ? 0 : slides[slides.length - 1].index
}

/** Find one slide by its 1-based index. */
export function slideAt(session, index) {
  const slides = Array.isArray(session?.slides) ? session.slides : []
  return slides.find((slide) => slide.index === index) ?? null
}

/** The union of every slide's transcript rows, in slide order. */
export function sessionTranscript(session) {
  const slides = Array.isArray(session?.slides) ? session.slides : []
  const lines = []
  for (const slide of slides) {
    if (slide.segments.length === 0) continue
    lines.push(`【第 ${slide.index} 页${slide.title === '' ? '' : ` · ${slide.title}`}】`)
    for (const segment of slide.segments) lines.push(segment.text)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * Rebuild the readable note body of one slide from its transcript rows. Manual
 * text (`source: 'manual'`) is appended last and never dropped.
 */
export function slideNote(slide) {
  const parts = []
  for (const segment of slide.segments) {
    if (segment.manual === true) continue
    parts.push(segment.text)
  }
  const auto = parts.join(' ').replace(/\s+/g, ' ').trim()
  const manual = slide.notes.trim()
  if (auto === '') return manual
  if (manual === '') return auto
  return `${auto}\n\n【老师补充】${manual}`
}

/** Progress counters the panel shows in the header. */
export function sessionProgress(session) {
  const slides = Array.isArray(session?.slides) ? session.slides : []
  let noted = 0
  let chars = 0
  let keywords = 0
  for (const slide of slides) {
    const note = slideNote(slide)
    if (note !== '') noted += 1
    chars += note.length
    keywords += slide.keywords.length
  }
  return { slides: slides.length, noted, chars, keywords, advances: session?.recording?.advances ?? 0 }
}

/**
 * The shape handed to the browser: identical to the stored session, plus the
 * rendered note per slide and the progress counters, minus the long tracker
 * history (the panel only draws the last few decisions).
 */
export function viewSession(session, historyLimit = 8) {
  return {
    ...session,
    tracker: {
      ...session.tracker,
      history: session.tracker.history.slice(-historyLimit),
    },
    slides: session.slides.map((slide) => ({
      ...slide,
      note: slideNote(slide),
      segmentCount: slide.segments.length,
    })),
    progress: sessionProgress(session),
  }
}

/** Compact projection for the session list. */export function projectSession(session) {
  const progress = sessionProgress(session)
  return {
    id: session.id,
    title: session.title,
    course: session.course,
    date: session.date,
    status: session.status,
    asrMode: session.asrMode,
    finishedAt: session.finishedAt,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    slideCount: progress.slides,
    notedCount: progress.noted,
    keywordCount: progress.keywords,
    hasPptx: session.meta.fileName !== '',
    hasSummary: session.summary.markdown !== '',
    sourcePath: session.meta.sourcePath === '' ? null : session.meta.sourcePath,
  }
}
