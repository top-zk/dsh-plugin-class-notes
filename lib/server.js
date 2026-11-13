/**
 * Loopback JSON API for the class-notes panel.
 *
 * The panel is a hand-written client bundle, so it cannot use the generated
 * remote channel: the host half claims one prefix on `ctx.webServer` and the
 * bundle talks to it with plain `fetch`. Everything is loopback-only and JSON,
 * with two binary exceptions — the uploaded `.pptx` and the 16kHz WAV chunks.
 *
 * Route map (all under `ROUTE_PREFIX`):
 *
 *   GET    /health                     liveness + where the data lives
 *   GET    /state                      speech status, default model, session list
 *   POST   /sessions                   create an empty session
 *   GET    /sessions/:id               one session (with rendered notes)
 *   PATCH  /sessions/:id               rename / change date / jump slide
 *   DELETE /sessions/:id               delete session directory
 *   POST   /sessions/:id/deck          upload one .pptx or .pdf, parse it
 *   POST   /sessions/:id/keywords      (re)run keyword extraction + glosses
 *   POST   /sessions/:id/gloss         (re)run the Chinese gloss pass only
 *   POST   /sessions/:id/summary       (re)write the AI recap of the class
 *   POST   /sessions/:id/slides/:n     edit one slide's keywords or manual note
 *   POST   /sessions/:id/chunk         one WAV chunk: transcribe + attach
 *   POST   /sessions/:id/backfill      transcribe one WAV chunk, attach silently
 *   POST   /sessions/:id/recording     start / stop
 *   POST   /sessions/:id/export        write annotated .pptx + markdown
 *   GET    /sessions/:id/file          download one exported artifact
 *
 * @module dsh-plugin-class-notes/server
 */

import { createReadStream } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { copyDeckFile, importDeck, isPdfPath, saveDeckBytes, writeDeckNotes } from './deck.js'
import { extractDeckKeywords, glossDeckKeywords } from './keywords.js'
import { pdfRasterizerAvailable } from './pdf.js'
import {
  ASR_MODE_INFO,
  ASR_MODES,
  SESSION_STATUS,
  asrLanguage,
  formatMoment,
  lastIndex,
  localDay,
  normalizeAsrMode,
  normalizeSlide,
  projectSession,
  sessionProgress,
  slideAt,
  slideNote,
  str,
  strList,
  viewSession,
} from './model.js'
import { workspaceDir } from './runtime.js'
import { summarizeSession } from './summary.js'
import { evaluateChunk, trackerAfterManualJump } from './tracker.js'

/** Prefix claimed on the web server; the bundle builds URLs from the same value. */
export const ROUTE_PREFIX = '/dsh-class-notes'

/** Largest deck we accept. */
const MAX_DECK_BYTES = 96 * 1024 * 1024
/** Largest single audio chunk we accept (~2 minutes of 16kHz mono PCM16). */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
/** Largest JSON body we accept. */
const MAX_JSON_BYTES = 4 * 1024 * 1024

/** JSON reply. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a JSON object body. */
async function readJsonBody(req, limit = MAX_JSON_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw badRequest('请求内容过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw badRequest(`请求体不是合法 JSON：${String(error?.message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体必须是一个 JSON 对象')
  }
  return parsed
}

/** Read a raw binary body. */
async function readRawBody(req, limit, label) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw badRequest(`${label}过大（超过 ${Math.round(limit / 1024 / 1024)}MB）`)
    }
    chunks.push(chunk)
  }
  if (size === 0) throw badRequest(`没有收到${label}内容`)
  return Buffer.concat(chunks)
}

/** Error carrying an HTTP status. */
function badRequest(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Only the loopback interface may call in. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Turn an error into a status + message pair. */
function describeError(error) {
  return {
    status: typeof error?.status === 'number' ? error.status : 400,
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Load one session or throw a 404-shaped error. */
async function requireSession(store, id) {
  const session = await store.read(id)
  if (session === null) throw badRequest(`未找到听课记录：${id}`, 404)
  return session
}

/**
 * Give every slide's keywords a Chinese wording and store it on the session.
 *
 * This is what makes a Chinese lecture over an English deck match at all: the
 * tracker scores both spellings of a term, so `backpropagation` on the slide
 * still fires when the teacher says 反向传播.
 */
async function glossSession(deps, id, options = {}) {
  const { store, logger } = deps
  const session = await requireSession(store, id)
  if (session.slides.length === 0) throw badRequest('先上传课件再补中文说法')
  // The gloss has to run in whichever direction the lecture is spoken: a Chinese
  // lecture over an English deck needs 中文 for English terms, and an English
  // lecture over a Chinese deck needs the reverse.
  const direction = glossDirection(session.asrMode)
  const route = options.route ?? deps.modelRoute?.() ?? { llm: null }
  let payload
  try {
    payload = await glossDeckKeywords({
      slides: session.slides.map((slide) => ({
        index: slide.index,
        title: slide.title,
        keywords: slide.keywords,
      })),
      direction,
      llm: deps.llm,
      route: route.llm,
      logger,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw badRequest(`补中文说法失败：${String(error?.message ?? error)}`, 500)
  }
  return store.update(id, (draft) => {
    const byIndex = new Map(payload.slides.map((entry) => [entry.index, entry]))
    for (const slide of draft.slides) {
      const entry = byIndex.get(slide.index)
      if (entry === undefined) continue
      const glosses = {}
      // Only keep glosses for keywords the slide still has, so deleting a
      // keyword does not leave a stray translation behind.
      for (const keyword of slide.keywords) {
        const gloss = entry.glosses[keyword]
        if (typeof gloss === 'string' && gloss !== '') glosses[keyword] = gloss
      }
      slide.keywordGlosses = glosses
      slide.keywordsZh = Object.values(glosses)
      if (entry.titleZh !== '') slide.titleZh = entry.titleZh
      if (entry.titleEn !== '') slide.titleEn = entry.titleEn
    }
    draft.meta.glossAt = new Date().toISOString()
    draft.meta.glossDirection = direction
    draft.meta.glossModel = payload.model === '' ? draft.meta.glossModel : payload.model
    draft.meta.glossError = payload.error
    return draft
  })
}

/**
 * Pause every other lesson that still has the microphone open.
 *
 * One class records at a time: the mic is a single resource, and a lesson left
 * live while another one starts would keep a clock running and could collect a
 * stray chunk. The paused lessons are returned so the panel can say which one
 * it just stopped — a silent pause in the middle of a class would be worse than
 * the leak this prevents.
 */
async function pauseOtherRecordings(store, keepId) {
  const others = await store.list()
  const paused = []
  for (const item of others) {
    if (item.id === keepId) continue
    if (item.recording?.active !== true) continue
    try {
      const updated = await store.update(item.id, (session) => {
        session.recording.active = false
        if (session.recording.stoppedAt === null) session.recording.stoppedAt = new Date().toISOString()
        if (session.status === SESSION_STATUS.recording) session.status = SESSION_STATUS.ready
        return session
      })
      paused.push({ id: item.id, title: str(updated.title, '另一节课') })
    } catch {
      // Deleted mid-flight; nothing to pause.
    }
  }
  return paused
}

/**
 * Background gloss pass, fired when recording starts.
 *
 * Skipped once a session already holds glosses, so pressing play twice does not
 * spend two model calls. Errors land in `meta.glossError` for the panel.
 *
 * Re-glossing needs evidence that a gloss pass really ran: a stored error, or
 * the session is already recording (someone finished the pass before). Without
 * that, a deck whose keywords hold no Latin term — which is what a model gives
 * for an English deck — would be retried at every recording start, forever.
 *
 * The direction depends on the transcription mode, so switching from 中文 to
 * English (or to 中英混合) re-glosses a session whose glosses were made for the
 * other direction. The stored direction lives in `meta.glossDirection`.
 */
async function ensureGlosses(deps, id, current) {
  const { store, logger } = deps
  const wanted = glossDirection(current.asrMode)
  const stale = current.meta.glossDirection !== wanted && current.meta.glossDirection !== 'both'
  const proven = current.meta.glossError !== '' || current.status === SESSION_STATUS.recording
  const needs = current.slides.length > 0
    && (current.meta.glossAt === null ? proven : stale)
  if (!needs || deps.llm === null) return null
  try {
    const updated = await glossSession(deps, id)
    logger?.info?.('class-notes: glosses ready for %s', id)
    return updated
  } catch (error) {
    logger?.warn?.('class-notes: gloss pass failed for %s: %s', id, String(error?.message ?? error))
    try {
      await store.update(id, (draft) => {
        draft.meta.glossAt = new Date().toISOString()
        draft.meta.glossError = String(error?.message ?? error)
        return draft
      })
    } catch {
      // The session may have been deleted mid-flight; nothing left to record.
    }
    return null
  }
}

/**
 * Adopt a freshly imported deck into a session: slides, heuristic keywords, and
 * a reset of the page tracker so recording starts from page 1 again.
 *
 * `parsed.raw` is what Python saw in the .pptx; for a PDF-imported deck that is
 * empty (the slides are pictures), so the text merged onto the slides is used
 * instead — that is the text keywords must come from.
 */
async function applyImportedDeck(store, id, job) {
  const { parsed } = job
  const before = await requireSession(store, id)
  const slidesForKeywords = parsed.slides.map((slide) => ({
    index: slide.index,
    title: slide.title,
    texts: [slide.title, slide.body].filter((item) => item !== ''),
  }))
  const heuristic = await extractDeckKeywords({ slides: slidesForKeywords })
  // Glossary-only at import time (no model call on the upload path): it costs
  // nothing and already covers the common CS/ML terms. The model pass runs when
  // recording starts, when `asrMode` says which direction to translate.
  const direction = glossDirection(before.asrMode)
  const glossed = await glossDeckKeywords({ slides: heuristic.slides, direction })
  const glossByIndex = new Map(glossed.slides.map((entry) => [entry.index, entry]))
  return store.update(id, (draft) => {
    draft.meta.fileName = job.fileName
    draft.meta.sourcePath = job.sourcePath
    draft.meta.slideWidth = parsed.slideWidth
    draft.meta.slideHeight = parsed.slideHeight
    draft.meta.keywordsAt = null
    draft.meta.keywordsError = ''
    // The glossary-only pass is not the real gloss pass: leaving `glossAt` null
    // means the model pass still runs once recording starts.
    draft.meta.glossAt = null
    draft.meta.glossDirection = ''
    draft.meta.glossError = ''
    draft.meta.importKind = job.pdf === null ? 'pptx' : 'pdf'
    draft.meta.pdfPages = job.pdf === null ? 0 : job.pdf.slideCount
    draft.meta.pdfRenderedPages = job.pdf === null ? 0 : job.pdf.renderedPages
    draft.meta.pdfWarning = job.pdf === null ? '' : job.pdf.warning
    const byIndex = new Map(heuristic.slides.map((entry) => [entry.index, entry]))
    draft.slides = parsed.slides.map((slide) => {
      const entry = byIndex.get(slide.index)
      const gloss = glossByIndex.get(slide.index)
      return normalizeSlide(
        {
          ...slide,
          keywords: entry?.keywords ?? [],
          keywordsZh: Object.values(gloss?.glosses ?? {}),
          keywordGlosses: gloss?.glosses ?? {},
          titleZh: gloss?.titleZh ?? '',
          titleEn: gloss?.titleEn ?? '',
          keywordSource: 'heuristic',
        },
        slide.index,
      )
    })
    draft.recording.currentIndex = draft.slides.length === 0 ? 0 : 1
    draft.tracker = trackerAfterManualJump(draft.tracker)
    draft.status = 'ready'
    if (str(draft.title) === '' || draft.title === '未命名听课') {
      draft.title = str(parsed.slides[0]?.title, draft.title)
    }
    return draft
  })
}

/** Validate a 1-based slide number against the deck. */
function requireSlide(session, index) {
  const slide = slideAt(session, index)
  if (slide === null) throw badRequest(`这份 PPT 没有第 ${index} 页`, 404)
  return slide
}

/**
 * Append one recognized chunk to the session and run the page-turn decision.
 *
 * Kept separate from the route so the backfill path (a deck uploaded after some
 * recording, or a retried chunk) can reuse exactly the same bookkeeping.
 */
export async function attachChunk(deps, id, text, chunkOptions = {}) {
  const { store, logger } = deps
  const audioSeconds = Number.isFinite(Number(chunkOptions.audioSeconds)) ? Number(chunkOptions.audioSeconds) : 0
  const manual = chunkOptions.manual === true

  return store.update(id, (session) => {
    const now = chunkOptions.now ?? Date.now()
    const decision = evaluateChunk({
      session,
      tracker: session.tracker,
      chunk: text,
      now,
      manual,
    })
    session.tracker = decision.tracker
    session.recording.chunks += 1
    session.recording.audioSeconds += audioSeconds

    if (decision.advance) {
      session.recording.advances += 1
    }
    session.recording.currentIndex = decision.index

    // `carry` holds any chunk that was parked while the page turn was still
    // unconfirmed, plus this one; they all belong to the page we just settled on.
    const target = slideAt(session, decision.index)
    if (target !== null) {
      let attached = 0
      for (const row of decision.carry) {
        const value = typeof row?.text === 'string' ? row.text.trim() : ''
        if (value === '') continue
        const stamp = formatMoment(new Date(row.at ?? now))
        target.segments.push({
          at: stamp,
          text: value,
          score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
          manual: false,
        })
        if (target.startedAt === null) target.startedAt = stamp
        target.endedAt = stamp
        attached += 1
      }
      if (attached > 0) {
        if (decision.decision.hereHits.length > 0 && !decision.holding) {
          target.hitCount += decision.decision.hereHits.length
        }
        session.transcript = slideNote(target)
      }
    }

    if (session.recording.active !== true && decision.text !== '') {
      session.status = 'recording'
    }
    logger?.info?.(
      `class-notes: chunk ${session.id} slide ${decision.index} score ${decision.decision.here}/${decision.decision.ahead} carry ${decision.carry.length} → ${decision.decision.reason}`,
    )
    return session
  })
}

/**
 * Build the `/state` payload.
 * @param deps - `{ store, asr, modelRoute, logger }`.
 */
export async function buildState(deps) {
  const sessions = await deps.store.list()
  return {
    ok: true,
    now: new Date().toISOString(),
    today: localDay(),
    clock: formatMoment(),
    dataDir: deps.store.root,
    workspace: workspaceDir(),
    speech: deps.asr.status(),
    asrModes: ASR_MODE_INFO,
    llm: deps.modelRoute(),
    pdf: { rasterizer: await pdfRasterizerAvailable() },
    sessions: sessions.map((session) => projectSession(session)),
  }
}

/**
 * Register every route on the web server.
 * @param ctx - Cordis context carrying `webServer`.
 * @param deps - `{ store, asr, modelRoute, logger }`.
 * @returns a disposer that removes the route.
 */
export function registerRoutes(ctx, deps) {
  const { store, asr, modelRoute, logger } = deps

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (!path.startsWith(ROUTE_PREFIX)) {
        sendJson(res, 404, { ok: false, error: `未知接口：${path}` })
        return
      }
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
      const method = (req.method ?? 'GET').toUpperCase()

      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-plugin-class-notes', dataDir: store.root })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, await buildState(deps))
        return
      }

      if (segments.length === 1 && segments[0] === 'sessions' && method === 'POST') {
        const body = await readJsonBody(req)
        const session = await store.create({
          title: str(body.title, '未命名听课'),
          course: str(body.course),
          date: str(body.date),
          asrMode: normalizeAsrMode(body.asrMode),
        })
        sendJson(res, 200, { ok: true, session: viewSession(session) })
        return
      }

      if (segments.length !== 2 || segments[0] !== 'sessions') {
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
        return
      }

      const id = segments[1]

      if (method === 'GET') {
        const session = await requireSession(store, id)
        sendJson(res, 200, { ok: true, session: viewSession(session), speech: asr.status() })
        return
      }

      if (method === 'DELETE') {
        await requireSession(store, id)
        await store.remove(id)
        sendJson(res, 200, { ok: true, sessions: (await store.list()).map(projectSession) })
        return
      }

      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = await store.update(id, (session) => {
          for (const key of ['title', 'course', 'date', 'notes']) {
            if (typeof body[key] === 'string') session[key] = body[key]
          }
          if (typeof body.asrMode === 'string') {
            if (!ASR_MODES.includes(body.asrMode)) {
              throw badRequest(`听写模式只认 ${ASR_MODES.join(' / ')}`, 400)
            }
            session.asrMode = normalizeAsrMode(body.asrMode)
          }
          if (body.currentIndex !== undefined) {
            const index = Math.max(1, Math.min(lastIndex(session), Number(body.currentIndex) || 1))
            requireSlide(session, index)
            session.recording.currentIndex = index
            session.tracker = trackerAfterManualJump(session.tracker)
          }
          if (body.status === 'done' || body.status === 'ready' || body.status === 'draft') {
            session.status = body.status
            session.recording.active = false
            if (body.status === SESSION_STATUS.done && session.finishedAt === null) {
              session.finishedAt = new Date().toISOString()
            }
          }
          return session
        })
        sendJson(res, 200, { ok: true, session: viewSession(updated) })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const { status, message } = describeError(error)
      if (status >= 500) logger?.warn?.(`class-notes: ${message}`)
      sendJson(res, status, { ok: false, error: message })
    }
  }

  // Sub-resources live in their own handler so the dispatcher above stays flat.
  const subHandler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (!path.startsWith(ROUTE_PREFIX)) {
        sendJson(res, 404, { ok: false, error: `未知接口：${path}` })
        return
      }
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
      const method = (req.method ?? 'GET').toUpperCase()

      if (segments.length < 3 || segments[0] !== 'sessions') {
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
        return
      }

      const id = segments[1]
      const action = segments[2]

      if (action === 'deck' && method === 'POST') {
        const existing = await requireSession(store, id)
        const bytes = await readRawBody(req, MAX_DECK_BYTES, '课件文件')
        const label = decodeURIComponent(req.headers['x-file-name'] ?? 'deck.pptx')
        // A finished session is a closed record: handing it another deck would
        // overwrite that class's notes, so the new deck opens a new session.
        const session = existing.status === SESSION_STATUS.done
          ? await store.create({
            title: titleFromDeck(label) || str(existing.title, '未命名听课'),
            course: str(existing.course),
            date: localDay(),
            asrMode: existing.asrMode,
          })
          : existing
        const sessionId = session.id
        const target = store.sourcePath(sessionId)
        const workDir = await store.prepareDir(sessionId)
        // A PDF keeps its own original next to the deck it produced, so a failed
        // conversion never destroys what the user actually handed us.
        const saved = isPdfPath(label) ? store.pathIn(sessionId, 'source.pdf') : target
        await saveDeckBytes(bytes.toString('base64'), saved, basename(label))
        const { parsed, pdf } = await importDeck({
          local: saved,
          target,
          workDir,
          logger,
        })
        const updated = await applyImportedDeck(store, sessionId, {
          parsed,
          pdf,
          fileName: basename(label),
          sourcePath: saved,
        })
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          startedNew: sessionId !== id,
          converted: pdf === null ? null : {
            pages: pdf.slideCount,
            rendered: pdf.renderedPages,
            textChars: pdf.textChars,
            warning: pdf.warning,
          },
        })
        return
      }

      if (action === 'keywords' && method === 'POST') {
        const session = await requireSession(store, id)
        if (session.slides.length === 0) throw badRequest('先上传 PPT 再识别关键词')
        const route = modelRoute()
        let payload
        try {
          payload = await extractDeckKeywords({
            slides: session.slides.map((slide) => ({
              index: slide.index,
              title: slide.title,
              texts: [slide.title, slide.body].filter((item) => item !== ''),
            })),
            llm: deps.llm,
            route: route.llm,
            logger,
          })
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          throw badRequest(`识别关键词失败：${String(error?.message ?? error)}`, 500)
        }
        const updated = await store.update(id, (draft) => {
          const byIndex = new Map(payload.slides.map((entry) => [entry.index, entry]))
          for (const slide of draft.slides) {
            const entry = byIndex.get(slide.index)
            if (entry === undefined) continue
            slide.keywords = strList(entry.keywords, 40)
            slide.keywordSource = entry.keywordSource ?? payload.source
            // New keywords invalidate the old translations.
            slide.keywordGlosses = {}
            slide.keywordsZh = []
          }
          draft.meta.keywordsAt = new Date().toISOString()
          draft.meta.keywordsModel = payload.model
          draft.meta.keywordsError = payload.error
          draft.meta.glossAt = null
          draft.meta.glossDirection = ''
          draft.meta.glossError = ''
          return draft
        })
        // Fresh keywords have no glosses yet, so the gloss pass runs right here —
        // not through `ensureGlosses`, which deliberately skips sessions that
        // prove no pass has run (a session with no Latin term would otherwise be
        // retried on every recording start).
        let final = updated
        try {
          final = await glossSession(deps, id)
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          deps.logger?.warn?.('class-notes: gloss after keywords failed for %s: %s', id, String(error?.message ?? error))
        }
        sendJson(res, 200, {
          ok: true,
          session: viewSession(final),
          keywordSource: payload.source,
          error: payload.error === '' ? null : payload.error,
        })
        return
      }

      if (action === 'gloss' && method === 'POST') {
        const updated = await glossSession(deps, id)
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          glossError: updated.meta.glossError === '' ? null : updated.meta.glossError,
        })
        return
      }

      if (action === 'summary' && method === 'POST') {
        const session = await requireSession(store, id)
        if (session.slides.length === 0) throw badRequest('先放一份课件，再来总结')
        const route = modelRoute()
        const result = await summarizeSession({
          session,
          llm: deps.llm,
          route: route.llm,
          logger,
        })
        if (result.markdown === '') throw badRequest(result.error === '' ? '总结没写出来，再试一次' : result.error, 400)
        const updated = await store.update(id, (draft) => {
          draft.summary = {
            at: new Date().toISOString(),
            model: result.model,
            markdown: result.markdown,
            error: '',
          }
          return draft
        })
        sendJson(res, 200, { ok: true, session: viewSession(updated), summary: updated.summary })
        return
      }

      if (action === 'chunk' && method === 'POST') {
        const session = await requireSession(store, id)
        if (session.status === SESSION_STATUS.done) {
          throw badRequest('这节课已经结束转录了，放下一份课件会开新的一节', 409)
        }
        // Audio that arrives while this class is not recording would otherwise be
        // appended to whatever page it happens to be on — the classic way a tail
        // from lesson A shows up in lesson B.
        if (session.recording.active !== true) {
          throw badRequest('这节课没在录音，这一段不收（先在③里点开始录音）', 409)
        }
        if (session.slides.length === 0) throw badRequest('还没有上传 PPT，无法把内容记到某一页')
        const bytes = await readRawBody(req, MAX_CHUNK_BYTES, '录音片段')
        let result
        try {
          result = await asr.transcribeWav(new Uint8Array(bytes), {
            allowEmpty: true,
            language: asrLanguage(session.asrMode),
          })
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          throw badRequest(`识别失败：${String(error?.message ?? error)}`, 400)
        }
        if (result.text === '') {
          const current = await requireSession(store, id)
          sendJson(res, 200, {
            ok: true,
            empty: true,
            session: viewSession(current),
            decision: current.tracker.lastDecision,
          })
          return
        }
        const updated = await attachChunk(deps, id, result.text, { audioSeconds: result.audioSeconds })
        sendJson(res, 200, {
          ok: true,
          empty: false,
          text: result.text,
          session: viewSession(updated),
          decision: updated.tracker.lastDecision,
        })
        return
      }

      if (action === 'recording' && method === 'POST') {
        const body = await readJsonBody(req)
        const active = body.active !== false
        // One class records at a time: starting the mic elsewhere pauses the
        // lesson that still had it, and the response says which one, so the
        // panel can tell the user instead of letting a clock run silently.
        const paused = active ? await pauseOtherRecordings(store, id) : []
        const updated = await store.update(id, (session) => {
          session.recording.active = active
          if (active) {
            session.recording.startedAt = new Date().toISOString()
            session.recording.stoppedAt = null
            if (session.recording.currentIndex === 0 && session.slides.length > 0) {
              session.recording.currentIndex = 1
            }
            session.status = 'recording'
            session.tracker = trackerAfterManualJump(session.tracker)
          } else {
            session.recording.stoppedAt = new Date().toISOString()
            // Stop is a pause, not the end of the class: the session stays open
            // so the mic can be switched back on. `finish` closes it.
            if (session.status === 'recording') session.status = SESSION_STATUS.ready
          }
          return session
        })
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          paused: paused.map((item) => ({ id: item.id, title: item.title })),
        })
        // Recording does not wait for the teacher to press "识别关键词": a Chinese
        // lecture over an English deck is only matched through the Chinese
        // glosses, so they are fetched in the background the first time the mic
        // goes on. Failures are kept on the session and shown in the panel.
        if (active) void ensureGlosses(deps, id, updated)
        return
      }

      if (action === 'finish' && method === 'POST') {
        const updated = await store.update(id, (session) => {
          if (session.slides.length === 0) {
            throw badRequest('这节课还没放过课件，结束不了')
          }
          session.recording.active = false
          if (session.recording.stoppedAt === null) {
            session.recording.stoppedAt = new Date().toISOString()
          }
          session.finishedAt = new Date().toISOString()
          session.status = SESSION_STATUS.done
          return session
        })
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          progress: sessionProgress(updated),
        })
        return
      }

      if (action === 'export' && method === 'POST') {
        const body = await readJsonBody(req)
        const session = await requireSession(store, id)
        if (session.slides.length === 0) throw badRequest('还没有上传 PPT，没法导出')
        const directory = str(body.directory, workspaceDir())
        const stem = sanitizeName(session.title === '' ? '听课笔记' : session.title)
        const targetPath = join(directory, `${stem}-听课笔记.pptx`)
        const pagesPath = join(directory, `${stem}-听课笔记.md`)
        const bySlide = session.slides.map((slide) => ({
          index: slide.index,
          title: slide.title,
          note: slideNote(slide),
          keywords: slide.keywords,
        }))
        let payload
        try {
          payload = await writeDeckNotes({
            mode: 'both',
            source: store.sourcePath(id),
            target: targetPath,
            pagesOut: pagesPath,
            title: session.title,
            date: session.date,
            bySlide,
          })
        } catch (error) {
          throw badRequest(`导出失败：${String(error?.message ?? error)}`, 500)
        }
        // The recap, when there is one, belongs at the end of the notes file —
        // it is the part a person re-reads before an exam.
        const recap = session.summary.markdown.trim()
        if (recap !== '') {
          try {
            const notesPath = payload.pagesOut ?? pagesPath
            const existing = await readFile(notesPath, 'utf8')
            if (!existing.includes('## AI 纪要')) {
              await writeFile(notesPath, `${existing.replace(/\s+$/, '')}\n\n---\n\n## AI 纪要\n\n${recap}\n`, 'utf8')
            }
          } catch (error) {
            logger?.warn?.(`class-notes: 纪要写进 Markdown 失败 ${String(error?.message ?? error)}`)
          }
        }
        // The workspace copy is the one the user opens in PowerPoint; these
        // session-local copies are what the panel's download buttons fetch.
        const downloads = {}
        try {
          const localPptx = store.pathIn(id, '导出-听课笔记.pptx')
          const localMd = store.pathIn(id, '导出-听课笔记.md')
          await copyFile(payload.target ?? targetPath, localPptx)
          await copyFile(payload.pagesOut ?? pagesPath, localMd)
          const asDownload = (name) => `${ROUTE_PREFIX}/sessions/${encodeURIComponent(id)}/file?name=${encodeURIComponent(name)}`
          downloads.pptx = asDownload(basename(localPptx))
          downloads.md = asDownload(basename(localMd))
          if (recap !== '') {
            const localRecap = store.pathIn(id, '导出-听课纪要.md')
            await writeFile(localRecap, `# ${session.title === '' ? '听课' : session.title}（${session.date}）\n\n${recap}\n`, 'utf8')
            downloads.summary = asDownload(basename(localRecap))
          }
        } catch (error) {
          logger?.warn?.(`class-notes: 导出副本失败 ${String(error?.message ?? error)}`)
        }
        const updated = await store.update(id, (draft) => {
          draft.status = SESSION_STATUS.done
          draft.recording.active = false
          if (draft.finishedAt === null) draft.finishedAt = new Date().toISOString()
          return draft
        })
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          target: payload.target ?? targetPath,
          pagesOut: payload.pagesOut ?? pagesPath,
          downloads,
          notesWritten: payload.notesWritten ?? 0,
          progress: sessionProgress(updated),
        })
        return
      }

      if (action === 'speech' && method === 'POST') {
        const status = asr.status()
        if (status.available !== true) throw badRequest(status.error, 400)
        const prepared = await asr.prepare()
        sendJson(res, 200, { ok: true, speech: prepared ?? asr.status() })
        return
      }

      if (action === 'file' && method === 'GET') {
        const name = url.searchParams.get('name') ?? ''
        const resolved = safeJoin(store.pathIn(id, '.'), name)
        if (resolved === null) throw badRequest('非法的文件名')
        let info
        try {
          info = await stat(resolved)
        } catch {
          throw badRequest(`找不到文件：${name}`, 404)
        }
        if (!info.isFile()) throw badRequest('不是文件', 404)
        const type = resolved.toLowerCase().endsWith('.pptx')
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : resolved.toLowerCase().endsWith('.md')
            ? 'text/markdown; charset=utf-8'
            : 'application/octet-stream'
        res.writeHead(200, {
          'content-type': type,
          'content-length': info.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(resolved))}`,
        })
        createReadStream(resolved).pipe(res)
        return
      }

      if (action === 'slides' && segments.length === 4 && method === 'POST') {
        const index = Number(segments[3])
        const body = await readJsonBody(req)
        const updated = await store.update(id, (session) => {
          const slide = requireSlide(session, index)
          if (Array.isArray(body.keywords)) {
            slide.keywords = strList(body.keywords, 40)
            slide.keywordSource = 'manual'
            // Hand-edited keywords keep only the glosses of terms that survived,
            // and any newly typed Chinese keyword speaks for itself already.
            const kept = {}
            for (const [term, gloss] of Object.entries(slide.keywordGlosses)) {
              if (slide.keywords.includes(term)) kept[term] = gloss
            }
            slide.keywordGlosses = kept
            slide.keywordsZh = Object.values(kept)
          }
          if (body.keywordGlosses !== null && typeof body.keywordGlosses === 'object' && !Array.isArray(body.keywordGlosses)) {
            const merged = { ...slide.keywordGlosses }
            for (const [term, gloss] of Object.entries(body.keywordGlosses)) {
              const key = str(term)
              const value = str(gloss)
              if (key === '' || !slide.keywords.includes(key)) continue
              if (value === '') delete merged[key]
              else merged[key] = value.slice(0, 80)
            }
            slide.keywordGlosses = merged
            slide.keywordsZh = Object.values(merged)
          }
          if (typeof body.notes === 'string') slide.notes = body.notes
          if (body.jump === true) {
            session.recording.currentIndex = slide.index
            session.tracker = trackerAfterManualJump(session.tracker)
          }
          return session
        })
        sendJson(res, 200, { ok: true, session: viewSession(updated) })
        return
      }

      if (action === 'import-path' && method === 'POST') {
        const existing = await requireSession(store, id)
        const body = await readJsonBody(req)
        const source = str(body.path)
        if (source === '') throw badRequest('请提供课件的完整路径（PPT 或 PDF）')
        const session = existing.status === SESSION_STATUS.done
          ? await store.create({
            title: titleFromDeck(source) || str(existing.title, '未命名听课'),
            course: str(existing.course),
            date: localDay(),
            asrMode: existing.asrMode,
          })
          : existing
        const sessionId = session.id
        const target = store.sourcePath(sessionId)
        const workDir = await store.prepareDir(sessionId)
        const saved = isPdfPath(source) ? store.pathIn(sessionId, 'source.pdf') : target
        await copyDeckFile(source, saved)
        const { parsed, pdf } = await importDeck({
          local: saved,
          target,
          workDir,
          logger,
        })
        const updated = await applyImportedDeck(store, sessionId, {
          parsed,
          pdf,
          fileName: basename(source),
          sourcePath: saved,
        })
        sendJson(res, 200, {
          ok: true,
          session: viewSession(updated),
          startedNew: sessionId !== id,
          converted: pdf === null ? null : {
            pages: pdf.slideCount,
            rendered: pdf.renderedPages,
            textChars: pdf.textChars,
            warning: pdf.warning,
          },
        })
        return
      }

      if (action === 'preview' && method === 'GET') {
        const session = await requireSession(store, id)
        const source = store.sourcePath(id)
        let pages = []
        if (store.hasDeck(id)) {
          try {
            const text = await readFile(store.pathIn(id, 'preview.md'), 'utf8')
            pages = text.split('\n')
          } catch {
            pages = []
          }
        }
        sendJson(res, 200, { ok: true, source, pages, session: viewSession(session) })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const { status, message } = describeError(error)
      if (status >= 500) logger?.warn?.(`class-notes: ${message}`)
      sendJson(res, status, { ok: false, error: message })
    }
  }

  const dispatcher = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
    const segments = rest === '' ? [] : rest.split('/')
    if (segments.length >= 3 && segments[0] === 'sessions') {
      await subHandler(req, res)
      return
    }
    await handler(req, res)
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: dispatcher })
}

/**
 * Which way keywords get glossed, given how the lecture is being transcribed.
 *
 * 中文 lecture over an English deck → English terms get 中文. English lecture
 * over a Chinese deck → Chinese terms get English. 中英混合 leaves both open.
 */
function glossDirection(asrMode) {
  if (asrMode === 'en') return 'toEn'
  if (asrMode === 'mixed') return 'both'
  return 'toZh'
}

/** Turn a title into a safe file stem. */
/** A deck's own file name, minus folder and extension, as a session title. */function titleFromDeck(value) {
  const base = String(value ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim()
  return base === '' ? '' : sanitizeName(base)
}

function sanitizeName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '听课笔记'
}

/** Join and reject traversal outside `root`. */
function safeJoin(root, name) {
  if (typeof name !== 'string' || name === '') return null
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null
  return join(root, name)
}
