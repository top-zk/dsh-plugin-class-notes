/**
 * Hits the live host half over loopback HTTP — the same calls the panel makes.
 *   node test/live-http.mjs [base]
 * Default base is the desktop shell's own port.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const base = (process.argv[2] ?? 'http://127.0.0.1:65039') + '/dsh-class-notes'

let failed = 0
function check(label, ok, extra = '') {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra === '' ? '' : `  ${extra}`}`)
}

async function json(path, options = {}) {
  const res = await fetch(base + path, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${res.status} ${body.error ?? ''}`)
  }
  return body
}

console.log('1. 服务还活着')
const health = await json('/health')
check('health', health.ok === true, health.dataDir)

const state = await json('/state')
check('state 带语音与模型状态', Array.isArray(state.sessions) && typeof state.speech === 'object', `sessions=${state.sessions.length} speech=${state.speech.phase ?? 'n/a'} llm=${state.llm?.label ?? 'n/a'}`)

console.log('2. 建一节课 + 上传课件')
const created = await json('/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'HTTP 联调课', course: '机器学习' }),
})
const id = created.session.id
check('session 建好', typeof id === 'string' && id.startsWith('cls'), id)

const bytes = await readFile(join(here, 'demo-lecture.pptx'))
const uploaded = await json(`/sessions/${id}/deck`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('demo-lecture.pptx') },
  body: bytes,
})
check('课件解析出 9 页', uploaded.session.slides.length === 9, `${uploaded.session.slides.length} 页 ${uploaded.session.meta.fileName}`)
check('第 3 页老师备注保留', (uploaded.session.slides[2].notes ?? '').includes('思考题'))

console.log('3. 识别关键词')
const keyed = await json(`/sessions/${id}/keywords`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const words = keyed.session.slides.map((s) => s.keywords)
check('每页都有关键词', words.every((list) => list.length > 0), `来源 ${keyed.session.meta.keywordsModel ?? keyed.session.meta.keywordSource ?? keyed.session.slides[0].keywordSource}`)
console.log(`     第 2 页：${words[1].join(' / ')}`)
console.log(`     第 5 页：${words[4].join(' / ')}`)

console.log('4. 手动备注 + 翻页')
await json(`/sessions/${id}/slides/4`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ notes: '最小二乘的几何解释下次补' }),
})
const jumped = await json(`/sessions/${id}/slides/6`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jump: true }),
})
check('跳到第 6 页', jumped.session.recording.currentIndex === 6, `reason=${jumped.decision?.reason ?? ''}`)

console.log('5. 导出')
const exported = await json(`/sessions/${id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('拿到下载路径', typeof exported.downloads?.pptx === 'string', exported.downloads?.pptx ?? '')
const fileRes = await fetch('http://127.0.0.1:65039' + exported.downloads.pptx)
check('下载得到 pptx', (await fileRes.arrayBuffer()).byteLength > 10000, `${fileRes.status}`)

console.log('6. 收拾')
await json(`/sessions/${id}`, { method: 'DELETE' })
const after = await json('/state')
check('删掉了', after.sessions.every((item) => item.id !== id))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
