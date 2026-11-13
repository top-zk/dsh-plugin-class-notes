/**
 * Render smoke test for the browser half without a browser.
 *
 * The panel blanked once because a component referenced a variable that was
 * never declared (`glossPending`): only the render path sees it, so `node --check`
 * stays green. This harness loads `lib/client.js` through a fake
 * `window.__ModuleLoader__`, feeds it a tiny React shim, and renders every slot
 * component against realistic sessions — empty, drafted, imported, recording,
 * finished — plus the shells that wrap them.
 *
 *   node test/render-client.mjs
 */
import { readFile } from 'node:fs/promises'

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── a React small enough for a component tree ─────────────────────────────
// The module grabs the hooks once, at load time, so the store's `useSnapshot`
// seed has to be intercepted from inside this shim: `store.injected` is the
// store's own snapshot object, `store.current` is the state under test.
const store = { injected: null, current: null }
const states = []
let cursor = 0
const hooks = () => {
  const index = cursor
  return {
    use: (initial) => {
      if (states[index] === undefined) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      cursor += 1
      return states[index].value
    },
  }
}
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
    // React puts children on props; the tree walker below reads them from there.
    return { type, props: flat.length === 0 ? (props ?? {}) : { ...(props ?? {}), children: flat }, children: flat }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const slot = hooks().use(initial)
    if (initial !== null && typeof initial === 'object') {
      // The store's `snapshot` is the only object-shaped useState seed.
      if (store.injected === null) store.injected = initial
      if (initial === store.injected) return [store.current ?? initial, () => {}]
    }
    return [slot, () => {}]
  },
  useRef(initial) {
    if (states[cursor] === undefined) states[cursor] = { current: initial }
    const slot = states[cursor]
    cursor += 1
    return slot
  },
  useEffect() { cursor += 1 },
  useLayoutEffect() { cursor += 1 },
  useMemo(factory) { cursor += 1; return factory() },
  useCallback(fn) { cursor += 1; return fn },
  createContext(value) { return { Provider: 'Provider', _value: value } },
  useContext() { return {} },
}

const instances = []
const cssChunks = []
const registry = new Map()
const globalState = {
    document: {
      head: { appendChild: (node) => { cssChunks.push(String(node.textContent ?? '')) } },
      createElement: (tag) => ({
        tag,
        children: [],
        dataset: {},
        textContent: '',
        appendChild(text) { this.children.push(text) },
        setAttribute() {},
      }),
      querySelector: () => null,
      getElementById: () => null,
      body: { appendChild() {} },
    },
  navigator: { mediaDevices: {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  fetch: async () => { throw new Error('network is off in the render harness') },
  localStorage: { getItem: () => null, setItem() {} },
}

/** Every Button in the tree labelled exactly `label` (buttons are host-looking
 *  components whose children hold the caption). */
function hasButtonLabel(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((item) => hasButtonLabel(item, label))
  const children = node.children ?? []
  if (textOf({ children }).trim() === label && children.some((item) => typeof item === 'string')) return true
  return children.some((item) => hasButtonLabel(item, label))
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return render(node)
  return node.children.map(textOf).join(' ')
}

function render(node) {
  const saved = cursor
  cursor = 0
  let out
  try {
    out = textOf(node.type(node.props))
  } finally {
    cursor = saved
  }
  return out
}

function makeContext(key, label) {
  const instance = { key, label, options: null, component: null }
  instances.push(instance)
  const ctx = {
    slots: {
      register(options, component) {
        instance.options = options
        instance.component = component
        return () => {}
      },
      inject: (slot, fn) => {
        if (slot !== key) return () => {}
        return fn(ctx)
      },
    },
    layout: { selectPanel() {} },
    effect() {},
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined },
  }
  return ctx
}

globalThis.window = globalThis
// `navigator` is a getter on modern Node: define it instead of assigning.
for (const [name, value] of Object.entries(globalState)) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

// `CLASS_NOTES_CLIENT` lets the harness point at a scratch copy, which is how the
// `glossPending` regression gets proven to fail here.
const clientPath = process.env.CLASS_NOTES_CLIENT ?? new URL('../lib/client.js', import.meta.url)
const source = await readFile(clientPath, 'utf8')
let loaded = null
globalThis.__ModuleLoader__ = {
  load(entry) {
    const module = { exports: {} }
    const requireFn = (id) => {
      if (id === 'react') return React
      throw new Error(`client asked for unexpected module ${id}`)
    }
    loaded = entry.factory(requireModule(module, requireFn))
  },
}
function requireModule(module, requireFn) {
  // The factory declares its own `module`/`exports`/`require`; this is only a
  // safety net for the case where it uses the outer ones.
  return requireFn
}
try {
  new Function('window', 'module', 'exports', 'require', source)(globalThis, { exports: {} }, {}, (id) => {
    if (id === 'react') return React
    throw new Error(`client asked for unexpected module ${id}`)
  })
} catch (error) {
  // The real loader path is the one below; this is a fallback for older layouts.
  loaded = null
}
check(loaded !== null, 'client loads through __ModuleLoader__', loaded === null ? 'factory did not run' : '')

const clientExports = loaded ?? {}
check(typeof clientExports.apply === 'function', 'exports.apply exists')

// Register every slot the plugin offers.
const slots = [
  ['sidebar.panellist', 'sidebar'],
  ['main', 'panel'],
  ['shell.overlay', 'overlay'],
]
for (const [key, label] of slots) {
  try {
    clientExports.apply?.(makeContext(key, label))
  } catch (error) {
    check(false, `apply(${key})`, String(error?.message ?? error))
  }
}
check(instances.filter((item) => item.component !== null).length === slots.length, 'all slots registered',
  `${instances.filter((item) => item.component !== null).length}/${slots.length}`)
check(cssChunks.some((chunk) => chunk.includes('.dcn-shell')), 'style injection ran', `${cssChunks.length} chunk(s)`)

// ── realistic session shapes ───────────────────────────────────────────────
// Point the store hook at the state under test; `snapshots` is consumed by the
// React shim above, which is the only place the module's hooks are bound.
const setSnapshot = (value) => { store.current = value }

function slide(index, extra = {}) {
  return {
    index,
    title: `第 ${index} 页`,
    body: '正文',
    notes: '',
    keywords: ['backpropagation', '反向传播', '梯度下降'],
    keywordsZh: ['反向传播'],
    keywordGlosses: { backpropagation: '反向传播' },
    keywordSource: 'llm',
    segments: [{ at: '2026-11-10T00:00:00.000Z', text: '老师说的一段话', score: 2.1, manual: false }],
    note: '老师说的一段话',
    segmentCount: 1,
    hitCount: 1,
    ...extra,
  }
}
const meta = {
  fileName: 'demo.pptx',
  sourcePath: '',
  slideWidth: 12192000,
  slideHeight: 6858000,
  keywordsAt: '2026-11-10T00:00:00.000Z',
  keywordsModel: 'p/m',
  keywordsError: '',
  glossAt: '2026-11-10T00:00:00.000Z',
  glossDirection: 'toZh',
  glossModel: 'p/m',
  glossError: '',
  importKind: 'pptx',
  pdfPages: 0,
  pdfRenderedPages: 0,
  pdfWarning: '',
}
const baseSession = {
  id: 'cls-render-1',
  title: '渲染测试',
  course: '联调',
  date: '2026-11-10',
  asrMode: 'zh',
  status: 'ready',
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  finishedAt: null,
  meta,
  slides: [slide(1), slide(2)],
  recording: { active: false, currentIndex: 1, startedAt: null, stoppedAt: null, chunks: 3, audioSeconds: 15, advances: 0 },
  tracker: {
    history: [{ at: '2026-11-10T00:00:00.000Z', text: '老师说的一段话', slideIndex: 1, score: 2, aheadIndex: 2, aheadScore: 0, aheadSpecificScore: 0, evidenceScore: 2, hits: ['backpropagation'], aheadHits: [] }],
    streak: 0,
    lastAdvanceAt: null,
    lastDecision: {
      at: '2026-11-10T00:00:00.000Z',
      currentIndex: 1,
      nextIndex: 2,
      here: 2.1,
      ahead: 0,
      aheadSpecific: 0,
      windowAhead: 0,
      streak: 0,
      dwellMs: 20000,
      advance: false,
      reason: '还在讲这一页',
      hereHits: ['反向传播'],
      aheadHits: [],
      carryCount: 1,
    },
    pending: [],
  },
  transcript: '',
  summary: { at: null, model: '', markdown: '', error: '' },
  progress: { slides: 2, noted: 1, chars: 10, keywords: 6, advances: 0 },
}
const variants = {
  empty: { ...baseSession, slides: [], meta: { ...meta, fileName: '', keywordsAt: null, glossAt: null } },
  draft: { ...baseSession, slides: [], status: 'draft', meta: { ...meta, fileName: '', keywordsAt: null, glossAt: null } },
  ready: baseSession,
  // Re-recognized keywords: the translations were dropped, and the last pass failed.
  noGloss: {
    ...baseSession,
    slides: [slide(1, { keywordGlosses: {}, keywordsZh: [] }), slide(2, { keywordGlosses: {}, keywordsZh: [] })],
    meta: { ...meta, glossAt: null, glossDirection: '', glossError: '补中文说法失败：timeout' },
  },
  mixed: { ...baseSession, asrMode: 'mixed' },
  english: { ...baseSession, asrMode: 'en' },
  pdf: { ...baseSession, meta: { ...meta, importKind: 'pdf', pdfPages: 9, pdfRenderedPages: 9, pdfWarning: '页面渲染没成功' } },
  recording: { ...baseSession, status: 'recording', recording: { ...baseSession.recording, active: true, startedAt: '2026-11-10T00:00:00.000Z' } },
  done: { ...baseSession, status: 'done', finishedAt: '2026-11-10T01:00:00.000Z' },
  legacy: { ...baseSession, status: 'done', finishedAt: undefined },
  // An AI recap is already in hand: the card shows the Markdown, not the hint.
  summarized: {
    ...baseSession,
    summary: {
      at: '2026-11-10T02:00:00.000Z',
      model: 'juflow · m',
      markdown: [
        '## 一句话概括',
        '这节课讲线性回归怎么用**均方误差**衡量好坏。',
        '## 重点与易错',
        '- 梯度方向是负梯度，别记反。',
        '## 复习清单',
        '1. 自己推一遍闭式解。',
      ].join('\n'),
      error: '',
    },
  },
}

const snapshots = [
  { label: 'loading', value: { status: 'loading', data: null, sessions: [], selectedId: null, session: null, busy: null, speech: null, live: { status: 'idle', chunks: 0, silent: 0, inFlight: 0, lastText: '', error: '', startedAt: 0, level: 0 }, toasts: [] } },
  { label: 'error', value: { status: 'error', error: '连接不上', data: null, sessions: [], session: null, busy: null, speech: null, live: { status: 'idle' }, toasts: [] } },
]

for (const [name, session] of Object.entries(variants)) {
  const installed = new Set()
  const install = () => {
    for (const listener of states.flatMap(() => [])) void listener
  }
  snapshots.push({
    label: name,
    value: {
      status: 'ready',
      error: '',
      data: {
        now: '2026-11-10T05:00:00.000Z',
        today: '2026-11-10',
        clock: '2026-11-10 13:00:00',
        dataDir: 'C:\\data',
        workspace: 'C:\\ws',
        speech: { available: true, providers: [{ id: 'p', name: 'SenseVoice', languages: ['auto', 'zh'], phase: 'ready' }], phase: 'ready', message: '', progress: null, error: '' },
        llm: { provider: 'juflow', model: 'm', label: 'juflow · m' },
        pdf: { rasterizer: true },
        asrModes: [{ id: 'zh', label: '中文', hint: '纯中文' }, { id: 'mixed', label: '中英混合', hint: '夹英文' }, { id: 'en', label: 'English', hint: '全英文' }],
      },
      sessions: [{ id: session.id, title: session.title, course: session.course, date: session.date, status: session.status, updatedAt: session.updatedAt, createdAt: session.createdAt, slideCount: session.slides.length, notedCount: 1, keywordCount: 6, hasPptx: true, finishedAt: session.finishedAt ?? null, asrMode: session.asrMode }],
      selectedId: session.id,
      session,
      sessionLoading: false,
      busy: null,
      speech: { available: true, phase: 'ready', providers: [], error: '' },
      speechPreparing: false,
      exportResult: {
        id: session.id,
        downloads: {
          pptx: '/dsh-class-notes/sessions/x/file?name=a.pptx',
          md: '/dsh-class-notes/sessions/x/file?name=a.md',
          ...(session.summary?.markdown ? { summary: '/dsh-class-notes/sessions/x/file?name=recap.md' } : {}),
        },
        local: { pptx: 'C:\\ws\\a.pptx' },
      },
      toasts: [{ id: 't1', level: 'success', title: '好了', body: '导出了', at: Date.now() }],
      live: {
        status: session.status === 'recording' ? 'recording' : 'idle',
        sessionId: session.id,
        startedAt: Date.now() - 65000,
        level: 0.4,
        chunks: 3,
        silent: 1,
        inFlight: 1,
        lastText: '老师说的一段话',
        error: '',
        flushes: 4,
      },
    },
  })
  void installed
  void install
}

// Feed a snapshot into the store by driving a committed state through the
// component's own hook slot: the store module owns `snapshot`, so instead of
// reaching into it we render once per snapshot via a replaced hook value.
let rendered = 0
for (const entry of snapshots) {
  for (const instance of instances) {
    if (instance.component === null) continue
    states.length = 0
    setSnapshot(entry.value)
    try {
      const text = render({ type: instance.component, props: { clientContext: { layout: { selectPanel() {} } } }, children: [] })
      rendered += 1
      // The panel always says something; the sidebar glyph is an SVG and the
      // overlay is empty when there is no toast, so only the panel is checked.
      if (instance.label === 'panel' && text.trim() === '') check(false, `${entry.label}/panel renders nothing`)
    } catch (error) {
      check(false, `${entry.label}/${instance.label}`, String(error?.message ?? error))
    }
  }
}
check(rendered > 0, 'components rendered', `${rendered} render(s)`)

// The four steps must really be in the tree — a crash inside one of the cards
// (which is exactly what `glossPending` did) otherwise hides behind the others.
const readyEntry = snapshots.find((entry) => entry.label === 'ready')
// The name a component was registered under is its readable label.
const registered = instances.filter((item) => item.component !== null)
const panelInstance = registered.find((item) => item.options?.name === 'main')
if (readyEntry !== undefined && panelInstance?.component) {
  states.length = 0
  setSnapshot(readyEntry.value)
  let text;
  try {
    text = render({ type: panelInstance.component, props: { clientContext: { layout: { selectPanel() {} } } }, children: [] })
  } catch (error) {
    check(false, 'panel renders a full session', String(error?.message ?? error))
    text = ''
  }
  for (const phrase of ['① 放课件', '② 认出每页的关键词', '③ 开始记', '④ 导出笔记', '结束转录']) {
    check(text.includes(phrase), `panel shows ${phrase}`)
  }
  // A collapsed slide row only shows the count; the chips and their glosses live inside the open row.
check(text.includes('backpropagation'), 'panel shows the first slide keywords', 'collapsed row shows counts only')
  const noGlossText = (() => {
    const entry = snapshots.find((item) => item.label === 'noGloss')
    states.length = 0
    setSnapshot(entry.value)
    return render({ type: panelInstance.component, props: { clientContext: { layout: { selectPanel() {} } } }, children: [] })
  })()
  check(noGlossText.includes('中文说法在排队'), 'panel says the gloss pass is queued')
  check(noGlossText.includes('这轮没补全'), 'panel surfaces glossError')

  // The麦克风 is bound to one lesson: looking at another class while A records
  // must not show A's clock or a "停止" button that would stop A from here.
  let lastTree
  const elsewhereText = (() => {
    const source = snapshots.find((item) => item.label === 'ready')
    const borrowed = { ...source.value }
    borrowed.live = { ...borrowed.live, status: 'recording', sessionId: 'cls-someone-else', startedAt: Date.now() - 65000 }
    borrowed.sessions = [...borrowed.sessions, { id: 'cls-someone-else', title: '另一节课', status: 'recording', slideCount: 9, notedCount: 0, keywordCount: 0 }]
    states.length = 0
    setSnapshot(borrowed)
    lastTree = panelInstance.component({ clientContext: { layout: { selectPanel() {} } }, children: [] })
    return textOf(lastTree)
  })()
  check(elsewhereText.includes('正在记另一节'), 'panel names the lesson that owns the mic')
  check(!hasButtonLabel(lastTree, '停止'), 'panel offers no stop button for another lesson')
  check(elsewhereText.includes('一节只能录一节'), 'panel explains why recording is blocked here')

  // The recap card: empty state offers the button, a written recap renders its
  // Markdown sections (headings, bold, bullet, numbered list) instead.
  check(text.includes('⑤ AI 纪要'), 'panel shows the recap card')
  check(text.includes('总结这节课'), 'recap card offers the button before any recap')
  const recapText = (() => {
    const entry = snapshots.find((item) => item.label === 'summarized')
    states.length = 0
    setSnapshot(entry.value)
    return textOf(panelInstance.component({ clientContext: { layout: { selectPanel() {} } }, children: [] }))
  })()
  check(recapText.includes('⑤ AI 纪要'), 'recap card present for a summarized class')
  check(recapText.includes('一句话概括'), 'recap shows the summary heading', recapText.slice(0, 80))
  check(recapText.includes('这节课讲线性回归怎么用'), 'recap shows its body text')
  check(recapText.includes('均方误差'), 'recap shows the bold phrase inside the paragraph')
  check(recapText.includes('梯度方向是负梯度，别记反。'), 'recap shows bullet items')
  check(recapText.includes('自己推一遍闭式解。'), 'recap shows numbered items')
  check(recapText.includes('重新总结'), 'recap card switches its button to re-summarize')
  check(recapText.includes('下载纪要'), 'recap card links the exported recap')

  // Progress is per class. A pass running on another class must leave this one's
  // buttons alone — and this class's own pass must still show on its button.
  const otherBusyText = (() => {
    const source = snapshots.find((item) => item.label === 'ready')
    const borrowed = { ...source.value }
    borrowed.busy = { id: 'cls-someone-else', kind: 'summary' }
    borrowed.exportResult = { id: 'cls-someone-else', downloads: { pptx: '/x/a.pptx' }, target: 'C:\\other', notesWritten: 3, at: 1 }
    states.length = 0
    setSnapshot(borrowed)
    return textOf(panelInstance.component({ clientContext: { layout: { selectPanel() {} } }, children: [] }))
  })()
  check(!otherBusyText.includes('正在整理…'), 'another class’s recap does not spin this one')
  check(otherBusyText.includes('总结这节课'), 'this class still offers its own recap button')
  check(!otherBusyText.includes('下载 PPTX'), 'another class’s export is not offered here')

  const ownBusyText = (() => {
    const source = snapshots.find((item) => item.label === 'ready')
    const own = { ...source.value }
    own.busy = { id: source.value.session.id, kind: 'summary' }
    states.length = 0
    setSnapshot(own)
    return textOf(panelInstance.component({ clientContext: { layout: { selectPanel() {} } }, children: [] }))
  })()
  check(ownBusyText.includes('正在整理…'), 'this class’s own recap shows on its button')

  // Switching classes: the old class's numbers must be gone while the next one loads.
  const switchingText = (() => {
    const source = snapshots.find((item) => item.label === 'ready')
    const switching = { ...source.value, session: null, sessionLoading: true, selectedId: 'cls-next' }
    setSnapshot(switching)
    return textOf(panelInstance.component({ clientContext: { layout: { selectPanel() {} } }, children: [] }))
  })()
  check(switchingText.includes('正在打开这节课'), 'switching classes shows a loading state')
  check(!switchingText.includes('① 放课件'), 'switching classes hides the previous class’s cards')
}

console.log(failures === 0 ? '\nall render checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
