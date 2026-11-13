/**
 * Unit test: the AI recap of a class.
 *
 *   node test/summary.mjs
 *
 * Everything runs against a fake model — no network, no real session — so the
 * checks are about what the model is told and what survives its answer: the page
 * text has to arrive, fences have to be stripped, an empty class has to be
 * refused instead of sending a prompt that cannot be answered.
 */
import { normalizeSession } from '../lib/model.js'
import { parseSummaryMarkdown, summarizeSession, summarySourceChars } from '../lib/summary.js'

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** A model that answers with whatever the test wants, recording the prompt. */
function fakeLlm(answerFor) {
  const prompts = []
  return {
    prompts,
    async prepareCall() {
      return {
        config: {},
        stream(request) {
          prompts.push({
            prompt: request.messages[0].content[0].text,
            system: request.system,
          })
          const text = answerFor(request.messages[0].content[0].text)
          return (async function* run() {
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

function sessionWith(slides) {
  return normalizeSession({
    id: 'cls-test',
    title: '第 3 讲 机器学习入门',
    course: '数据科学导论',
    date: '2026-11-13',
    slides,
  })
}

const RECAP = [
  '## 一句话概括',
  '这节课从「机器怎么从数据里学」讲到线性回归的误差最小化。',
  '## 这节课讲了什么',
  '- 先区分监督学习和无监督学习：一个用标签，一个只看结构。',
  '- 线性回归用**均方误差**衡量拟合好坏。',
  '- 最小二乘法给出了闭式解。',
  '## 重点与易错',
  '- 梯度下降的方向是负梯度，别记反。',
  '## 复习清单',
  '1. 能自己推一遍最小二乘的闭式解吗。',
].join('\n')

const DECK = sessionWith([
  {
    index: 1,
    title: '什么是机器学习',
    keywords: ['机器学习', 'Arthur Samuel'],
    segments: [{ at: 't1', text: '今天我们讲什么是机器学习，Arthur Samuel 让它自己下棋。' }],
  },
  {
    index: 2,
    title: '线性回归',
    keywords: ['线性回归', '均方误差'],
    segments: [{ at: 't2', text: '线性回归就是用均方误差来衡量好坏，最小二乘法能直接算出来。' }],
  },
  { index: 3, title: '课堂练习', keywords: ['练习'], segments: [] },
])

// ── prompt ────────────────────────────────────────────────────────────────
const llm = fakeLlm(() => `\`\`\`markdown\n${RECAP}\n\`\`\``)
const result = await summarizeSession({
  session: DECK,
  llm,
  route: { provider: 'p', model: 'fake-model' },
})
check(llm.prompts.length === 1, 'one model call for the whole class', String(llm.prompts.length))
const sent = llm.prompts[0]?.prompt ?? ''
check(sent.includes('第 1 页 · 什么是机器学习'), 'prompt carries the page heading')
check(sent.includes('Arthur Samuel 让它自己下棋'), 'prompt carries the transcript')
check(sent.includes('关键词：机器学习、Arthur Samuel'), 'prompt carries the keywords')
check(!sent.includes('第 3 页'), 'a page with no transcript is left out of the prompt')
check((llm.prompts[0]?.system ?? '').includes('一句话概括'), 'system prompt fixes the section skeleton')

// ── answer ────────────────────────────────────────────────────────────────
check(result.markdown.startsWith('## 一句话概括'), 'fenced reply is unwrapped', result.markdown.slice(0, 20))
check(!result.markdown.includes('```'), 'no code fence survives')
check(result.markdown.includes('**均方误差**'), 'bold markup is kept for the panel renderer')
check(result.model === 'fake-model', 'model label recorded', result.model)
check(result.error === '', 'no error on a good run')

// ── refusals ──────────────────────────────────────────────────────────────
const empty = sessionWith([{ index: 1, title: '封面', keywords: [], segments: [] }])
const emptyLlm = fakeLlm(() => RECAP)
const emptyResult = await summarizeSession({ session: empty, llm: emptyLlm })
check(emptyLlm.prompts.length === 0, 'an unrecorded class never reaches the model')
check(emptyResult.markdown === '' && emptyResult.error.includes('还太少'), 'unrecorded class is refused with a hint', emptyResult.error)
check(summarySourceChars(empty) === 0, 'source chars counted')

const noModel = await summarizeSession({ session: DECK, llm: null })
check(noModel.markdown === '' && noModel.error.includes('模型'), 'no model is reported, not thrown', noModel.error)

const brokenLlm = {
  async prepareCall() {
    throw new Error('模型挂了')
  },
}
const broken = await summarizeSession({ session: DECK, llm: brokenLlm, route: { model: 'x' } })
check(broken.markdown === '' && broken.error.includes('模型挂了'), 'model failure comes back as a message', broken.error)

const blank = await summarizeSession({ session: DECK, llm: fakeLlm(() => '   '), route: { model: 'x' } })
check(blank.markdown === '' && blank.error.includes('空'), 'empty answer is reported', blank.error)

// ── parsing edges ─────────────────────────────────────────────────────────
check(parseSummaryMarkdown('```\n# 标题\n```') === '# 标题', 'bare fence unwrapped')
check(parseSummaryMarkdown('  正文  ') === '正文', 'trimmed')
check(parseSummaryMarkdown('## 一句话概括\n没有围栏也能用').startsWith('## 一句话概括'), 'plain markdown passes through')
check(parseSummaryMarkdown('') === '', 'empty stays empty')

// ── the manual note joins the transcript ──────────────────────────────────
const withManual = sessionWith([
  {
    index: 1,
    title: '线性回归',
    keywords: ['线性回归'],
    segments: [{ at: 't1', text: '线性回归的损失函数是均方误差，最小二乘法可以直接把参数解出来，不用迭代。' }],
    notes: '这个公式考试要背',
  },
])
const manualLlm = fakeLlm(() => RECAP)
await summarizeSession({ session: withManual, llm: manualLlm, route: { provider: 'p', model: 'fake-model' } })
check(manualLlm.prompts[0].prompt.includes('考试要背'), 'the teacher’s own note is part of the source')

// ── long classes stay inside the budget ───────────────────────────────────
const longSlides = Array.from({ length: 40 }, (_, i) => ({
  index: i + 1,
  title: `第 ${i + 1} 页的标题`,
  keywords: ['关键词'],
  segments: [{ at: `t${i}`, text: '很长的讲课内容。'.repeat(300) }],
}))
const longLlm = fakeLlm(() => RECAP)
await summarizeSession({ session: sessionWith(longSlides), llm: longLlm, route: { provider: 'p', model: 'fake-model' } })
const longPrompt = longLlm.prompts[0].prompt
check(longPrompt.length <= 16_000, 'prompt stays within the character budget', String(longPrompt.length))
check(longPrompt.includes('第 1 页'), 'long class still starts at page one')

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all summary checks passed')
