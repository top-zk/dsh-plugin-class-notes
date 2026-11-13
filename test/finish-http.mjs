// Checks the "one deck, one session" rule against the running host half:
// stopping the mic only pauses, finishing closes the class, and a deck handed
// to a closed session opens a fresh one instead of overwriting the record.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:65039'
const API = `${BASE}/dsh-class-notes`

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
}

async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, options)
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  return { status: response.status, payload }
}

function json(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
}

async function uploadDeck(id, fileName, bytes) {
  return call(`/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(fileName) },
    body: bytes,
  })
}

const health = await call('/health')
check('health', health.payload?.ok === true, health.payload)

const deckBytes = await readFile(join(ROOT, 'test', 'demo-lecture.pptx'))

const created = await call('/sessions', json('POST', { title: '进程测试', course: '测试课', asrMode: 'en' }))
const first = created.payload?.session
check('新建会话', typeof first?.id === 'string', first?.id)

const uploaded = await uploadDeck(first.id, 'demo-lecture.pptx', deckBytes)
check('课件放进去', uploaded.payload?.session?.slides?.length === 9, uploaded.payload?.session?.slides?.length)
check('第一次放不算新开', uploaded.payload?.startedNew === false, uploaded.payload?.startedNew)

const started = await call(`/sessions/${encodeURIComponent(first.id)}/recording`, json('POST', { active: true }))
check('开始录音', started.payload?.session?.status === 'recording', started.payload?.session?.status)

// The chunk route only takes WAV and runs the local model, so the record's
// content is exercised through a manual note plus the deck's own page-3 note.
const noted = await call(`/sessions/${encodeURIComponent(first.id)}/slides/2`, json('POST', { notes: '老师补充：先讲清损失函数' }))
check('写了一条补充', (noted.payload?.session?.progress?.chars ?? 0) > 0, noted.payload?.session?.progress)

const stopped = await call(`/sessions/${encodeURIComponent(first.id)}/recording`, json('POST', { active: false }))
check('停止只是暂停，不是结束', stopped.payload?.session?.status === 'ready', stopped.payload?.session?.status)
check('暂停时还没 finishedAt', stopped.payload?.session?.finishedAt === null, stopped.payload?.session?.finishedAt)

const finished = await call(`/sessions/${encodeURIComponent(first.id)}/finish`, json('POST', {}))
check('结束转录', finished.payload?.session?.status === 'done', finished.payload?.session?.status)
check('结束有 finishedAt', typeof finished.payload?.session?.finishedAt === 'string', finished.payload?.session?.finishedAt)
check('结束响应带进度', (finished.payload?.progress?.slides ?? 0) === 9, finished.payload?.progress)

const lateChunk = await call(`/sessions/${encodeURIComponent(first.id)}/chunk`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: new Uint8Array([0, 1, 2, 3]),
})
check('结束以后不再收录音', lateChunk.status === 409 && lateChunk.payload?.ok === false, {
  status: lateChunk.status,
  error: lateChunk.payload?.error,
})

const second = await uploadDeck(first.id, 'demo-lecture.pptx', deckBytes)
const nextId = second.payload?.session?.id
check('对已结束的课再传课件 → 开新的一节', second.payload?.startedNew === true && nextId !== first.id, {
  startedNew: second.payload?.startedNew,
  nextId,
})
check('新的一节页码和听写模式跟着走', second.payload?.session?.slides?.length === 9
  && second.payload?.session?.asrMode === 'en', {
  slides: second.payload?.session?.slides?.length,
  asrMode: second.payload?.session?.asrMode,
})

check('新的一节按课件名起标题', second.payload?.session?.title === 'demo-lecture', second.payload?.session?.title)

const kept = await call(`/sessions/${encodeURIComponent(first.id)}`)
check('老的那节还在，备注没被覆盖', kept.payload?.session?.status === 'done'
  && (kept.payload?.session?.progress?.chars ?? 0) > 0, {
  status: kept.payload?.session?.status,
  chars: kept.payload?.session?.progress?.chars,
})

const listed = await call('/state')
const ids = (listed.payload?.sessions ?? []).map((item) => item.id)
check('列表里两节都在', ids.includes(first.id) && ids.includes(nextId), ids.slice(0, 4))

for (const id of [first.id, nextId]) {
  if (typeof id === 'string') await call(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}`)
  process.exitCode = 1
}
