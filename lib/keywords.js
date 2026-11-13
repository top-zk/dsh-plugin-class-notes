/**
 * Keyword extraction for lecture slides.
 *
 * Two layers, deliberately:
 *
 * 1. `heuristicKeywords` — always available, decides the deck is usable even
 *    with no model configured. It pulls CJK terms, Latin terms and acronyms out
 *    of the slide text and drops anything that also shows up on most slides (a
 *    course title repeated on every page identifies nothing).
 *
 * 2. `extractDeckKeywords` — optionally refines those candidates through the
 *    current default LLM route, a few slides per request, and falls back to the
 *    heuristic set for any batch the model fails on.
 *
 * Keywords are not shown for their own sake: the live recorder matches the
 * speech against them to decide when the teacher moved on to the next slide, so
 * each one keeps its own `weight` (how much a hit means) and `match` (strict
 * substring for CJK, fuzzy for longer Latin phrases).
 *
 * @module dsh-plugin-class-notes/keywords
 */

import { str, strList } from './model.js'

/** Hard cap of keywords per slide. */
export const MAX_KEYWORDS_PER_SLIDE = 8
/** Slides sent to the model in one request. */
export const KEYWORD_BATCH_SIZE = 8
/** Deadline for one model request. */
const CALL_TIMEOUT_MS = 120_000
/** Output-token cap for one batch. */
const MAX_TOKENS = 4096

/**
 * Function words and slide furniture. A term made only of these identifies
 * nothing about the page it sits on, so it never becomes a keyword.
 */
const STOP_TOKENS = new Set([
  '我们', '你们', '他们', '今天', '昨天', '明天', '大家', '同学', '老师', '本节', '本页', '本次',
  '这个', '那个', '这些', '那些', '什么', '为什么', '怎么', '可以', '需要', '应该', '是否',
  '第一', '第二', '第三', '第四', '第五', '首先', '其次', '最后', '例如', '比如', '因此',
  '所以', '但是', '而且', '如果', '然后', '以及', '并且', '或者', '但是', '因为', '通过',
  '内容', '问题', '方法', '情况', '时候', '地方', '东西', '部分', '方面', '过程', '结果',
  '作用', '特点', '优点', '缺点', '定义', '概念', '介绍', '总结', '回顾', '练习', '作业',
  '课程', '课堂', '上课', '下面', '上面', '左右', '之前', '之后', '已经', '还有', '就是',
  '以及', '一个', '一些', '一种', '一起', '非常', '比较', '主要', '重要', '基本', '简单',
  '复杂', '一般', '通常', '常见', '典型', '相关', '对应', '分别', '包括', '包含', '属于',
  '具有', '进行', '实现', '完成', '出现', '产生', '得到', '获得', '成为', '作为', '用来',
  '用来', '基于', '针对', '关于', '对于', '由于', '随着', '根据', '按照', '利用', '使用',
])

/** Latin words that only carry grammar, never topic. */
const STOP_LATIN = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'are', 'was', 'were',
  'you', 'your', 'our', 'its', 'his', 'her', 'not', 'but', 'can', 'will', 'may', 'has', 'have',
  'how', 'why', 'what', 'when', 'where', 'which', 'who', 'all', 'any', 'each', 'more', 'most',
  'than', 'then', 'them', 'they', 'there', 'here', 'into', 'over', 'under', 'about', 'also',
  'very', 'such', 'some', 'only', 'other', 'same', 'used', 'using', 'use', 'see', 'let', 'get',
])

/** CJK ranges we treat as "Chinese content". */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,12}/gu
const LATIN_RUN = /[A-Za-z][A-Za-z0-9+#.\-]{1,28}/g
const NUMERIC_RUN = /\d+(?:\.\d+)?\s*[%％]?/g

/** Normalize text for matching: lowercase, alphanumerics and CJK only. */
export function normalizeForMatch(text) {
  const value = typeof text === 'string' ? text : ''
  return value
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9+#.]/gu, '')
}

/** True when a candidate is only function words. */
function isStopOnly(candidate) {
  if (candidate === '') return true
  if (STOP_LATIN.has(candidate.toLowerCase())) return true
  if (STOP_TOKENS.has(candidate)) return true
  // An all-CJK term built entirely from stop tokens (and their concatenation).
  let rest = candidate
  let consumed = false
  const tokens = [...STOP_TOKENS].sort((a, b) => b.length - a.length)
  for (const token of tokens) {
    while (rest.includes(token)) {
      rest = rest.replace(token, '')
      consumed = true
    }
  }
  return consumed && rest.length < 2
}

/** Weight of one keyword: how much a single hit is worth. */
export function keywordWeight(keyword) {
  const text = str(keyword)
  if (text === '') return 0
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  const digits = (text.match(/\d/g) ?? []).length
  const upper = (text.match(/[A-Z]/g) ?? []).length
  let weight = 0.55
  const body = cjk + latin + digits
  if (body >= 3) weight += 0.35
  if (body >= 5) weight += 0.25
  if (body >= 8) weight += 0.15
  if (digits > 0) weight += 0.2
  if (latin >= 2 && upper >= 2) weight += 0.2 // acronyms such as CNN, MSE, LSTM
  if (cjk > 0 && latin > 0) weight += 0.1
  return Math.round(Math.min(2.2, weight) * 100) / 100
}

/** Character bigrams of a normalized string. */
function bigrams(value) {
  const out = new Set()
  for (let index = 0; index + 1 < value.length; index += 1) out.add(value.slice(index, index + 2))
  return out
}

/** Jaccard similarity of two bigram sets. */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * How strongly one keyword matches a transcript chunk.
 *
 * CJK keywords match by substring (speech recognizers get Chinese terms right
 * far more often than Latin ones); Latin keywords of three characters or more
 * also match fuzzily, because "MSE" and "均方误差" both show up in real notes.
 *
 * @param {string} keyword - one keyword.
 * @param {string} normalizedChunk - `normalizeForMatch` output.
 * @returns {number} 0 when it does not match, otherwise `weight × strength`.
 */
export function scoreKeyword(keyword, normalizedChunk) {
  const text = str(keyword)
  if (text === '' || normalizedChunk === '') return 0
  const needle = normalizeForMatch(text)
  if (needle === '') return 0
  const weight = keywordWeight(text)

  if (normalizedChunk.includes(needle)) return weight

  // Long CJK phrases survive one dropped character in ASR output.
  if (needle.length >= 5 && CJK.test(needle)) {
    for (let start = 0; start + needle.length - 1 <= normalizedChunk.length; start += 1) {
      const window = normalizedChunk.slice(start, start + needle.length)
      if (window.length < needle.length - 1) break
      let same = 0
      for (let index = 0; index < Math.min(window.length, needle.length); index += 1) {
        if (window[index] === needle[index]) same += 1
      }
      if (same / needle.length >= 0.72) return weight * 0.7
    }
  }

  if (needle.length >= 4 && !CJK.test(needle)) {
    const target = bigrams(needle)
    for (let start = 0; start + needle.length <= normalizedChunk.length; start += 1) {
      const window = normalizedChunk.slice(start, start + needle.length)
      if (jaccard(target, bigrams(window)) >= 0.6) return weight * 0.7
    }
    const whole = jaccard(target, bigrams(normalizedChunk))
    if (whole >= 0.5) return weight * 0.6
  }

  return 0
}

/** Shortest and longest term we are willing to match speech against. */
const TERM_MIN = 2
const TERM_MAX = 6
/** Bonus for a term that also appears in the slide title. */
const TITLE_BONUS = 0.45
/** Bonus for a term that starts a run, which is usually a real word boundary. */
const BOUNDARY_BONUS = 0.15

/** Every scrap of text on one slide, joined for frequency counting. */
function slideBlob(slide) {
  const parts = [str(slide?.title)]
  for (const text of Array.isArray(slide?.texts) ? slide.texts : []) parts.push(str(text))
  for (const table of Array.isArray(slide?.tables) ? slide.tables : []) {
    for (const row of Array.isArray(table) ? table : []) {
      for (const cell of Array.isArray(row) ? row : []) parts.push(str(cell))
    }
  }
  return parts.filter((part) => part !== '').join(' ')
}

/** All text pieces of one slide, title first. */
function slidePieces(slide) {
  const pieces = []
  const title = str(slide?.title)
  if (title !== '') pieces.push(title)
  for (const text of Array.isArray(slide?.texts) ? slide.texts : []) {
    const value = str(text)
    if (value !== '') pieces.push(value)
  }
  for (const table of Array.isArray(slide?.tables) ? slide.tables : []) {
    for (const row of Array.isArray(table) ? table : []) {
      for (const cell of Array.isArray(row) ? row : []) {
        const value = str(cell)
        if (value !== '') pieces.push(value)
      }
    }
  }
  return pieces
}

/** Trim punctuation a slide deck likes to wrap around text runs. */
function cleanCandidate(raw) {
  return str(raw).replace(/^[\s·•\-–—*]+|[\s·•\-–—*:：,，。.;；、]+$/gu, '')
}

/**
 * Single characters that glue words together. A term window may not open or end
 * on one of these, otherwise "什么是机器" passes for a term.
 */
const STOP_CHARS = new Set(
  [...'的是了和与或及在用由从让使把被对为以而且但就这那我你他她它们个些将来给并即其之则把于说做'],
)

/** ICU word segmenter, when the runtime ships one (Node 20+ does). */
const SEGMENTER = (() => {
  try {
    return new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  } catch {
    return null
  }
})()

/**
 * Word boundaries inside one run, so term windows never slice a word in half.
 * Without a segmenter we fall back to "every character is a boundary", which
 * still works but yields noisier terms.
 *
 * @param {string} run - one CJK run.
 * @returns {{start: number, end: number, text: string}[]}
 */
function wordSpans(run) {
  if (SEGMENTER === null) {
    const spans = []
    for (let index = 0; index < run.length; index += 1) {
      spans.push({ start: index, end: index + 1, text: run[index] })
    }
    return spans
  }
  const spans = []
  for (const part of SEGMENTER.segment(run)) {
    if (part.isWordLike !== true) continue
    spans.push({ start: part.index, end: part.index + part.segment.length, text: part.segment })
  }
  return spans
}

/** Split one run at glue characters, keeping each piece's offset in the run. */
function splitAtGlue(run) {
  const parts = []
  let start = 0
  for (let index = 0; index < run.length; index += 1) {
    if (!STOP_CHARS.has(run[index])) continue
    if (index > start) parts.push({ text: run.slice(start, index), offset: start })
    start = index + 1
  }
  if (start < run.length) parts.push({ text: run.slice(start), offset: start })
  return parts
}

/**
 * Term candidates of one slide, before deck-wide frequency is known.
 *
 * A twelve-character sentence is not something a lecturer repeats verbatim, but
 * "自动总结" inside it very much is, so long runs are split at glue characters
 * and then into word-aligned windows of two to six characters.
 *
 * @returns {Map<string, {keyword: string, base: number, title: boolean}>}
 */
function slideTermCandidates(slide) {
  const title = str(slide?.title)
  const seen = new Map()
  const add = (raw, bonus = 0, fromTitle = false) => {
    const candidate = cleanCandidate(raw)
    if (candidate.length < TERM_MIN || candidate.length > TERM_MAX) return
    if (!CJK.test(candidate) && !/[A-Za-z]{2,}/.test(candidate)) return
    if (isStopOnly(candidate)) return
    const key = candidate.toLowerCase()
    const base = Math.round((keywordWeight(candidate) + bonus) * 100) / 100
    const previous = seen.get(key)
    if (previous === undefined || previous.base < base) {
      seen.set(key, { keyword: candidate, base, title: fromTitle || previous?.title === true })
    }
  }

  const harvest = (piece, fromTitle) => {
    const titleBonus = fromTitle ? TITLE_BONUS : 0
    for (const run of piece.match(CJK_RUN) ?? []) {
      for (const part of splitAtGlue(run)) {
        const spans = wordSpans(part.text)
        for (let first = 0; first < spans.length; first += 1) {
          if (isStopOnly(spans[first].text)) continue
          for (let last = first; last < spans.length; last += 1) {
            const start = spans[first].start
            const end = spans[last].end
            const length = end - start
            if (length > TERM_MAX) break
            add(
              part.text.slice(start, end),
              titleBonus + (start === 0 ? BOUNDARY_BONUS : 0),
              fromTitle,
            )
          }
        }
      }
    }
    for (const run of piece.match(LATIN_RUN) ?? []) add(run, fromTitle ? 0.35 : 0, fromTitle)
    for (const run of piece.match(NUMERIC_RUN) ?? []) {
      const digits = run.trim()
      if (digits.length >= 2) add(digits, 0.2, fromTitle)
    }
  }

  if (title !== '') harvest(title, true)
  for (const piece of slidePieces(slide)) harvest(piece, piece === title)
  return seen
}

/** How much a term being rare across the deck is worth. */
function frequencyBonus(df) {
  if (df <= 1) return 0.55
  if (df === 2) return 0.3
  if (df === 3) return 0.05
  return -0.5
}

/** Count how often one normalized needle occurs inside a haystack. */
function countOccurrences(haystack, needle) {
  if (needle === '' || haystack === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

/**
 * Rank one deck's terms using cross-slide frequency.
 *
 * A term on a single slide identifies that slide; a term on every slide
 * identifies nothing. Substring-overlapping picks collapse to the highest ranked
 * one so the panel shows "机器学习" instead of also "机器" and "学习".
 *
 * @param {object[]} rawSlides - the Python extractor's `slides` array.
 * @returns {Map<number, string[]>} slide index → keywords, best first.
 */
export function heuristicKeywordsForDeck(rawSlides, limit = MAX_KEYWORDS_PER_SLIDE) {
  const slides = (Array.isArray(rawSlides) ? rawSlides : []).filter((slide) => slide !== null && typeof slide === 'object')
  const blobs = slides.map((slide) => normalizeForMatch(slideBlob(slide)))
  const perSlide = slides.map((slide) => slideTermCandidates(slide))
  const df = new Map()
  perSlide.forEach((terms) => {
    for (const key of terms.keys()) df.set(key, (df.get(key) ?? 0) + 1)
  })

  const result = new Map()
  perSlide.forEach((terms, position) => {
    const blob = blobs[position]
    const ranked = [...terms.values()]
      .map((item) => {
        const needle = normalizeForMatch(item.keyword)
        const repeat = countOccurrences(blob, needle)
        const score =
          item.base + frequencyBonus(df.get(item.keyword.toLowerCase()) ?? 1) + (repeat >= 2 ? 0.15 : 0)
        return { keyword: item.keyword, needle, score: Math.round(score * 100) / 100 }
      })
      .filter((item) => item.needle.length >= TERM_MIN)
      .sort((a, b) => b.score - a.score || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword))

    const kept = []
    for (const item of ranked) {
      if (kept.length >= limit) break
      const redundant = kept.some(
        (other) => other.needle.includes(item.needle) || item.needle.includes(other.needle),
      )
      if (redundant) continue
      kept.push(item)
    }
    result.set(Number.isFinite(slides[position]?.index) ? slides[position].index : position + 1, kept.map((item) => item.keyword))
  })
  return result
}

/**
 * Candidates for one slide with no cross-slide context.
 * @param {object} slide - `{ title, texts, tables }` (see the Python extractor).
 * @returns {{keyword: string, weight: number}[]} candidates, best first.
 */
export function heuristicCandidates(slide) {
  const terms = slideTermCandidates(slide)
  const blob = normalizeForMatch(slideBlob(slide))
  return [...terms.values()]
    .map((item) => {
      const needle = normalizeForMatch(item.keyword)
      const repeat = countOccurrences(blob, needle)
      return {
        keyword: item.keyword,
        weight: Math.round((item.base + (repeat >= 2 ? 0.15 : 0)) * 100) / 100,
      }
    })
    .sort((a, b) => b.weight - a.weight || a.keyword.length - b.keyword.length)
}

/** Keep the best `limit` candidates of a single slide. */
export function heuristicKeywords(slide, limit = MAX_KEYWORDS_PER_SLIDE) {
  const terms = slideTermCandidates(slide)
  const blob = normalizeForMatch(slideBlob(slide))
  const ranked = [...terms.values()]
    .map((item) => {
      const needle = normalizeForMatch(item.keyword)
      const repeat = countOccurrences(blob, needle)
      return { keyword: item.keyword, needle, score: item.base + (repeat >= 2 ? 0.15 : 0) }
    })
    .sort((a, b) => b.score - a.score || a.keyword.length - b.keyword.length)
  const kept = []
  for (const item of ranked) {
    if (kept.length >= limit) break
    if (kept.some((other) => other.needle.includes(item.needle) || item.needle.includes(other.needle))) continue
    kept.push(item)
  }
  return kept.map((item) => item.keyword)
}

/**
 * Extract keywords for a whole deck.
 *
 * @param {object} options
 *   - `slides`: the Python extractor's `slides` array.
 *   - `llm`: the host `llm` service (optional).
 *   - `route`: `{ provider, model }` of the default route (optional).
 *   - `signal`: AbortSignal (optional).
 *   - `logger`: cordis logger (optional).
 *   - `onBatch`: called after each batch with `{ from, to, slides }`.
 * @returns {Promise<{slides: object[], source: string, model: string, error: string}>}
 */
export async function extractDeckKeywords(options) {
  const slides = Array.isArray(options.slides) ? options.slides : []
  const byIndex = heuristicKeywordsForDeck(slides)
  const heuristic = slides.map((slide, position) => ({
    index: slide.index,
    title: str(slide.title),
    keywords: byIndex.get(slide.index) ?? heuristicKeywords(slide),
  }))

  const llm = options.llm ?? null
  const route = options.route ?? null
  if (llm === null || route === null || typeof llm.prepareCall !== 'function' || slides.length === 0) {
    return {
      slides: heuristic.map((entry) => ({ ...entry, keywordSource: 'heuristic' })),
      source: 'heuristic',
      model: '',
      error: '',
    }
  }

  const result = heuristic.map((entry) => ({ ...entry, keywordSource: 'heuristic' }))
  const errors = []
  let refined = 0

  for (let start = 0; start < slides.length; start += KEYWORD_BATCH_SIZE) {
    const batch = slides.slice(start, start + KEYWORD_BATCH_SIZE)
    try {
      const picked = await askModelForBatch({
        batch,
        candidates: result.slice(start, start + KEYWORD_BATCH_SIZE),
        llm,
        route,
        signal: options.signal,
      })
      for (const entry of picked) {
        const target = result.find((item) => item.index === entry.index)
        if (target === undefined || entry.keywords.length === 0) continue
        const merged = strList([...entry.keywords, ...target.keywords], MAX_KEYWORDS_PER_SLIDE * 2)
        target.keywords = merged.slice(0, MAX_KEYWORDS_PER_SLIDE)
        target.keywordSource = 'llm'
        refined += 1
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      errors.push(String(error?.message ?? error))
    }
    options.onBatch?.({
      from: batch[0]?.index ?? 0,
      to: batch[batch.length - 1]?.index ?? 0,
      slides: result.slice(start, start + batch.length),
    })
  }

  return {
    slides: result,
    source: refined > 0 ? 'llm' : 'heuristic',
    model: `${route.provider}/${route.model}`,
    error: errors.length === 0 ? '' : errors[0],
  }
}

/** System instruction for the keyword pass. */
export const KEYWORD_SYSTEM_PROMPT = [
  '你是一位中文课堂助理。你会读到一份 PPT 中若干页的标题和正文文本。',
  '你的任务：为每一页挑出这节课讲到这一页时老师一定会说出口的"识别词"，用来判断录音讲到哪一页了。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，形状：{"slides":[{"index":1,"keywords":["词1","词2"]}]}，不要代码围栏、不要解释。',
  '2. 每页 4-8 个词，必须是这一页独有的、能指认这一页的主题词、术语、人名、算法名、缩写或关键数字。',
  '3. 不要选"定义""概念""内容""方法""总结""练习"这类每页都可能出现的泛词，也不要选"我们""可以"这类虚词。',
  '4. 不要编造原文没有出现的词；英文缩写保持原文写法（如 CNN、MSE、ReLU）。',
  '5. 按输入顺序输出，index 必须与输入的页码一致。',
].join('\n')

/** Build the user message for one batch. */
export function buildKeywordPrompt(batch, candidates = []) {
  const lines = []
  for (const slide of batch) {
    const index = slide.index
    const body = (Array.isArray(slide.texts) ? slide.texts : []).join(' / ')
    const hint = candidates.find((item) => item.index === index)?.keywords ?? []
    lines.push(`第 ${index} 页`)
    lines.push(`标题：${str(slide.title) === '' ? '（无）' : str(slide.title)}`)
    lines.push(`正文：${body === '' ? '（无文字，可能是图片）' : body.slice(0, 1600)}`)
    if (hint.length > 0) lines.push(`候选词（可采纳、可替换）：${hint.join('、')}`)
    lines.push('')
  }
  lines.push('请为上面每一页输出识别词，只输出 JSON。')
  return lines.join('\n')
}

/** Parse the model's keyword JSON, tolerating fences and stray prose. */
export function parseKeywordJson(text) {
  const value = typeof text === 'string' ? text : ''
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced === null ? value : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.slides) ? parsed.slides : []
  const out = []
  for (const item of list) {
    const index = Number(item?.index)
    if (!Number.isFinite(index)) continue
    out.push({ index, keywords: strList(item?.keywords, MAX_KEYWORDS_PER_SLIDE) })
  }
  return out
}

/** One model request for one batch, returning normalized picks. */
async function askModelForBatch({ batch, candidates, llm, route, signal }) {
  const text = await askModel({
    llm,
    route,
    system: KEYWORD_SYSTEM_PROMPT,
    prompt: buildKeywordPrompt(batch, candidates),
    signal,
    timeoutMessage: '识别关键词超时',
    failurePrefix: '识别关键词失败：',
  })
  return parseKeywordJson(text)
}

/**
 * One streaming model request.
 *
 * Every pass in this module (keywords, Chinese glosses) is the same shape: a
 * system prompt, one user message, plain text back. Keeping it in one place
 * means the timeout, the `maxTokens` fallback and the abort plumbing are not
 * copied three times.
 *
 * @returns {Promise<string>} the concatenated text output.
 */
export async function askModel({ llm, route, system, prompt, signal, timeoutMessage, failurePrefix, maxTokens = MAX_TOKENS }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), CALL_TIMEOUT_MS)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    let call
    try {
      call = await llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens },
        controller.signal,
      )
    } catch (error) {
      if (!/max.?tokens|output/i.test(String(error?.message ?? error))) throw error
      call = await llm.prepareCall({ provider: route.provider, model: route.model }, controller.signal)
    }
    const stream = call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    })
    let text = ''
    let finish = null
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason ?? null
    }
    if (finish !== null && finish.kind === 'error') {
      throw new Error(`${failurePrefix}${finish.failure?.message ?? '模型返回错误'}`)
    }
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

// ───────────────────────────── Chinese glosses ────────────────────────────
//
// A Chinese lecture over an English deck never says "backpropagation", it says
// 反向传播. Matching the deck's English keywords against Chinese speech finds
// nothing, so every term also gets the wording the teacher actually speaks.

/**
 * English term → the Chinese wording a classroom usually uses.
 *
 * This is the no-model fallback: it needs no network and covers the vocabulary
 * of an intro CS / ML course. Anything missing simply has no gloss, and the
 * model pass fills the rest in.
 */
export const TERM_GLOSSARY = new Map(Object.entries({
  'machine learning': '机器学习',
  'supervised learning': '监督学习',
  'unsupervised learning': '无监督学习',
  'reinforcement learning': '强化学习',
  'training set': '训练集',
  'test set': '测试集',
  'validation set': '验证集',
  'training data': '训练数据',
  'loss function': '损失函数',
  'cost function': '代价函数',
  'activation function': '激活函数',
  'objective function': '目标函数',
  'hidden layer': '隐藏层',
  'output layer': '输出层',
  'input layer': '输入层',
  'neural network': '神经网络',
  'neural networks': '神经网络',
  'deep learning': '深度学习',
  'convolutional neural network': '卷积神经网络',
  'recurrent neural network': '循环神经网络',
  'multilayer perceptron': '多层感知机',
  'perceptron': '感知机',
  'backpropagation': '反向传播',
  'back propagation': '反向传播',
  'gradient descent': '梯度下降',
  'stochastic gradient descent': '随机梯度下降',
  'learning rate': '学习率',
  'chain rule': '链式法则',
  'partial derivative': '偏导数',
  'derivative': '导数',
  'gradient': '梯度',
  'linear regression': '线性回归',
  'logistic regression': '逻辑回归',
  'least squares': '最小二乘',
  'mean squared error': '均方误差',
  'overfitting': '过拟合',
  'underfitting': '欠拟合',
  'regularization': '正则化',
  'dropout': '随机失活',
  'cross validation': '交叉验证',
  'confusion matrix': '混淆矩阵',
  'precision': '精确率',
  'recall': '召回率',
  'decision tree': '决策树',
  'random forest': '随机森林',
  'support vector machine': '支持向量机',
  'naive bayes': '朴素贝叶斯',
  'clustering': '聚类',
  'dimensionality reduction': '降维',
  'principal component analysis': '主成分分析',
  'attention': '注意力',
  'transformer': '变换器',
  'embedding': '嵌入',
  'fine tuning': '微调',
  'reinforcement': '强化',
  'reward': '奖励',
  'policy': '策略',
  'matrix': '矩阵',
  'vector': '向量',
  'tensor': '张量',
  'eigenvalue': '特征值',
  'eigenvector': '特征向量',
  'probability': '概率',
  'variance': '方差',
  'expectation': '期望',
  'distribution': '分布',
  'hypothesis': '假设',
  'feature': '特征',
  'features': '特征',
  'label': '标签',
  'sample': '样本',
  'dataset': '数据集',
  'binary search tree': '二叉搜索树',
  'binary search': '二分查找',
  'binary tree': '二叉树',
  'balanced tree': '平衡树',
  'red black tree': '红黑树',
  'hash table': '哈希表',
  'hash function': '哈希函数',
  'linked list': '链表',
  'priority queue': '优先队列',
  'queue': '队列',
  'stack': '栈',
  'heap': '堆',
  'graph': '图',
  'tree': '树',
  'node': '结点',
  'vertex': '顶点',
  'edge': '边',
  'adjacency list': '邻接表',
  'adjacency matrix': '邻接矩阵',
  'depth first search': '深度优先搜索',
  'breadth first search': '广度优先搜索',
  'shortest path': '最短路径',
  'spanning tree': '生成树',
  'minimum spanning tree': '最小生成树',
  'dynamic programming': '动态规划',
  'greedy algorithm': '贪心算法',
  'divide and conquer': '分治法',
  'backtracking': '回溯',
  'recursion': '递归',
  'iteration': '迭代',
  'time complexity': '时间复杂度',
  'space complexity': '空间复杂度',
  'amortized analysis': '摊还分析',
  'merge sort': '归并排序',
  'quick sort': '快速排序',
  'insertion sort': '插入排序',
  'heap sort': '堆排序',
  'bubble sort': '冒泡排序',
  'topological sort': '拓扑排序',
  'traversal': '遍历',
  'inorder traversal': '中序遍历',
  'preorder traversal': '前序遍历',
  'postorder traversal': '后序遍历',
  'dictionary': '字典',
  'array': '数组',
  'string': '字符串',
  'pointer': '指针',
  'index': '下标',
  'loop invariant': '循环不变式',
  'recurrence relation': '递推关系',
  'master theorem': '主定理',
  'satisfiability': '可满足性',
  'greedy choice': '贪心选择',
  'optimal substructure': '最优子结构',
  'memoization': '记忆化',
  'collision': '冲突',
  'load factor': '装填因子',
  'rotation': '旋转',
  'insertion': '插入',
  'deletion': '删除',
  'search': '查找',
  'sorting': '排序',
  'complexity': '复杂度',
  'invariant': '不变式',
}))

/** The Chinese wording of one term, when the glossary knows it. */
export function glossaryGloss(term) {
  const value = str(term)
  if (value === '') return ''
  const key = value.toLowerCase().replace(/[^a-z0-9+# ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (key === '') return ''
  const direct = TERM_GLOSSARY.get(key)
  if (direct !== undefined) return direct
  return ''
}

/**
 * The English wording of a Chinese keyword, for an English lecture over a
 * Chinese deck — the mirror of `glossaryGloss`. It is built from the same table,
 * so 「反向传播」 answers backpropagation.
 *
 * @param {string} keyword
 * @returns {string} '' when the term is not a known glossary translation.
 */
export function englishGlossFor(keyword) {
  const value = str(keyword)
  if (value === '') return ''
  // Latin words are already usable; only Han text gets a translation.
  if (!/[\u4e00-\u9fff]/.test(value)) return ''
  return TERM_ENGLISH_BY_ZH.get(value) ?? ''
}

/** Chinese → English from the glossary, built once, preferring the plainest key. */
const TERM_ENGLISH_BY_ZH = (() => {
  const map = new Map()
  for (const [english, chinese] of TERM_GLOSSARY) {
    const current = map.get(chinese)
    // 「神经网络」 answers "neural network", not "neural networks".
    if (current === undefined || english.length < current.length) map.set(chinese, english)
  }
  return map
})()
/** Which way the glosses run: `toZh` for a Chinese lecture, `toEn` for an English one. */
export const GLOSS_DIRECTIONS = ['toZh', 'toEn']

/**
 * Glossary-only glosses for a batch of slides.
 *
 * @param {{index: number, keywords?: string[]}[]} slides
 * @param {'toZh'|'toEn'} direction
 * @returns {Map<number, Record<string, string>>} slide index → `term → 译文`.
 */
export function glossaryGlossesForDeck(slides, direction = 'toZh') {
  const out = new Map()
  for (const slide of Array.isArray(slides) ? slides : []) {
    const glosses = {}
    for (const keyword of Array.isArray(slide?.keywords) ? slide.keywords : []) {
      const gloss = direction === 'toEn' ? englishGlossFor(keyword) : glossaryGloss(keyword)
      if (gloss !== '' && gloss !== keyword) glosses[keyword] = gloss
    }
    out.set(slide.index, glosses)
  }
  return out
}

/**
 * Glossary-only glosses for one direction, or both when the lecture is mixed.
 *
 * @param {{index: number, keywords?: string[]}[]} slides
 * @param {'toZh'|'toEn'|'both'} direction
 * @returns {Map<number, Record<string, string>>}
 */
export function glossaryGlossesForDirection(slides, direction = 'toZh') {
  if (direction !== 'both') return glossaryGlossesForDeck(slides, direction)
  const chinese = glossaryGlossesForDeck(slides, 'toZh')
  const english = glossaryGlossesForDeck(slides, 'toEn')
  const out = new Map()
  for (const index of new Set([...chinese.keys(), ...english.keys()])) {
    out.set(index, { ...(chinese.get(index) ?? {}), ...(english.get(index) ?? {}) })
  }
  return out
}

/**
 * Which keywords are actually worth translating, and which way.
 *
 * An English deck read by a Chinese lecture needs Chinese glosses for its Latin
 * terms. The mirror case is just as real: a Chinese deck read by an English
 * lecture needs English glosses for its Chinese terms — otherwise an English
 * class over 「反向传播」 never turns the page either.
 *
 * A mixed lecture (`auto`) keeps both directions open.
 *
 * @param {{index: number, keywords?: string[]}[]} slides
 * @param {'toZh'|'toEn'|'both'} direction
 * @returns {{index: number, title: string, keywords: string[], hint: string[]}[]}
 *   only the slides with at least one term to translate.
 */
export function translationWork(slides, direction) {
  const toZh = direction !== 'toEn'
  const toEn = direction !== 'toZh'
  const out = []
  for (const slide of Array.isArray(slides) ? slides : []) {
    const keywords = (Array.isArray(slide?.keywords) ? slide.keywords : []).map((word) => str(word)).filter((word) => word !== '')
    const hint = keywords.filter((word) => (toZh && /[A-Za-z]/.test(word)) || (toEn && /[\u4e00-\u9fff]/.test(word)))
    if (hint.length === 0) continue
    out.push({ index: slide.index, title: str(slide?.title), keywords, hint })
  }
  return out
}

/** System instruction for the Chinese-lecture pass. */
export const GLOSS_SYSTEM_PROMPT = [
  '你是一位中国大学的助教。你拿到的是一份英文 PPT 每页的关键词列表。',
  '这堂课的老师用中文讲，讲到这些词时会说中文的说法。你的任务：给每个英文术语配一个中文课堂里真的会说出口的说法。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象：{"slides":[{"index":1,"titleZh":"标题的中文","glosses":{"backpropagation":"反向传播"}}]}，不要代码围栏、不要解释。',
  '2. glosses 的键必须原样照抄输入的英文术语（大小写、缩写都不改），值是该术语的中文说法。',
  '3. 中文说法要短、要像老师嘴里说出来的：反向传播、梯度下降、均方误差、多层感知机。不要写成解释句。',
  '4. 本来就是人名的（如 Arthur Samuel）、数学符号、纯数字，不用配中文，直接省略。',
  '5. 已经是中文的词不用输出。宁可少给，也不要编造原文里没有的概念。',
  '6. titleZh 是这一页标题的中文说法，没标题就省略这个字段。',
].join('\n')

/** System instruction for the English-lecture pass (the mirror direction). */
export const GLOSS_EN_SYSTEM_PROMPT = [
  'You are a teaching assistant at an English-speaking university. You get the keywords of one slide of a Chinese deck.',
  'The lecture is given in English, so the slide text is spoken out loud in English. Give every Chinese keyword the English term the teacher would say.',
  '',
  'Rules:',
  '1. Output only one JSON object: {"slides":[{"index":1,"titleEn":"English title","glosses":{"反向传播":"backpropagation"}}]}. No code fences, no prose.',
  '2. Keys must copy the input term exactly; values are the short English term, never an explanation.',
  '3. Chinese personal names, symbols and numbers need no gloss — just leave them out.',
  '4. Leave out terms that are already English. Prefer omitting over inventing a concept the slide never had.',
  '5. titleEn is the English wording of the slide title; omit it when there is no title.',
].join('\n')

/** Build the user message for one gloss batch. */
export function buildGlossPrompt(batch, direction = 'toZh') {
  const toZh = direction !== 'toEn'
  const toEn = direction !== 'toZh'
  const lines = []
  for (const slide of batch) {
    const keywords = Array.isArray(slide.keywords) ? slide.keywords : []
    lines.push(`第 ${slide.index} 页`)
    lines.push(`标题：${str(slide.title) === '' ? '（无）' : str(slide.title)}`)
    if (toZh && toEn) lines.push(`关键词：${keywords.length === 0 ? '（无）' : keywords.join('、')}`)
    else if (toZh) lines.push(`需要中文说法的词：${keywords.length === 0 ? '（无）' : keywords.join('、')}`)
    else lines.push(`Terms needing an English gloss: ${keywords.length === 0 ? '(none)' : keywords.join(', ')}`)
    lines.push('')
  }
  lines.push(toEn && !toZh ? 'Give the English wording for every term above. Output JSON only.' : '请为上面每一页输出中文说法，只输出 JSON。')
  return lines.join('\n')
}

/** Parse the model's gloss JSON, tolerating fences and stray prose. */
export function parseGlossJson(text) {
  const value = typeof text === 'string' ? text : ''
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced === null ? value : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.slides) ? parsed.slides : []
  const out = []
  for (const item of list) {
    const index = Number(item?.index)
    if (!Number.isFinite(index)) continue
    const glosses = {}
    const raw = item?.glosses
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [term, zh] of Object.entries(raw)) {
        const key = str(term)
        const value = str(zh)
        if (key === '' || value === '' || key === value) continue
        glosses[key] = value.slice(0, 80)
      }
    }
    out.push({ index, titleZh: str(item?.titleZh), titleEn: str(item?.titleEn), glosses })
  }
  return out
}

/**
 * Whether a batch still needs a translation pass: true when any keyword is
 * written in Latin letters (an all-Chinese deck already says out loud what it
 * shows) … unless the lecture itself is in English, where the Chinese terms
 * need the English wording instead.
 *
 * @param {{keywords?: string[]}[]} slides
 * @param {'toZh'|'toEn'|'both'} direction
 * @returns {boolean}
 */
export function needGloss(slides, direction = 'toZh') {
  const pattern = direction === 'toEn' ? /[\u4e00-\u9fff]/ : direction === 'both' ? /./ : /[A-Za-z]/
  for (const slide of Array.isArray(slides) ? slides : []) {
    for (const keyword of Array.isArray(slide?.keywords) ? slide.keywords : []) {
      if (pattern.test(str(keyword))) return true
    }
  }
  return false
}

/**
 * Give every slide's keywords a wording in the language the lecture is spoken in.
 *
 * `direction: 'toZh'` (default) covers the common case — an English deck read by
 * a Chinese lecture — and `'toEn'` is its mirror, a Chinese deck read in English.
 * Without a model this is the built-in glossary alone (instant, offline, covers
 * the usual CS/ML vocabulary); with a model each batch is translated so even
 * course-specific terms come back as what the teacher actually says.
 *
 * @param {object} options
 *   - `slides`: `{index, title, keywords}[]`.
 *   - `direction`: `'toZh' | 'toEn'`.
 *   - `llm`, `route`, `signal`, `onBatch`.
 * @returns {Promise<{slides: {index: number, titleZh: string, titleEn: string, glosses: object}[],
 *   direction: string, source: 'llm'|'glossary', model: string, error: string}>}
 */
export async function glossDeckKeywords(options) {
  // 'both' is what a 中英混合 lecture asks for: the teacher may say either
  // spelling, so the deck keeps Chinese glosses for its English terms and
  // English glosses for its Chinese ones.
  const allowed = [...GLOSS_DIRECTIONS, 'both']
  const direction = allowed.includes(options.direction) ? options.direction : 'toZh'
  const translateTo = direction
  const slides = (Array.isArray(options.slides) ? options.slides : [])
    .filter((slide) => slide !== null && typeof slide === 'object')
  const fallback = glossaryGlossesForDirection(slides, translateTo)
  const result = slides.map((slide) => ({
    index: slide.index,
    titleZh: '',
    titleEn: '',
    glosses: { ...(fallback.get(slide.index) ?? {}) },
  }))

  const llm = options.llm ?? null
  const route = options.route ?? null
  const work = translationWork(slides, translateTo)
  if (llm === null || route === null || typeof llm.prepareCall !== 'function' || work.length === 0) {
    return {
      slides: result,
      direction,
      source: 'glossary',
      model: '',
      error: work.length > 0 ? '没有可用的模型，只用了内置词表' : '',
    }
  }

  const errors = []
  let translated = 0
  let asked = 0
  const passes = translateTo === 'both' ? ['toZh', 'toEn'] : [translateTo]
  for (let start = 0; start < work.length; start += KEYWORD_BATCH_SIZE) {
    const batch = work.slice(start, start + KEYWORD_BATCH_SIZE)
    asked += 1
    try {
      // A mixed lecture needs both directions: one batch per direction, so the
      // model is never asked to answer "translate everything both ways".
      for (const pass of passes) {
        const text = await askModel({
          llm,
          route,
          system: pass === 'toEn' ? GLOSS_EN_SYSTEM_PROMPT : GLOSS_SYSTEM_PROMPT,
          prompt: buildGlossPrompt(
            batch.map((slide) => ({
              index: slide.index,
              title: slide.title,
              keywords: pass === 'toEn'
                ? slide.hint.filter((word) => /[\u4e00-\u9fff]/.test(word))
                : slide.hint.filter((word) => /[A-Za-z]/.test(word)),
            })),
            pass,
          ),
          signal: options.signal,
          timeoutMessage: '翻译关键词超时',
          failurePrefix: '翻译关键词失败：',
        })
        for (const entry of parseGlossJson(text)) {
          const target = result.find((item) => item.index === entry.index)
          if (target === undefined) continue
          if (entry.titleZh !== '') target.titleZh = entry.titleZh
          if (entry.titleEn !== '') target.titleEn = entry.titleEn
          Object.assign(target.glosses, entry.glosses)
          translated += 1
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      errors.push(String(error?.message ?? error))
    }
    options.onBatch?.({
      from: batch[0]?.index ?? 0,
      to: batch[batch.length - 1]?.index ?? 0,
    })
  }

  return {
    slides: result,
    direction,
    source: translated > 0 ? 'llm' : 'glossary',
    model: asked > 0 ? `${route.provider}/${route.model}` : '',
    error: errors.length === 0 ? '' : errors[0],
  }
}
