/**
 * Debug helper: feed a Chinese lecture over an English deck through the tracker
 * and print every decision, so a page that never turns can be diagnosed.
 *
 *   node test/debug-en-turns.mjs
 */
import { readFile } from 'node:fs/promises'
import { evaluateChunk } from '../lib/tracker.js'

const API = `${process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52296'}/dsh-class-notes`
async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return response.json()
}

const created = await json('/sessions', { method: 'POST', body: { title: 'turns probe', asrMode: 'zh' } })
const id = created.session.id
try {
  await fetch(`${API}/sessions/${id}/deck`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('en-lecture.pptx') },
    body: await readFile(new URL('./en-lecture.pptx', import.meta.url)),
  })
  const picked = await json(`/sessions/${id}/keywords`, { method: 'POST', body: {} })
  let state = picked.session
  const base = Date.now()
  const lines = [
    '这节课我们把反向传播再讲一遍，还是靠链式法则一层层往回推',
    '反向传播的每一步其实就是梯度下降的一次更新',
    '先讲过拟合，也就是模型把训练集背下来了',
    '压住过拟合的办法就是正则化，也可以叫权重衰减',
    '优化器再补充一个动量法，或者直接用 Adam',
    '批大小会影响收敛的稳定性',
  ]
  lines.forEach((line, at) => {
    const decision = evaluateChunk({ session: state, tracker: state.tracker, chunk: line, now: base + at * 5_500 })
    const d = decision.decision
    console.log(
      `[${at}] page=${d.currentIndex} here=${d.here} ahead=${d.ahead} specific=${d.aheadSpecific}`,
      `window=${d.windowAhead} streak=${d.streak} dwell=${d.dwellMs} advance=${decision.advance} :: ${d.reason}`,
    )
    state = { ...state, tracker: decision.tracker, recording: { ...state.recording, currentIndex: decision.index } }
  })
} finally {
  await json(`/sessions/${id}`, { method: 'DELETE' })
}
