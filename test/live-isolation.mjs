/**
 * One class per recording: audio must never leak into another session.
 *
 * Two lessons are open at the same time. Each is sent pure-tone WAVs of a known
 * length through the real /chunk route; the checks are that every lesson only
 * counts its own audio, keeps its own notes, and that ending one lesson leaves
 * the other exactly as it was. The recorder asks the recognizer for the text of
 * a silent 2 s tone (usually empty, sometimes a stray sound), so the assertions
 * only look at lengths and at text the test itself injected.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encodeWavFromFloat32 } from '../lib/wav.js'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:54235').replace(/\/$/, '')
const API = `${BASE}/dsh-class-notes`
const DECK = join(here, 'demo-lecture.pptx')
const MARK_A = '隔离标记甲'
const MARK_B = '隔离标记乙'

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

/** Post one WAV as a chunk; `words` is only there to label the log line — the
 *  recognizer gets pure WAV bytes, exactly like the browser sends. */
async function chunk(id, wav, words = '') {
  const response = await fetch(`${API}/sessions/${encodeURIComponent(id)}/chunk`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: wav,
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  return { ok: response.ok && payload.ok !== false, status: response.status, payload, words }
}

function noteText(session) {
  return (session.slides ?? []).map((slide) => slide.note ?? '').join('\n')
}

/** A tone of a known length, so the recorder's own sample count is predictable
 *  even when the recognizer returns nothing. */
function toneWav(seconds) {
  const rate = 16000
  const samples = new Float32Array(Math.round(rate * seconds))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 300 * index) / rate) * 0.25
  }
  return encodeWavFromFloat32(samples, rate)
}

async function main() {
  const health = await json('/health')
  check(health.ok === true, 'host half is up', health.dataDir)

  const created = []
  try {
    const alpha = (await json('/sessions', { method: 'POST', body: { title: '隔离测试 A', course: '联调' } })).session
    const beta = (await json('/sessions', { method: 'POST', body: { title: '隔离测试 B', course: '联调' } })).session
    created.push(alpha.id, beta.id)
    await upload(alpha.id)
    await upload(beta.id)
    check(true, 'two lessons open at once')

    // Without the mic on, audio is refused instead of being filed under whatever
    // page the class happens to sit on.
    const refused = await chunk(alpha.id, toneWav(2))
    check(refused.ok === false && refused.status === 409, 'audio is refused while not recording', refused.payload.error ?? String(refused.status))

    // Only one class can be live. Starting B while A still holds the mic pauses A.
    await json(`/sessions/${alpha.id}/recording`, { method: 'POST', body: { active: true } })
    const alphaLive = (await json(`/sessions/${alpha.id}`)).session
    check(alphaLive.recording.active === true, 'A is recording')
    const startedBeta = await json(`/sessions/${beta.id}/recording`, { method: 'POST', body: { active: true } })
    const alphaPaused = (await json(`/sessions/${alpha.id}`)).session
    const betaLive = (await json(`/sessions/${beta.id}`)).session
    check(alphaPaused.recording.active === false, 'starting B pauses A')
    check((startedBeta.paused ?? []).some((item) => item.id === alpha.id), 'the host says which lesson it paused', JSON.stringify(startedBeta.paused ?? []))
    check(alphaPaused.status !== 'done', 'pausing A does not finish it', alphaPaused.status)
    check(betaLive.recording.active === true, 'B is the one recording now')

    // Audio for A is refused while B owns the mic, and B's bookkeeping is untouched.
    const betaBefore = (await json(`/sessions/${beta.id}`)).session
    const stray = await chunk(alpha.id, toneWav(2))
    check(stray.ok === false && stray.status === 409, 'audio for the paused class is refused', stray.payload.error ?? String(stray.status))
    const betaAfterStray = (await json(`/sessions/${beta.id}`)).session
    check((betaAfterStray.recording?.chunks ?? 0) === (betaBefore.recording?.chunks ?? 0), 'B did not count the stray audio')
    check(noteText(betaAfterStray) === noteText(betaBefore), 'B notes untouched by the stray audio')

    // The class that owns the mic accepts audio and only its own counters move.
    const alphaBeforeChunk = (await json(`/sessions/${alpha.id}`)).session
    const betaBeforeChunk = (await json(`/sessions/${beta.id}`)).session
    const accepted = await chunk(beta.id, toneWav(2))
    check(accepted.ok, 'the recording class accepts audio', accepted.ok ? 'ok' : (accepted.payload.error ?? String(accepted.status)))
    const alphaAfterChunk = (await json(`/sessions/${alpha.id}`)).session
    const betaAfterChunk = (await json(`/sessions/${beta.id}`)).session
    check(noteText(alphaAfterChunk) === noteText(alphaBeforeChunk), 'accepting audio for B left A’s notes alone')
    check((alphaAfterChunk.recording?.chunks ?? 0) === (alphaBeforeChunk.recording?.chunks ?? 0), 'A chunk count untouched by B’s audio')
    check((betaAfterChunk.recording?.chunks ?? 0) >= (betaBeforeChunk.recording?.chunks ?? 0), 'B only ever grows its own count')
    const markA = '这是甲课的独有句子'
    const markB = '这是乙课的独有句子'
    await json(`/sessions/${alpha.id}/slides/2`, { method: 'POST', body: { notes: markA } })
    await json(`/sessions/${beta.id}/slides/2`, { method: 'POST', body: { notes: markB } })
    const alphaMarked = (await json(`/sessions/${alpha.id}`)).session
    const betaMarked = (await json(`/sessions/${beta.id}`)).session
    check(noteText(alphaMarked).includes(markA), 'A keeps the sentence written into it')
    check(!noteText(betaMarked).includes(markA), 'B has none of A’s text')
    check(!noteText(alphaMarked).includes(markB), 'A has none of B’s text')
    check(noteText(alphaMarked) !== noteText(betaMarked), 'A and B never share the same notes')

    // Ending A must not close, pause or touch B.
    await json(`/sessions/${alpha.id}/finish`, { method: 'POST', body: {} })
    const betaAfterFinish = (await json(`/sessions/${beta.id}`)).session
    check(betaAfterFinish.status !== 'done', 'finishing A leaves B open', betaAfterFinish.status)
    check(betaAfterFinish.finishedAt === null, 'B has no finishedAt from A')
    check(noteText(betaAfterFinish) === noteText(betaMarked), 'B notes untouched by finishing A')
    check(betaAfterFinish.recording?.active === true, 'B is still recording after A ended')

    // Late audio for a closed lesson is refused, and still nothing reaches B.
    const late = await chunk(alpha.id, toneWav(2))
    check(late.ok === false && late.status === 409, 'closed lesson refuses late audio', late.payload.error ?? String(late.status))
    const betaAfterLate = (await json(`/sessions/${beta.id}`)).session
    check(noteText(betaAfterLate) === noteText(betaMarked), 'refused audio did not land in B either')
    check((betaAfterLate.recording?.chunks ?? 0) === (betaAfterChunk.recording?.chunks ?? 0), 'B chunk count untouched by refused audio')

    // A brand-new lesson starts empty: no counters carried from A or B.
    const gamma = (await json('/sessions', { method: 'POST', body: { title: '隔离测试 C', course: '联调' } })).session
    created.push(gamma.id)
    check((gamma.recording?.chunks ?? 0) === 0 && (gamma.progress?.chars ?? 0) === 0, 'a new lesson starts with nothing carried over')

    const state = await json('/state')
    const ids = (state.sessions ?? []).map((item) => item.id)
    check([alpha.id, beta.id, gamma.id].every((id) => ids.includes(id)), 'all lessons still listed')
  } finally {
    for (const id of created) {
      await fetch(`${API}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    }
  }
}

await main()
if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\nall isolation checks passed')
