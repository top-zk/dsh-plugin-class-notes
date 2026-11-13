/**
 * One-off probe: what does the keyword model actually return for an English
 * deck, and does the gloss pass keep the English term as the key?
 *
 *   node test/probe-gloss-live.mjs
 *
 * Creates a throwaway session, uploads the English demo deck, prints the model's
 * raw keyword picks and the glosses that came back, then deletes it.
 */
const API = `${process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52296'}/dsh-class-notes`

async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const payload = await response.json().catch(() => ({}))
  if (response.ok !== true) throw new Error(`${path} → ${response.status} ${payload.error ?? ''}`)
  return payload
}

const created = await json('/sessions', { method: 'POST', body: { title: 'gloss probe', asrMode: 'zh' } })
const id = created.session.id
try {
  const bytes = await (await import('node:fs/promises')).readFile(new URL('./demo-lecture.pptx', import.meta.url))
  await fetch(`${API}/sessions/${encodeURIComponent(id)}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('demo-lecture.pptx') },
    body: bytes,
  })
  const picked = await json(`/sessions/${encodeURIComponent(id)}/keywords`, { method: 'POST', body: {} })
  for (const slide of picked.session.slides) {
    console.log(`${slide.index}. ${slide.title}`)
    console.log(`   kw: ${(slide.keywords ?? []).join('、')}`)
    console.log(`   zh: ${JSON.stringify(slide.keywordGlosses ?? {})}`)
  }
  console.log('meta:', JSON.stringify({
    glossAt: picked.session.meta.glossAt,
    glossModel: picked.session.meta.glossModel,
    glossError: picked.session.meta.glossError,
    keywordsError: picked.session.meta.keywordsError,
  }))
} finally {
  await json(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
}
