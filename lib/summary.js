/**
 * AI recap of one class.
 *
 * The panel's value is the note per slide; a recap answers the other question —
 * "这节课到底讲了什么". Everything here is built from what the recording already
 * captured (slide titles, keywords, per-page transcript), so the model never has
 * to guess: it compresses.
 *
 * The output is plain Markdown with a fixed skeleton, because the panel draws it
 * with a tiny formatter and the export appends it to the notes file.
 */
import { askModel } from './keywords.js'
import { slideNote } from './model.js'

/** Total characters of lecture text handed to the model. */
const MAX_INPUT_CHARS = 14_000

/** Characters of one page's text, so a single talkative page cannot eat the budget. */
const MAX_PAGE_CHARS = 2_400

/** Below this the class has simply not been recorded enough to summarize. */
const MIN_INPUT_CHARS = 40

const SUMMARY_MAX_TOKENS = 4096

export const SUMMARY_SYSTEM_PROMPT = [
  '你是一位中国大学的助教，负责把一节课的课堂记录整理成课程纪要。',
  '输入是课件的每一页（页码、标题、关键词）和这一页的课堂原始讲话。讲话是语音识别的口语稿：有错字、断句乱、口头语多，请按上下文改正后再理解，不要照抄病句。',
  '',
  '输出 Markdown，结构固定，不要写别的东西：',
  '## 一句话概括',
  '一句话说明这节课的主题和落点。',
  '## 这节课讲了什么',
  '按讲课顺序 3–8 条，每条一句话到两句话，讲清概念、方法、例子之间的关系（谁引出谁、为什么需要它）。',
  '## 重点与易错',
  '2–5 条：老师反复强调的、容易混的、带数字或公式的结论。',
  '## 复习清单',
  '3–6 条可以自测的问句或动作（例如「能自己推一遍… 吗」）。',
  '',
  '要求：',
  '- 只依据给出的内容，不许补充课件和讲话里没有的知识；拿不准的地方就写得概括些，不要编造。',
  '- 课件是英文时，术语保留英文原词，后面用括号给中文（backpropagation（反向传播））。',
  '- 去掉「嗯、对吧、这个、我们来看」这类口头语，也不要写「老师说」「本页讲了」这种元叙述，直接陈述知识。',
  '- 页数多时合并同一主题，不要一页一条地流水账。',
  '- 全文 400–800 字，中文。',
  '- 不要用代码块包裹整篇输出。',
].join('\n')

/** One page's block of the prompt, already trimmed to its budget. */
function pageBlock(slide, limit) {
  const note = slideNote(slide).replace(/\s+/g, ' ').trim()
  const text = note.length > limit ? `${note.slice(0, limit)}…` : note
  const keywords = slide.keywords.length === 0 ? '' : `关键词：${slide.keywords.join('、')}`
  const heading = `【第 ${slide.index} 页${slide.title === '' ? '' : ` · ${slide.title}`}】`
  return [heading, keywords, text === '' ? '（这页没有录音）' : text].filter((line) => line !== '').join('\n')
}

/**
 * Build the single user message. Pages that carry text are the only ones worth
 * sending; the rest are skipped so the model sees a tight transcript.
 */
export function buildSummaryPrompt(session) {
  const slides = (session.slides ?? []).filter((slide) => slideNote(slide).trim() !== '')
  const perPage = Math.min(MAX_PAGE_CHARS, Math.max(400, Math.floor(MAX_INPUT_CHARS / Math.max(1, slides.length))))
  const blocks = []
  let used = 0
  for (const slide of slides) {
    const block = pageBlock(slide, perPage)
    if (used + block.length > MAX_INPUT_CHARS && blocks.length > 0) break
    blocks.push(block)
    used += block.length
  }
  const head = [
    `课程：${session.title === '' ? '未命名听课' : session.title}${session.course === '' ? '' : `（${session.course}）`}`,
    `日期：${session.date}`,
    `课件共 ${(session.slides ?? []).length} 页，其中 ${slides.length} 页有课堂内容。`,
    '',
  ].join('\n')
  return `${head}${blocks.join('\n\n')}`
}

/** Strip the fences models like to add and normalize line endings. */
export function parseSummaryMarkdown(text) {
  let body = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  const fenced = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fenced !== null) body = fenced[1].trim()
  if (body.startsWith('```')) body = body.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  return body
}

/** How much lecture text this session actually carries. */
export function summarySourceChars(session) {
  let total = 0
  for (const slide of session.slides ?? []) total += slideNote(slide).trim().length
  return total
}

/**
 * Ask the model for the recap.
 *
 * Never throws for the ordinary failures (no model, too little content, model
 * error): the caller stores `error` next to the recap so the panel can show it
 * without losing the session.
 *
 * @returns {Promise<{markdown: string, model: string, error: string}>}
 */
export async function summarizeSession({ session, llm, route, signal, logger }) {
  const chars = summarySourceChars(session)
  if (chars < MIN_INPUT_CHARS) {
    return { markdown: '', model: '', error: '这节课的录音还太少，先记一点再来总结' }
  }
  if (llm === null || llm === undefined) {
    return { markdown: '', model: '', error: '没有接上模型，先在设置里选一个默认模型' }
  }
  const target = route ?? {}
  if (target.provider == null && target.model == null) {
    return { markdown: '', model: '', error: '没有接上模型，先在设置里选一个默认模型' }
  }
  const modelLabel = target.model == null ? '' : String(target.model)
  try {
    const raw = await askModel({
      llm,
      route: target,
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: buildSummaryPrompt(session),
      signal,
      timeoutMessage: '总结超时了（模型两分钟没回完），等一下再试',
      failurePrefix: '总结失败：',
      maxTokens: SUMMARY_MAX_TOKENS,
    })
    const markdown = parseSummaryMarkdown(raw)
    if (markdown === '') return { markdown: '', model: modelLabel, error: '模型返回了空内容，再试一次' }
    return { markdown, model: modelLabel, error: '' }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    logger?.warn?.('class-notes: summary failed for %s: %s', session.id, String(error?.message ?? error))
    return { markdown: '', model: modelLabel, error: String(error?.message ?? error) }
  }
}
