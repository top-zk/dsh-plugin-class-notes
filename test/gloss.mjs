/**
 * Unit test: a Chinese lecture has to match an English deck.
 *
 * The teacher says 反向传播 while the slide says backpropagation; without the
 * Chinese gloss the tracker has nothing to match and the page never turns.
 *
 *   node test/gloss.mjs
 */
import {
  GLOSS_SYSTEM_PROMPT,
  buildGlossPrompt,
  englishGlossFor,
  glossaryGloss,
  glossDeckKeywords,
  needGloss,
  parseGlossJson,
} from '../lib/keywords.js'
import { normalizeSession, normalizeSlide } from '../lib/model.js'
import { evaluateChunk, scoreSlide } from '../lib/tracker.js'
import { normalizeForMatch } from '../lib/keywords.js'

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** A model that answers with whatever the test wants. */
function fakeLlm(answerFor) {
  const prompts = []
  return {
    prompts,
    async prepareCall() {
      return {
        config: {},
        stream(request) {
          const prompt = request.messages[0].content[0].text
          prompts.push(prompt)
          const text = answerFor(prompt)
          return (async function* stream() {
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

const SLIDES = [
  { index: 1, title: 'Lecture 5: Backpropagation', keywords: ['backpropagation', 'chain rule', 'gradient descent', 'ReLU'] },
  { index: 2, title: 'Loss and error', keywords: ['mean squared error', 'MSE', 'learning rate'] },
  { index: 3, title: 'Overfitting', keywords: ['overfitting', 'regularization', 'dropout'] },
]

// ── glossary ───────────────────────────────────────────────────────────────
check(glossaryGloss('backpropagation') === '反向传播', 'glossary: backpropagation', glossaryGloss('backpropagation'))
check(glossaryGloss('Mean Squared Error') === '均方误差', 'glossary: case/space insensitive', glossaryGloss('Mean Squared Error'))
check(glossaryGloss('Arthur Samuel') === '', 'glossary: a person has no gloss')
check(glossaryGloss('backpropagation!') === '反向传播', 'glossary: strips punctuation', glossaryGloss('backpropagation!'))

// ── JSON parsing ───────────────────────────────────────────────────────────
const parsed = parseGlossJson(
  '```json\n{"slides":[{"index":1,"titleZh":"反向传播","glosses":{"backpropagation":"反向传播","ReLU":"ReLU"}},{"index":2,"glosses":{"MSE":"均方误差"}}]}\n```',
)
check(parsed.length === 2, 'parse: two slides', String(parsed.length))
check(parsed[0]?.titleZh === '反向传播', 'parse: title gloss', parsed[0]?.titleZh)
check(parsed[0]?.glosses?.ReLU === undefined, 'parse: identity gloss dropped')
check(parsed[1]?.glosses?.MSE === '均方误差', 'parse: gloss kept', JSON.stringify(parsed[1]?.glosses))

// ── no model: glossary only ────────────────────────────────────────────────
const offline = await glossDeckKeywords({ slides: SLIDES })
check(offline.source === 'glossary', 'offline: source is glossary', offline.source)
check(offline.slides[0].glosses.backpropagation === '反向传播', 'offline: slide 1 gloss', JSON.stringify(offline.slides[0].glosses))
check(offline.slides[1].glosses['mean squared error'] === '均方误差', 'offline: multi-word term', JSON.stringify(offline.slides[1].glosses))

// ── with a model ───────────────────────────────────────────────────────────
const llm = fakeLlm(() =>
  JSON.stringify({
    slides: [
      { index: 1, titleZh: '反向传播', glosses: { backpropagation: '反向传播', 'chain rule': '链式法则' } },
      { index: 3, glosses: { overfitting: '过拟合', dropout: '随机失活', regularization: '正则化' } },
    ],
  }),
)
const online = await glossDeckKeywords({ slides: SLIDES, llm, route: { provider: 'p', model: 'm' } })
check(online.source === 'llm', 'model: source is llm', online.source)
check(online.slides[0].titleZh === '反向传播', 'model: title gloss flows through', online.slides[0].titleZh)
check(online.slides[0].glosses['chain rule'] === '链式法则', 'model: chain rule', JSON.stringify(online.slides[0].glosses))
// The glossary entries the model did not repeat are still there.
check(online.slides[0].glosses['gradient descent'] === '梯度下降', 'model: glossary survives', JSON.stringify(online.slides[0].glosses))
check(llm.prompts[0].includes('backpropagation'), 'model: prompt lists the keywords', llm.prompts[0].slice(0, 80))
check(buildGlossPrompt(SLIDES.slice(0, 1)).includes('第 1 页'), 'prompt: has slide headers')

const broken = await glossDeckKeywords({
  slides: SLIDES,
  llm: fakeLlm(() => 'sorry, I cannot help with that'),
  route: { provider: 'p', model: 'm' },
})
check(broken.source === 'glossary', 'model: junk answer falls back to glossary', broken.source)
check(broken.error === '', 'model: junk answer is not an error', broken.error)

// ── scoring: sliding the Chinese wording in ────────────────────────────────
const slide = normalizeSlide({
  index: 1,
  title: SLIDES[0].title,
  keywords: SLIDES[0].keywords,
  keywordGlosses: {
    backpropagation: '反向传播',
    'chain rule': '链式法则',
    'gradient descent': '梯度下降',
  },
}, 1)

const english = scoreSlide(slide, normalizeForMatch('ok so backpropagation uses the chain rule here'))
const chinese = scoreSlide(slide, normalizeForMatch('这里用到的就是反向传播，靠链式法则一层层往回算'))
const neither = scoreSlide(slide, normalizeForMatch('大家先看这张图的颜色分布'))
check(english.score > 0, 'score: English speech still matches', String(english.score))
check(chinese.score > 0, 'score: Chinese speech matches an English deck', String(chinese.score))
check(chinese.hits.includes('反向传播'), 'score: hit reported in Chinese', chinese.hits.join(','))
check(neither.score === 0, 'score: unrelated speech scores nothing', String(neither.score))

// One term spoken in both spellings must not count twice.
const both = scoreSlide(slide, normalizeForMatch('反向传播 backpropagation'))
check(both.score === Math.max(
  scoreSlide(slide, normalizeForMatch('反向传播')).score,
  scoreSlide(slide, normalizeForMatch('backpropagation')).score,
), 'score: same term counted once', String(both.score))

// ── tracker: a Chinese lecture turns an English deck ───────────────────────
const session = normalizeSession({
  id: 'cls-gloss-1',
  title: 'English deck',
  slides: [
    normalizeSlide({ ...SLIDES[0], index: 1 }, 1),
    normalizeSlide({ index: 2, title: 'Regularization', keywords: ['regularization', 'weight decay', 'L2 norm'] }, 2),
    normalizeSlide({ index: 3, title: 'Optimizers', keywords: ['momentum', 'Adam', 'batch size'] }, 3),
  ],
  recording: { currentIndex: 1 },
})
session.slides[0].keywordGlosses = { backpropagation: '反向传播', 'chain rule': '链式法则', 'gradient descent': '梯度下降' }
session.slides[1].keywordGlosses = { regularization: '正则化', 'weight decay': '权重衰减' }
session.slides[2].keywordGlosses = { momentum: '动量法', 'batch size': '批大小' }

const lines = [
  '今天这节课我们讲反向传播，靠链式法则一层层往回算',
  '这套做法在梯度下降里就要用到反向传播',
  '讲完这个我们看正则化，也叫做权重衰减',
  '正则化的目的就是压住参数，别让它长得太大',
  '最后说说动量法，还有批大小怎么定',
  '动量法可以让训练更稳，批大小决定每一轮看多少条数据',
]
let state = session
let turns = 0
const places = []
for (const [position, line] of lines.entries()) {
  const decision = evaluateChunk({
    session: state,
    tracker: state.tracker,
    chunk: line,
    now: 1_000_000 + position * 5_500,
  })
  state.tracker = decision.tracker
  state.recording.currentIndex = decision.index
  if (decision.advance) {
    turns += 1
    places.push(decision.index)
  }
}
check(turns >= 2, 'tracker: Chinese lecture turns the English deck', `turns=${turns} at ${places.join('→')}`)
check(places[0] === 2, 'tracker: first turn lands on slide 2', String(places[0]))

// Without glosses the same lecture turns nothing: that is the bug this fixes.
const bald = normalizeSession({
  ...session,
  slides: session.slides.map((item) => normalizeSlide({ index: item.index, title: item.title, keywords: item.keywords }, item.index)),
})
let baldTurns = 0
let baldState = bald
for (const [position, line] of lines.entries()) {
  const decision = evaluateChunk({
    session: baldState,
    tracker: baldState.tracker,
    chunk: line,
    now: 1_000_000 + position * 5_500,
  })
  baldState.tracker = decision.tracker
  if (decision.advance) baldTurns += 1
}
check(baldTurns === 0, 'tracker: no glosses, no page turns', `turns=${baldTurns}`)

check(GLOSS_SYSTEM_PROMPT.includes('glosses'), 'prompt: system prompt describes the JSON')

// ── an all-Chinese deck needs no translation at all ────────────────────────
check(needGloss([{ keywords: ['机器学习', '监督学习'] }]) === false, 'needGloss: Chinese deck skips')
check(needGloss([{ keywords: ['机器学习', 'CNN'] }]) === true, 'needGloss: one Latin term asks')
const skippedLlm = fakeLlm(() => '{"slides":[]}')
const chineseDeck = await glossDeckKeywords({
  slides: [{ index: 1, title: '机器学习', keywords: ['机器学习', '监督学习'] }],
  llm: skippedLlm,
  route: { provider: 'p', model: 'm' },
})
check(skippedLlm.prompts.length === 0, 'Chinese deck: no model call at all', String(skippedLlm.prompts.length))
check(chineseDeck.error === '', 'Chinese deck: no error', chineseDeck.error)

// ── the mirror direction: an English lecture over a Chinese deck ───────────
check(englishGlossFor('反向传播') === 'backpropagation', 'mirror: 反向传播', englishGlossFor('反向传播'))
check(englishGlossFor('backpropagation') === '', 'mirror: Latin term needs no English gloss')
check(englishGlossFor('张三') === '', 'mirror: a person has no gloss')

const chineseSlides = [
  { index: 1, title: '第 5 讲 反向传播', keywords: ['反向传播', '链式法则', '梯度下降', '激活函数'] },
  { index: 2, title: '过拟合', keywords: ['过拟合', '正则化', '权重衰减'] },
  { index: 3, title: '优化器', keywords: ['动量法', '批大小', '学习率'] },
]
const mirrorOffline = await glossDeckKeywords({ slides: chineseSlides, direction: 'toEn' })
check(mirrorOffline.direction === 'toEn', 'mirror: direction kept', mirrorOffline.direction)
check(
  mirrorOffline.slides[0].glosses['反向传播'] === 'backpropagation',
  'mirror offline: glossary answers in English',
  JSON.stringify(mirrorOffline.slides[0].glosses),
)
check(needGloss([{ keywords: ['反向传播'] }], 'toEn') === true, 'mirror: Chinese deck needs a pass')
check(needGloss([{ keywords: ['backpropagation'] }], 'toEn') === false, 'mirror: English deck needs none')

const mirrorLlm = fakeLlm(() =>
  JSON.stringify({ slides: [{ index: 1, titleEn: 'Backpropagation', glosses: { 反向传播: 'backpropagation', 链式法则: 'chain rule' } }] }),
)
const mirrorOnline = await glossDeckKeywords({ slides: chineseSlides, llm: mirrorLlm, route: { provider: 'p', model: 'm' }, direction: 'toEn' })
check(mirrorOnline.slides[0].titleEn === 'Backpropagation', 'mirror model: English title', mirrorOnline.slides[0].titleEn)
check(mirrorLlm.prompts[0].includes('对反向传播') === false && mirrorLlm.prompts[0].includes('反向传播'), 'mirror model: Chinese terms in the prompt')
check(mirrorLlm.prompts[0].includes('Terms needing an English gloss'), 'mirror model: English prompt')

// A mixed lecture wants both spellings on the same slide.
const mixed = await glossDeckKeywords({
  slides: [{ index: 1, title: 'CNN 与反向传播', keywords: ['backpropagation', '反向传播', 'dropout'] }],
  direction: 'both',
})
check(mixed.direction === 'both', 'mixed: direction kept', mixed.direction)
check(mixed.slides[0].glosses.backpropagation === '反向传播', 'mixed: English term gets Chinese', JSON.stringify(mixed.slides[0].glosses))
check(mixed.slides[0].glosses['反向传播'] === 'backpropagation', 'mixed: Chinese term gets English', JSON.stringify(mixed.slides[0].glosses))

// And the tracker: English speech turns a Chinese deck only with the gloss.
const cnSession = normalizeSession({
  id: 'cls-gloss-2',
  title: '中文课件',
  slides: [
    normalizeSlide({ index: 1, title: '反向传播', keywords: ['反向传播', '链式法则', '梯度下降'], keywordGlosses: { 反向传播: 'backpropagation', 链式法则: 'chain rule', 梯度下降: 'gradient descent' } }, 1),
    normalizeSlide({ index: 2, title: '过拟合', keywords: ['过拟合', '正则化', '权重衰减'], keywordGlosses: { 过拟合: 'overfitting', 正则化: 'regularization', 权重衰减: 'weight decay' } }, 2),
  ],
  recording: { currentIndex: 1 },
})
const englishLines = [
  'so this is backpropagation, and it is built on the chain rule',
  'backpropagation gives you the gradient descent direction',
  'now let us talk about overfitting',
  'we control overfitting with regularization, also called weight decay',
  'weight decay is a form of regularization',
]
let cnState = cnSession
const cnPlaces = []
englishLines.forEach((line, position) => {
  const decision = evaluateChunk({ session: cnState, tracker: cnState.tracker, chunk: line, now: 1_000_000 + position * 5_500 })
  cnState.tracker = decision.tracker
  cnState.recording.currentIndex = decision.index
  if (decision.advance) cnPlaces.push(decision.index)
})
check(cnPlaces[0] === 2, 'mirror tracker: English lecture turns a Chinese deck', cnPlaces.join('->') || 'no turns')

const baldCn = normalizeSession({
  ...cnSession,
  slides: cnSession.slides.map((item) => normalizeSlide({ index: item.index, title: item.title, keywords: item.keywords }, item.index)),
})
let baldPlaces = 0
let baldCnState = baldCn
englishLines.forEach((line, position) => {
  const decision = evaluateChunk({ session: baldCnState, tracker: baldCnState.tracker, chunk: line, now: 1_000_000 + position * 5_500 })
  baldCnState.tracker = decision.tracker
  if (decision.advance) baldPlaces += 1
})
check(baldPlaces === 0, 'mirror tracker: without glosses nothing turns', `turns=${baldPlaces}`)

console.log(failures === 0 ? '\nall gloss checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
