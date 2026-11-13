/**
 * Browser half of the class-notes plugin (hand-written bundle).
 *
 * Three seats in the shipped web shell:
 * - `sidebar.panellist` — the slide + microphone glyph (red dot while recording),
 * - `main` key `class-notes` — the listening session: put in a deck, extract the
 *   page keywords, record the lecture, watch the pages turn by themselves, then
 *   export a .pptx whose speaker notes hold what was said on each page,
 * - `shell.overlay` — toasts.
 *
 * Data comes from the host half's loopback JSON API (`/dsh-class-notes`). The
 * bundle is dependency-free apart from React: every control is plain
 * `React.createElement`, and every colour is a `--dsw-alias-*` token so the
 * panel follows the light/dark shell.
 *
 * Audio pipeline (browser side), same shape as the meeting-minutes recorder:
 * getUserMedia → AudioContext → ScriptProcessor(4096) → streaming resampler →
 * 5 s PCM16 WAV chunks → POST /chunk, which transcribes the chunk, scores it
 * against the current and next page, and appends the text to that page's notes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-class-notes',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-class-notes'
    const TARGET_RATE = 16000
    /** Shown before `/state` answers; the host half sends the same list. */
    const DEFAULT_ASR_MODES = [
      { id: 'zh', label: '中文', hint: '只按中文转写' },
      { id: 'mixed', label: '中英混合', hint: '中文里夹的英文词跟着原样留下' },
      { id: 'en', label: 'English', hint: '整段按英文转写' },
    ]
    const LIVE_FLUSH_SECONDS = 5
    const LIVE_MIN_SECONDS = 1.2
    const SILENCE_PEAK = 0.0009
    const MAX_IN_FLIGHT = 2
    const TOAST_TTL_MS = 7000
    const SPEECH_POLL_MS = 15000

    const STATUS_LABELS = { draft: '待放课件', ready: '可以录音', recording: '正在记', done: '已结束' }
    const SOURCE_LABELS = { llm: '模型识别', heuristic: '按版面提取', manual: '手动编辑', pending: '待识别' }
    const PHASE_LABELS = {
      unprepared: '未准备',
      standby: '待命中',
      ready: '就绪',
      downloading: '下载模型',
      checking: '检查中',
      loading: '加载中',
      failed: '失败',
      cancelled: '已取消',
    }

    // ─────────────────────────────── style ────────────────────────────────

    const STYLE_TAG_ID = 'class-notes'

    const CSS = `
.dcn-shell{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dcn-side{width:264px;flex:0 0 264px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);min-height:0}
.dcn-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 14px 10px}
.dcn-side-title{font-size:14px;font-weight:600;letter-spacing:.02em}
.dcn-side-list{flex:1;min-height:0;overflow-y:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:4px}
.dcn-item{text-align:left;border:1px solid transparent;background:transparent;border-radius:10px;padding:9px 10px;cursor:pointer;color:inherit;font:inherit;display:flex;flex-direction:column;gap:3px}
.dcn-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcn-item--active{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.dcn-item-title{font-size:13px;font-weight:560;line-height:1.35;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcn-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center}
.dcn-main{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:18px 22px 40px}
.dcn-main-head{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.dcn-head-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dcn-title-input{font-size:17px;font-weight:600;background:transparent;border:1px solid transparent;border-radius:8px;padding:4px 6px;color:inherit;font-family:inherit;min-width:240px;flex:1}
.dcn-title-input:hover{border-color:var(--dsw-alias-border-l1)}
.dcn-title-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.dcn-steps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.dcn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px;min-width:0}
.dcn-card-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dcn-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}
.dcn-btn{font:inherit;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 11px;cursor:pointer;white-space:nowrap}
.dcn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcn-btn:disabled{opacity:.5;cursor:not-allowed}
.dcn-btn--primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dcn-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dcn-btn--danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-border-l2)}
.dcn-btn--wide{width:100%}
.dcn-input{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:5px 9px;min-width:0}
.dcn-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dcn-textarea{resize:vertical;min-height:64px;line-height:1.5}
.dcn-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dcn-row--modes{gap:6px}
.dcn-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dcn-hint--soft{opacity:.72}
.dcn-hint--warn{color:var(--dsw-alias-state-warn-label)}
.dcn-md{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary);max-height:340px;overflow:auto;padding-right:2px}
.dcn-md-h{font-size:12.5px;font-weight:600;margin-top:2px}
.dcn-md-h--sub{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dcn-md-p{color:var(--dsw-alias-label-secondary)}
.dcn-md-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;color:var(--dsw-alias-label-secondary)}
.dcn-pill{font-size:11px;border-radius:999px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcn-pill--live{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-state-error-primary);border-color:transparent}
.dcn-pill--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary)}
.dcn-live-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);display:inline-block;margin-right:5px;animation:dcn-pulse 1.4s infinite}
@keyframes dcn-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.dcn-meter{height:5px;border-radius:999px;background:var(--dsw-alias-bg-mask-1);overflow:hidden}
.dcn-meter-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .12s linear}
.dcn-drop{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px 10px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1.6}
.dcn-drop:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dcn-kw{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.dcn-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;border-radius:6px;padding:1px 6px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);max-width:100%}
.dcn-chip-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;padding:0 1px;line-height:1}
.dcn-chip-x:hover{color:var(--dsw-alias-label-error)}
.dcn-chip--gloss{border:1px solid var(--dsw-alias-border-l1);background:transparent}
.dcn-slides{display:flex;flex-direction:column;gap:6px}
.dcn-slide{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dcn-slide--current{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.dcn-slide-head{display:flex;align-items:center;gap:9px;padding:8px 11px;cursor:pointer;min-width:0}
.dcn-slide-no{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);flex:0 0 26px}
.dcn-slide-title{flex:1;min-width:0;font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcn-slide-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcn-slide-body{padding:2px 11px 11px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.dcn-seg{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}
.dcn-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:320px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}
.dcn-toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:6000;pointer-events:none}
.dcn-toast{pointer-events:auto;min-width:220px;max-width:340px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);padding:9px 12px;box-shadow:0 8px 26px rgba(0,0,0,.22)}
.dcn-toast-title{font-size:12px;font-weight:600;margin-bottom:2px}
.dcn-toast-body{font-size:11.5px;line-height:1.5;opacity:.86;word-break:break-word}
.dcn-toast--error .dcn-toast-title{color:var(--dsw-alias-label-error)}
.dcn-toast--success .dcn-toast-title{color:var(--dsw-alias-state-success-primary)}
.dcn-icon-badge{position:relative;display:inline-flex}
.dcn-icon-live{position:absolute;right:-1px;top:-1px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
@media (max-width:980px){.dcn-steps{grid-template-columns:minmax(0,1fr)}.dcn-side{width:212px;flex-basis:212px}}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-class-notes'
      style.dataset.pluginCss = STYLE_TAG_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ─────────────────────────────── store ────────────────────────────────

    let clientContext = null

    let snapshot = {
      status: 'loading',
      error: null,
      data: null,
      sessions: [],
      selectedId: null,
      session: null,
      sessionLoading: false,
      busy: null,
      deckMode: null,
      speech: null,
      speechPreparing: false,
      exportResult: null,
      toasts: [],
      live: initialLiveState(),
    }
    const listeners = new Set()
    let toastSeq = 0
    // A load that finishes after the user already opened another class must not
    // paint its session into the panel.
    let loadSeq = 0

    function initialLiveState() {
      return { status: 'idle', sessionId: null, level: 0, startedAt: 0, chunks: 0, audioSeconds: 0, lastText: '', error: '', inFlight: 0, silent: 0 }
    }

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function commit(patch) {
      snapshot = { ...snapshot, ...patch }
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /**
     * What this class is busy with. Each deck is its own task: looking at B while
     * A is converting a PDF must not make B's upload look busy — and coming back
     * to A has to show A's own progress again, not B's.
     */
    function busyKind(state, session) {
      const busy = state.busy
      if (busy === null || busy === undefined) return null
      if (busy.id === null || busy.id === undefined) return busy.kind
      if (session === null || session === undefined) return null
      return busy.id === session.id ? busy.kind : null
    }

    /** The export result that belongs to this class, if the last export was its own. */
    function exportFor(state, session) {
      const result = state.exportResult
      if (result === null || result === undefined) return null
      if (session === null || session === undefined) return null
      return result.id === session.id ? result : null
    }

    function useSnapshot() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => setValue(snapshot)), [])
      return value
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function notify(level, title, body = '') {
      const id = ++toastSeq
      commit({ toasts: [...snapshot.toasts, { id, level, title, body }] })
      window.setTimeout(() => {
        commit({ toasts: snapshot.toasts.filter((toast) => toast.id !== id) })
      }, TOAST_TTL_MS)
    }

    // ──────────────────────────────── API ─────────────────────────────────

    async function requestJson(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('连不上听课笔记服务，刷新一下页面试试')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        throw new Error(response.status === 404
          ? '听课笔记服务没启动，刷新一下页面'
          : `接口没有响应（HTTP ${response.status}）`)
      }
      if (payload.ok === false || !response.ok) {
        const error = new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `接口出错（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      if (snapshot.error !== null) commit({ error: null })
      return payload
    }

    async function requestBytes(path, bytes, fileName) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }
      if (typeof fileName === 'string' && fileName !== '') {
        init.headers['x-file-name'] = encodeURIComponent(fileName)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('上传中断，网络或服务有点问题')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) throw new Error(`上传没有响应（HTTP ${response.status}）`)
      if (payload.ok === false || !response.ok) {
        throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : `上传失败（HTTP ${response.status}）`)
      }
      return payload
    }

    // ─────────────────────────────── helpers ──────────────────────────────

    function applySession(session) {
      if (session === null || session === undefined) return
      commit({
        session: snapshot.selectedId === session.id ? session : snapshot.session,
        sessions: snapshot.sessions.some((item) => item.id === session.id)
          ? snapshot.sessions.map((item) => (item.id === session.id ? projectFrom(session) : item))
          : [projectFrom(session), ...snapshot.sessions],
      })
    }

    function projectFrom(session) {
      const progress = session.progress ?? { slides: (session.slides ?? []).length, noted: 0, keywords: 0, chars: 0, advances: 0 }
      return {
        id: session.id,
        title: session.title,
        course: session.course,
        date: session.date,
        status: session.status,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        slideCount: progress.slides,
        notedCount: progress.noted,
        keywordCount: progress.keywords,
        hasPptx: (session.meta?.fileName ?? '') !== '',
      }
    }

    function formatClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    function speechLine(speech) {
      if (speech === null || speech === undefined) return '语音识别状态未知'
      if (speech.available !== true) return speech.error ?? '本机语音识别服务没启用'
      const phase = PHASE_LABELS[speech.phase] ?? (speech.phase ? String(speech.phase) : '未知')
      if (speech.phase === 'ready' || speech.phase === 'standby') return `语音识别就绪（${speech.message || '本机 SenseVoice'}）`
      return `语音识别${phase}${speech.message ? ` · ${speech.message}` : ''}`
    }

    // ─────────────────────────────── audio ────────────────────────────────

    function concatFloat32(chunks) {
      let total = 0
      for (const chunk of chunks) total += chunk.length
      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      return merged
    }

    function peakOf(samples) {
      let peak = 0
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index] < 0 ? -samples[index] : samples[index]
        if (value > peak) peak = value
      }
      return peak
    }

    /** Convert the microphone rate to 16 kHz while keeping the sample grid. */
    class StreamingResampler {
      constructor(sourceRate, targetRate) {
        this.step = sourceRate / targetRate
        this.offset = 0
        this.tail = new Float32Array(0)
      }

      push(input) {
        const merged = new Float32Array(this.tail.length + input.length)
        merged.set(this.tail, 0)
        merged.set(input, this.tail.length)
        const out = []
        const last = merged.length - 1
        let position = this.offset
        while (position < last) {
          const left = Math.floor(position)
          const fraction = position - left
          out.push(merged[left] * (1 - fraction) + merged[left + 1] * fraction)
          position += this.step
        }
        const consumed = Math.min(Math.floor(position), merged.length)
        this.tail = merged.slice(consumed)
        this.offset = position - consumed
        return Float32Array.from(out)
      }
    }

    function writeAscii(view, offset, text) {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index))
      }
    }

    function encodePcm16Wav(samples, sampleRate = TARGET_RATE) {
      const frames = samples.length
      const buffer = new ArrayBuffer(44 + frames * 2)
      const view = new DataView(buffer)
      writeAscii(view, 0, 'RIFF')
      view.setUint32(4, 36 + frames * 2, true)
      writeAscii(view, 8, 'WAVE')
      writeAscii(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(view, 36, 'data')
      view.setUint32(40, frames * 2, true)
      let offset = 44
      for (let index = 0; index < frames; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    function explainMediaError(error) {
      const name = error && typeof error === 'object' ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，在浏览器里允许一下再用'
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没找到麦克风，检查一下设备'
      if (name === 'NotReadableError') return '麦克风被别的程序占着，关掉再试'
      return `打不开录音：${messageOf(error)}`
    }

    function stopStream(stream) {
      if (stream === null || stream === undefined) return
      try {
        for (const track of stream.getTracks()) track.stop()
      } catch {
        // Ignore teardown failures.
      }
    }

    /** Live capture lives at module scope so it survives panel remounts. */
    const engine = {
      status: 'idle',
      sessionId: null,
      capture: null,
      resampler: null,
      accumulator: [],
      frames: 0,
      level: 0,
      peak: 0,
      inFlight: 0,
      pendingFlush: false,
      startedAt: 0,
      chunks: 0,
      audioSeconds: 0,
      silent: 0,
      lastText: '',
      error: '',
    }

    function liveSnapshot() {
      return {
        status: engine.status,
        sessionId: engine.sessionId,
        level: engine.level,
        startedAt: engine.startedAt,
        chunks: engine.chunks,
        audioSeconds: engine.audioSeconds,
        lastText: engine.lastText,
        error: engine.error,
        inFlight: engine.inFlight,
        silent: engine.silent,
      }
    }

    function commitLive() {
      commit({ live: liveSnapshot() })
    }

    function releaseCapture() {
      const capture = engine.capture
      engine.capture = null
      if (capture === null) return
      if (capture.processor) {
        capture.processor.onaudioprocess = null
        try { capture.processor.disconnect() } catch { /* ignore */ }
      }
      if (capture.source) {
        try { capture.source.disconnect() } catch { /* ignore */ }
      }
      if (capture.sink) {
        try { capture.sink.disconnect() } catch { /* ignore */ }
      }
      stopStream(capture.stream)
      if (capture.context) {
        try {
          const closing = capture.context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      }
    }

    async function openCapture() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices
        || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('这个浏览器不支持录音，换 Chrome 或 Edge 试试')
      }
      let stream = null
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (error) {
        if (error && (error.name === 'OverconstrainedError' || error.name === 'TypeError')) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch (inner) {
            throw new Error(explainMediaError(inner))
          }
        } else {
          throw new Error(explainMediaError(error))
        }
      }
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (typeof AudioCtor !== 'function') {
        stopStream(stream)
        throw new Error('这个浏览器不支持录音，换 Chrome 或 Edge 试试')
      }
      let context = null
      try {
        try {
          context = new AudioCtor({ sampleRate: TARGET_RATE })
        } catch {
          context = new AudioCtor()
        }
      } catch (error) {
        stopStream(stream)
        throw new Error(`启动录音失败：${messageOf(error)}`)
      }
      if (context.state === 'suspended') {
        try { await context.resume() } catch { /* a user gesture usually allows it */ }
      }
      if (typeof context.createScriptProcessor !== 'function') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('这个浏览器不支持实时音频处理')
      }
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const sink = context.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      if (context.state !== 'running') {
        try { await context.resume() } catch { /* ignore */ }
      }
      if (context.state !== 'running') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('浏览器把录音拦了，点一下页面再试')
      }
      return { stream, context, source, processor, sink }
    }

    function onAudioProcess(event) {
      if (engine.status !== 'recording') return
      const input = event.inputBuffer?.getChannelData?.(0)
      if (!input || input.length === 0) return
      const mono = new Float32Array(input.length)
      mono.set(input)
      let energy = 0
      for (let index = 0; index < mono.length; index += 1) energy += mono[index] * mono[index]
      engine.level = Math.min(1, Math.sqrt(energy / mono.length) * 4)
      const resampled = engine.resampler === null ? mono : engine.resampler.push(mono)
      if (resampled.length === 0) return
      engine.accumulator.push(resampled)
      engine.frames += resampled.length
      if (engine.frames >= TARGET_RATE * LIVE_FLUSH_SECONDS && engine.inFlight < MAX_IN_FLIGHT) {
        void flushSamples(false)
      }
    }

    async function flushSamples(force) {
      const frames = engine.frames
      if (frames === 0) return
      const seconds = frames / TARGET_RATE
      if (!force && seconds < LIVE_FLUSH_SECONDS) return
      if (force && seconds < LIVE_MIN_SECONDS) {
        engine.accumulator = []
        engine.frames = 0
        return
      }
      if (engine.inFlight >= MAX_IN_FLIGHT) {
        engine.pendingFlush = true
        return
      }
      // Audio always belongs to the session that was open when it was captured:
      // if no session owns the microphone, the samples are dropped, never filed
      // under whatever class happens to be open now.
      const sessionId = engine.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        engine.accumulator = []
        engine.frames = 0
        return
      }
      const merged = concatFloat32(engine.accumulator)
      engine.accumulator = []
      engine.frames = 0
      const peak = peakOf(merged)
      if (peak < SILENCE_PEAK) {
        engine.silent += 1
        commitLive()
        return
      }
      engine.inFlight += 1
      commitLive()
      const wav = encodePcm16Wav(merged)
      try {
        const payload = await requestBytes(`/sessions/${sessionId}/chunk`, wav)
        // A late answer for a class the user already left must not touch the
        // counters (or the notes view) of the class now on screen.
        if (engine.sessionId === sessionId) {
          engine.chunks += 1
          engine.audioSeconds += seconds
          if (payload.empty !== true) engine.lastText = typeof payload.text === 'string' ? payload.text : ''
        }
        if (payload.session) applySession(payload.session)
      } catch (error) {
        engine.error = messageOf(error)
        notify('error', '这一小段没转出来', engine.error)
      } finally {
        engine.inFlight -= 1
        commitLive()
        if (engine.pendingFlush && engine.frames >= TARGET_RATE * LIVE_FLUSH_SECONDS) {
          engine.pendingFlush = false
          void flushSamples(false)
        }
      }
    }

    async function startLive(sessionId) {
      // One microphone, one class. The capture is already bound to a session
      // (including one that is still opening), so a second start is refused
      // instead of silently moving the stream to another deck.
      if (engine.status === 'recording' || engine.status === 'starting' || engine.status === 'stopping') {
        if (engine.sessionId !== null && engine.sessionId !== sessionId) {
          notify('warn', '已经有一节课在录音了', '先回那一节点“停止”，再开这节')
        }
        return
      }
      if (typeof sessionId !== 'string' || sessionId === '') return
      engine.status = 'starting'
      engine.error = ''
      // Bound before the microphone opens: anything captured while starting
      // already knows which class it belongs to.
      engine.sessionId = sessionId
      commitLive()
      try {
        const capture = await openCapture()
        if (engine.status !== 'starting' || engine.sessionId !== sessionId) {
          stopStream(capture.stream)
          try { capture.context.close() } catch { /* ignore */ }
          return
        }
        engine.capture = capture
        engine.resampler = capture.context.sampleRate === TARGET_RATE
          ? null
          : new StreamingResampler(capture.context.sampleRate, TARGET_RATE)
        engine.accumulator = []
        engine.frames = 0
        engine.level = 0
        engine.inFlight = 0
        engine.pendingFlush = false
        engine.startedAt = Date.now()
        engine.chunks = 0
        engine.audioSeconds = 0
        engine.silent = 0
        engine.lastText = ''
        // The host must know the mic is live before any audio is posted, or the
        // first chunk would be refused as "not recording".
        const payload = await requestJson(`/sessions/${sessionId}/recording`, { method: 'POST', body: { active: true } })
        if (payload.session) applySession(payload.session)
        for (const item of payload.paused ?? []) {
          notify('warn', '另一节课已经停下了', `「${item.title}」先暂停在这，一节只录一节`)
        }
        if (engine.status !== 'starting' || engine.sessionId !== sessionId) {
          // The user switched or stopped while the mic was opening: undo the
          // flag we just set so this class is not left "recording" forever.
          stopStream(capture.stream)
          try { capture.context.close() } catch { /* ignore */ }
          engine.capture = null
          await requestJson(`/sessions/${sessionId}/recording`, { method: 'POST', body: { active: false } })
            .then((late) => { if (late.session) applySession(late.session) })
            .catch(() => undefined)
          return
        }
        capture.processor.onaudioprocess = onAudioProcess
        engine.status = 'recording'
        commitLive()
      } catch (error) {
        releaseCapture()
        // A start that failed must not leave the mic "active" on the host side.
        await requestJson(`/sessions/${sessionId}/recording`, { method: 'POST', body: { active: false } })
          .then((late) => { if (late.session) applySession(late.session) })
          .catch(() => undefined)
        engine.status = 'error'
        engine.error = messageOf(error)
        engine.resampler = null
        engine.sessionId = null
        commitLive()
        notify('error', '录音没开起来', engine.error)
      }
    }

    async function stopLive() {
      const sessionId = engine.sessionId
      const wasActive = engine.status === 'recording' || engine.status === 'starting' || engine.status === 'error' || sessionId !== null
      if (!wasActive) return
      engine.status = 'stopping'
      commitLive()
      const capture = engine.capture
      if (capture && capture.processor) capture.processor.onaudioprocess = null
      try {
        await flushSamples(true)
      } catch {
        // A failed tail must not keep the microphone open.
      }
      releaseCapture()
      engine.resampler = null
      engine.status = 'idle'
      engine.sessionId = null
      engine.startedAt = 0
      engine.level = 0
      // Whatever was left over belonged to the class that just closed, so the
      // next class starts from an empty buffer.
      engine.accumulator = []
      engine.frames = 0
      engine.inFlight = 0
      engine.pendingFlush = false
      commitLive()
      if (sessionId !== null) {
        try {
          const payload = await requestJson(`/sessions/${sessionId}/recording`, { method: 'POST', body: { active: false } })
          if (payload.session) applySession(payload.session)
        } catch (error) {
          notify('error', '停止录音时出了点问题', messageOf(error))
        }
      }
    }

    // ───────────────────────────── answer actions ─────────────────────────

    async function finishSession(id, options = {}) {
      if (typeof id !== 'string' || id === '') return
      // A live tail belongs to this class, so it is flushed before the record
      // closes — but only when the microphone really is on this class.
      if (options.flush !== false) await stopLive()
      commit({ busy: { id, kind: 'finish' } })
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/finish`, {
          method: 'POST',
          body: {},
        })
        if (payload.session) applySession(payload.session)
        await refreshAll({ silent: true, autoSelect: false })
        const progress = payload.progress ?? payload.session?.progress ?? null
        const noted = progress?.noted ?? 0
        const slides = progress?.slides ?? 0
        notify('success', '这节课结束了', `备注写了 ${noted}/${slides} 页，可以导出了`)
      } catch (error) {
        notify('error', '没能结束这节课', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    async function refreshAll(options = {}) {
      if (snapshot.status === 'loading' && options.silent !== true) commit({ status: 'loading' })
      try {
        const payload = await requestJson('/state')
        commit({
          status: 'ready',
          data: payload,
          sessions: payload.sessions ?? [],
          speech: payload.speech ?? null,
          error: null,
        })
        const selected = snapshot.selectedId
        if (selected !== null && (payload.sessions ?? []).every((item) => item.id !== selected)) {
          commit({ selectedId: null, session: null })
        } else if (selected === null && snapshot.session === null && (payload.sessions ?? []).length > 0
          && options.autoSelect !== false) {
          await loadSession(payload.sessions[0].id)
        }
      } catch (error) {
        commit({ status: 'error', error: messageOf(error) })
      }
    }

    async function loadSession(id, options = {}) {
      if (typeof id !== 'string' || id === '') {
        commit({ selectedId: null, session: null })
        return null
      }
      const seq = ++loadSeq
      if (options.silent !== true) {
        // Opening another class must never show the previous one's progress
        // under the new title, not even for the length of one request.
        commit({
          selectedId: id,
          session: snapshot.session?.id === id ? snapshot.session : null,
          sessionLoading: true,
        })
      }
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}`)
        // The user may have opened another class while this one was loading.
        if (seq !== loadSeq) return payload.session ?? null
        commit({
          selectedId: id,
          session: payload.session ?? null,
          speech: payload.speech ?? snapshot.speech,
          sessionLoading: false,
        })
        return payload.session ?? null
      } catch (error) {
        if (seq === loadSeq) commit({ sessionLoading: false })
        notify('error', '打不开这节课', messageOf(error))
        return null
      }
    }

    async function createSession() {
      commit({ busy: { id: null, kind: 'create' } })
      try {
        const payload = await requestJson('/sessions', {
          method: 'POST',
          body: { title: '未命名听课', date: new Date().toISOString().slice(0, 10) },
        })
        await refreshAll({ silent: true, autoSelect: false })
        if (payload.session) {
          commit({
            selectedId: payload.session.id,
            session: payload.session,
          })
        }
      } catch (error) {
        notify('error', '新建没成功', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    async function deleteSession(id) {
      commit({ busy: { id, kind: 'delete' } })
      try {
        await requestJson(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        commit({ selectedId: null, session: null })
        await refreshAll({ silent: true, autoSelect: false })
        notify('success', '删掉了')
      } catch (error) {
        notify('error', '删除失败', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    async function patchSession(id, patch) {
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
        if (payload.session) applySession(payload.session)
      } catch (error) {
        notify('error', '保存失败', messageOf(error))
      }
    }

    async function uploadDeck(id, file) {
      const isPdf = /\.pdf$/i.test(file.name)
      commit({ busy: { id, kind: 'deck' }, deckMode: { id, mode: isPdf ? 'pdf' : 'pptx' } })
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const payload = await requestBytes(`/sessions/${encodeURIComponent(id)}/deck`, bytes, file.name)
        if (payload.session) applySession(payload.session)
        await refreshAll({ silent: true, autoSelect: false })
        if (payload.startedNew === true && payload.session) {
          await loadSession(payload.session.id, { silent: true })
        }
        const pages = payload.session?.slides?.length ?? 0
        if (payload.startedNew === true) {
          notify('success', '上一节结束了，新开了一节', `这节课的课件：${pages} 页`)
        } else if (payload.converted) {
          const converted = payload.converted
          if (converted.warning) {
            notify('warn', 'PDF 放进去了，有点将就', `${pages} 页 · ${String(converted.warning).slice(0, 150)}`)
          } else {
            notify('success', 'PDF 转成 PPT 了', `${pages} 页 · ${converted.rendered} 页按原样，文字也读出来了`)
          }
        } else {
          notify('success', 'PPT 放进去了', `${pages} 页，关键词先按版面拆了一遍`)
        }
      } catch (error) {
        notify('error', isPdf ? 'PDF 没转成功' : 'PPT 没放进去', messageOf(error))
      } finally {
        commit({ busy: null, deckMode: null })
      }
    }

    async function importPath(id, path) {
      const isPdf = /\.pdf$/i.test(path)
      commit({ busy: { id, kind: 'deck' }, deckMode: { id, mode: isPdf ? 'pdf' : 'pptx' } })
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/import-path`, {
          method: 'POST',
          body: { path },
        })
        if (payload.session) applySession(payload.session)
        await refreshAll({ silent: true, autoSelect: false })
        if (payload.startedNew === true && payload.session) {
          await loadSession(payload.session.id, { silent: true })
          notify('success', '上一节结束了，新开了一节', path)
        } else {
          notify('success', isPdf ? 'PDF 转成 PPT 了' : 'PPT 放进去了', path)
        }
      } catch (error) {
        notify('error', '导入失败', messageOf(error))
      } finally {
        commit({ busy: null, deckMode: null })
      }
    }

    async function extractKeywords(id) {
      commit({ busy: { id, kind: 'keywords' } })
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/keywords`, { method: 'POST', body: {} })
        if (payload.session) applySession(payload.session)
        const source = SOURCE_LABELS[payload.keywordSource] ?? '已识别'
        if (payload.error) {
          notify('warn', '用启发式关键词顶上了', String(payload.error).slice(0, 160))
        } else {
          notify('success', '关键词识别好了', source)
        }
      } catch (error) {
        notify('error', '关键词没识别出来', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    /**
     * Give the keywords a wording in the lecture's language: a Chinese lecture
     * over an English deck gets 中文 (backpropagation → 反向传播); an English
     * lecture over a Chinese deck gets the English term.
     */
    async function glossKeywords(id) {
      commit({ busy: { id, kind: 'gloss' } })
      const toEnglish = snapshot.session?.asrMode === 'en'
      const word = toEnglish ? '英文说法' : '中文说法'
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/gloss`, { method: 'POST', body: {} })
        if (payload.session) applySession(payload.session)
        if (payload.glossError) {
          notify('warn', `${word}只补上了一部分`, String(payload.glossError).slice(0, 160))
        } else {
          notify(
            'success',
            `${word}补好了`,
            toEnglish ? '老师用英文讲中文课件，也能对上了' : '老师用中文讲英文课件，也能对上了',
          )
        }
      } catch (error) {
        notify('error', `${word}没补上`, messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    /**
     * Ask the model for a recap of this class. It lives on the session, so a
     * refresh keeps it and ④ writes it into the notes when exporting.
     */
    async function summarizeNotes(id) {
      commit({ busy: { id, kind: 'summary' } })
      const mine = snapshot.session !== null && snapshot.session.id === id
      const again = mine && (snapshot.session?.summary?.markdown ?? '') !== ''
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/summary`, { method: 'POST', body: {} })
        if (payload.session) applySession(payload.session)
        notify('success', again ? '纪要重写好了' : '纪要写好了', '往下翻就能看，导出时会一起带上')
      } catch (error) {
        notify('error', '纪要没写出来', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    async function saveSlide(id, index, patch) {
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/slides/${index}`, {
          method: 'POST',
          body: patch,
        })
        if (payload.session) applySession(payload.session)
        return true
      } catch (error) {
        notify('error', '这一页没保存上', messageOf(error))
        return false
      }
    }

    async function exportNotes(id) {
      commit({ busy: { id, kind: 'export' } })
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/export`, { method: 'POST', body: {} })
        if (payload.session) applySession(payload.session)
        commit({
          exportResult: {
            id,
            target: payload.target ?? '',
            pagesOut: payload.pagesOut ?? '',
            downloads: payload.downloads ?? {},
            notesWritten: payload.notesWritten ?? 0,
            at: Date.now(),
          },
        })
        notify('success', '导出好了', payload.target ?? '')
      } catch (error) {
        notify('error', '导出失败', messageOf(error))
      } finally {
        commit({ busy: null })
      }
    }

    async function prepareSpeech(id) {
      commit({ speechPreparing: true })
      try {
        const payload = await requestJson(`/sessions/${encodeURIComponent(id)}/speech`, { method: 'POST', body: {} })
        commit({ speech: payload.speech ?? snapshot.speech })
        notify('success', '语音模型在准备', speechLine(payload.speech ?? snapshot.speech))
      } catch (error) {
        notify('error', '语音模型准备不了', messageOf(error))
      } finally {
        commit({ speechPreparing: false })
      }
    }

    // ──────────────────────────── small pieces ────────────────────────────

    function Button(props) {
      return h('button', {
        type: 'button',
        className: `dcn-btn${props.variant ? ` dcn-btn--${props.variant}` : ''}${props.wide ? ' dcn-btn--wide' : ''}`,
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.onClick,
      }, props.children)
    }

    function Card(props) {
      return h('section', { className: 'dcn-card' },
        h('div', { className: 'dcn-card-head' }, props.head, props.extra ?? null),
        h('div', { className: 'dcn-card-body' }, props.children))
    }

    function Pill(props) {
      return h('span', { className: `dcn-pill${props.tone ? ` dcn-pill--${props.tone}` : ''}`, title: props.title }, props.children)
    }

    function ClassNotesGlyph(props) {
      const size = props?.size ?? 18
      const active = props?.active === true
      const state = useSnapshot()
      const recording = state.live.status === 'recording'
      const stroke = active ? 1.6 : 1.3
      const glyph = h('svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.6, y: 2, width: 12.8, height: 8.4, rx: 1.6, stroke: 'currentColor', strokeWidth: stroke }),
        h('path', { d: 'M1.9 5.2h12.2', stroke: 'currentColor', strokeWidth: stroke, opacity: 0.6 }),
        h('path', { d: 'M5.1 13.9 3.4 15', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', opacity: 0.5 }),
        h('path', { d: 'M10.9 13.9 12.6 15', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', opacity: 0.5 }),
        h('path', { d: 'M8 13.5v-2.1M9.9 8.6H6.1', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', opacity: 0.85 }),
      )
      if (!recording) return glyph
      return h('span', { className: 'dcn-icon-badge' }, glyph, h('span', { className: 'dcn-icon-live', title: '正在记' }))
    }

    function ToastOverlay() {
      const state = useSnapshot()
      if (state.toasts.length === 0) return null
      return h('div', { className: 'dcn-toasts' },
        state.toasts.map((toast) => h('div', {
          key: toast.id,
          className: `dcn-toast${toast.level === 'error' ? ' dcn-toast--error' : toast.level === 'success' ? ' dcn-toast--success' : ''}`,
        },
        h('div', { className: 'dcn-toast-title' }, toast.title),
        toast.body ? h('div', { className: 'dcn-toast-body' }, toast.body) : null)))
    }

    // ──────────────────────────── deck controls ───────────────────────────

    function DeckCard(props) {
      const { session, busy } = props
      const state = useSnapshot()
      const inputRef = useRef(null)
      const [path, setPath] = useState('')
      const [dragging, setDragging] = useState(false)
      const hasDeck = (session.meta?.fileName ?? '') !== ''
      const converting = busy === 'deck' && state.deckMode?.mode === 'pdf' && state.deckMode.id === session.id

      const pick = useCallback((file) => {
        if (!file) return
        if (!/\.(pptx|pdf)$/i.test(file.name)) {
          notify('error', '只认 .pptx 和 .pdf', '老 .ppt 格式先在 PowerPoint 里另存为 pptx')
          return
        }
        void uploadDeck(session.id, file)
      }, [session.id])

      const convertedNote = session.meta?.importKind === 'pdf' && (session.meta?.pdfPages ?? 0) > 0
        ? h('div', { className: `dcn-hint${session.meta?.pdfWarning ? ' dcn-hint--warn' : ''}` },
            session.meta.pdfWarning
              ? `PDF 转的：${session.meta.pdfPages} 页，${session.meta.pdfRenderedPages} 页按原样贴着；${String(session.meta.pdfWarning).slice(0, 120)}`
              : `PDF 转的：${session.meta.pdfPages} 页，${session.meta.pdfRenderedPages} 页按原样贴着`)
        : null

      return h(Card, { head: '① 放课件' },
        h('div', {
          className: 'dcn-drop',
          onClick: () => inputRef.current?.click(),
          onDragOver: (event) => { event.preventDefault(); setDragging(true) },
          onDragLeave: () => setDragging(false),
          onDrop: (event) => {
            event.preventDefault()
            setDragging(false)
            pick(event.dataTransfer?.files?.[0])
          },
        },
        hasDeck
          ? `${session.meta.fileName} · ${(session.slides ?? []).length} 页`
          : converting
            ? 'PDF 正在一页页转…'
            : (busy === 'deck' ? '正在放进去…' : '点这里选 PPT 或 PDF，也可以拖进来')),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: '.pptx,.pdf',
          style: { display: 'none' },
          onChange: (event) => {
            pick(event.target.files?.[0])
            event.target.value = ''
          },
        }),
        hasDeck
          ? h('div', { className: 'dcn-hint' }, `每页 ${(session.slides ?? []).filter((slide) => (slide.keywords ?? []).length > 0).length} 页已有关键词，共 ${session.progress?.keywords ?? 0} 个`)
          : h('div', { className: 'dcn-row' },
            h('input', {
              className: 'dcn-input',
              style: { flex: 1, minWidth: 120 },
              placeholder: '或者贴本机路径，如 D:\\课件\\第3讲.pdf',
              value: path,
              onChange: (event) => setPath(event.target.value),
            }),
            h(Button, { disabled: busy === 'deck' || path.trim() === '', onClick: () => { void importPath(session.id, path.trim()) } }, '导入')),
        hasDeck ? convertedNote : null,
        session.status === 'done' || Boolean(session.finishedAt)
          ? h('div', { className: 'dcn-hint dcn-hint--soft' }, '这节已经结束了，再传课件会自动开一节新的')
          : null,
        converting ? h('div', { className: 'dcn-hint' }, 'PDF 会先渲染成图片、再拼成 PPT，页多的话要等十几秒') : null,
        dragging ? h('div', { className: 'dcn-hint' }, '松手就放进来') : null,
      )
    }

    // ────────────────────────── keywords controls ─────────────────────────

    function KeywordsCard(props) {
      const { session, busy } = props
      const slides = session.slides ?? []
      const sources = [...new Set(slides.map((slide) => slide.keywordSource).filter((item) => item && item !== 'pending'))]
      const sourceLabel = sources.length === 0
        ? '还没识别'
        : sources.map((item) => SOURCE_LABELS[item] ?? item).join(' / ')
      const glossCount = slides.reduce(
        (total, slide) => total + Object.keys(slide.keywordGlosses ?? {}).length,
        0,
      )
      // The gloss runs in the direction the lecture is spoken, so the wording in
      // the panel follows the transcription mode: 中文 lecture → Chinese glosses
      // for English terms, English lecture → English glosses for Chinese terms,
      // 中英混合 → both at once.
      const toEnglish = session.asrMode === 'en'
      const toBoth = session.asrMode === 'mixed'
      const glossWord = toEnglish ? '英文说法' : toBoth ? '中英说法' : '中文说法'
      // Keywords just got re-recognized and their old translations were dropped:
      // the panel says so instead of looking like the pass never ran.
      const glossPending = slides.length > 0 && session.meta?.glossAt === null && glossCount === 0
      const glossLabel = glossPending
        ? `${glossWord}在排队`
        : glossCount === 0
          ? `还没补${glossWord}`
          : `${glossCount} 个词有${glossWord}`
      return h(Card, { head: '② 认出每页的关键词' },
        h('div', { className: 'dcn-row' },
          h(Button, {
            variant: 'primary',
            disabled: busy === 'keywords' || slides.length === 0,
            onClick: () => { void extractKeywords(session.id) },
          }, busy === 'keywords' ? '正在认…' : '识别关键词'),
          h(Pill, { tone: sources.includes('llm') ? 'ok' : undefined }, sourceLabel)),
        h('div', { className: 'dcn-hint' },
          '录音时就是靠这些词判断讲到第几页：这一页的词听不到了，下一页的词冒出来，就翻页。'),
        slides.length === 0
          ? null
          : h('div', { className: 'dcn-row' },
            h(Button, {
              disabled: busy === 'gloss',
              onClick: () => { void glossKeywords(session.id) },
            }, busy === 'gloss' ? '正在补…' : `补${glossWord}`),
            h(Pill, { tone: glossCount > 0 ? 'ok' : undefined }, glossLabel)),
        slides.length === 0
          ? null
          : h('div', { className: 'dcn-hint' },
            toEnglish
              ? '中文课件配英文讲课：每个中文术语会配上老师嘴里说的英文（反向传播 → backpropagation），录音里听到英文也算命中。开始录音前会自动补一次。'
              : toBoth
                ? '中英混着讲：英文术语配中文说法、中文术语配英文说法，两边听到都算命中。开始录音前会自动补一次。'
                : '英文课件配中文讲课：每个英文术语会配上老师嘴里说的中文（backpropagation → 反向传播），录音里听到中文也算命中。开始录音前会自动补一次。'),
        session.meta?.glossError
          ? h('div', { className: 'dcn-hint dcn-hint--warn' }, `${glossWord}这轮没补全：${String(session.meta.glossError).slice(0, 140)}`)
          : null,
        session.meta?.keywordsError
          ? h('div', { className: 'dcn-hint dcn-hint--warn' }, `模型这轮没成功：${String(session.meta.keywordsError).slice(0, 140)}`)
          : null,
      )
    }

    // ─────────────────────────── recording controls ───────────────────────

    function LiveCard(props) {
      const { session } = props
      const state = useSnapshot()
      const live = state.live
      // The microphone belongs to exactly one session. Opening another class
      // while A is still recording must not show A's clock or A's tail here.
      const boundToSession = live.sessionId === session.id
      const elsewhere = !boundToSession && (live.status === 'recording' || live.status === 'starting' || live.status === 'stopping')
      const recording = live.status === 'recording' && boundToSession
      const [now, setNow] = useState(() => Date.now())
      const [level, setLevel] = useState(0)
      const [confirming, setConfirming] = useState(false)

      useEffect(() => {
        if (!recording) return undefined
        const timer = window.setInterval(() => {
          setNow(Date.now())
          setLevel(engine.level)
        }, 150)
        return () => { window.clearInterval(timer) }
      }, [recording])

      const currentIndex = session.recording?.currentIndex ?? 1
      const slides = session.slides ?? []
      const current = slides.find((slide) => slide.index === currentIndex) ?? null
      const decision = session.tracker?.lastDecision ?? null
      const history = (session.tracker?.history ?? []).slice(-4).reverse()
      const busy = live.status === 'starting' || live.status === 'stopping'
      const speech = state.speech
      const modes = state.data?.asrModes ?? DEFAULT_ASR_MODES
      const activeMode = modes.find((mode) => mode.id === (session.asrMode ?? 'mixed')) ?? modes[0]
      const modeHint = activeMode?.hint ?? ''
      // Finishing is a separate act from pausing: it closes this class for good,
      // and the next deck the user drops in opens a fresh session.
      const finished = session.status === 'done' || Boolean(session.finishedAt)

      const endRow = finished
        ? h('div', { className: 'dcn-row' },
          h(Pill, { tone: 'ok' }, '这节课已结束'),
          h(Button, { disabled: state.busy?.kind === 'create', onClick: () => { void createSession() } }, '开下一节'),
          h('span', { className: 'dcn-hint dcn-hint--soft' }, '或者直接在①里传下一个课件'))
        : confirming
          ? h('div', { className: 'dcn-row' },
            h('span', { className: 'dcn-hint' }, '这节就记到这儿？结束以后不能再补录音'),
            h(Button, {
              variant: 'danger',
              disabled: busyKind(state, session) === 'finish',
              onClick: () => {
                setConfirming(false)
                // Finishing closes the class the microphone is on; audio of a
                // different class must never be flushed into this one.
                void finishSession(session.id, { flush: boundToSession })
              },
            }, busyKind(state, session) === 'finish' ? '结束中…' : '结束'),
            h(Button, { onClick: () => { setConfirming(false) } }, '算了'))
          : h('div', { className: 'dcn-row' },
            h(Button, { disabled: slides.length === 0, onClick: () => { setConfirming(true) } }, '结束转录'),
            h('span', { className: 'dcn-hint dcn-hint--soft' }, '结束这节，就能传下一个课件了'))

      return h(Card, { head: '③ 开始记' },
        h('div', { className: 'dcn-row' },
          recording
            ? h(Button, { variant: 'danger', disabled: busy, onClick: () => { void stopLive() } }, '停止')
            : h(Button, {
              variant: 'primary',
              disabled: busy || slides.length === 0 || finished || elsewhere,
              onClick: () => { void startLive(session.id) },
            }, boundToSession && live.status === 'starting' ? '开麦克风…' : '开始录音'),
          recording ? h(Pill, { tone: 'live' }, `${formatClock(now - (live.startedAt || now))} 在记`) : null,
          recording ? h(Pill, null, `第 ${currentIndex} 页`) : null,
          elsewhere ? h(Pill, { tone: 'warn' }, `正在记另一节：${String(state.sessions.find((item) => item.id === live.sessionId)?.title ?? live.sessionId ?? '')}`) : null),
        endRow,
        h('div', { className: 'dcn-row dcn-row--modes' },
          h('span', { className: 'dcn-hint' }, '听写'),
          modes.map((mode) => h(Button, {
            key: mode.id,
            variant: session.asrMode === mode.id ? 'primary' : undefined,
            title: mode.hint,
            onClick: () => { void patchSession(session.id, { asrMode: mode.id }) },
          }, mode.label)),
          h('span', { className: 'dcn-hint dcn-hint--soft' }, modeHint)),
        recording
          ? h('div', { className: 'dcn-meter' }, h('div', { className: 'dcn-meter-fill', style: { width: `${Math.round(level * 100)}%` } }))
          : null,
        h('div', { className: 'dcn-hint' },
          finished
            ? '这节已经记完了，备注都在，可以去④导出'
            : elsewhere
              ? '另一节课正在录音，一节只能录一节；先回那节点「停止」再来开这节'
              : recording
              ? `${current === null ? '未定位到页面' : current.title || `第 ${currentIndex} 页`} · 已送 ${live.chunks} 段${live.silent > 0 ? ` · ${live.silent} 段静音` : ''}${live.inFlight > 0 ? ' · 正在转写…' : ''}`
              : slides.length === 0
                ? '先放 PPT 再录音，不然不知道往哪页记'
                : `当前停在第 ${currentIndex} 页，可以手动翻，录音里翻页会自动跟上`),
        live.error ? h('div', { className: 'dcn-hint dcn-hint--warn' }, live.error) : null,
        recording || live.lastText !== ''
          ? h('div', { className: 'dcn-seg' }, live.lastText !== '' ? live.lastText : '（等第一段识别结果…）')
          : null,
        decision !== null && decision.reason ? h('div', { className: 'dcn-hint' }, `判断：${decision.reason} · 本页 ${decision.here ?? 0} / 下一页 ${decision.ahead ?? 0}`) : null,
        decision !== null && (decision.hereHits ?? []).length > 0
          ? h('div', { className: 'dcn-hint' }, `这一片听到：${decision.hereHits.join('、')}`)
          : null,
        history.length > 0
          ? h('div', { className: 'dcn-card-body' },
            history.map((row, index) => h('div', { key: `${row.at}-${index}`, className: 'dcn-seg' },
              `第 ${row.slideIndex ?? '?'} 页 · ${row.text ?? ''}`)))
          : null,
        h('div', { className: 'dcn-row' },
          h(Button, {
            disabled: currentIndex <= 1,
            onClick: () => { void saveSlide(session.id, Math.max(1, currentIndex - 1), { jump: true }) },
          }, '上一页'),
          h(Button, {
            disabled: currentIndex >= slides.length,
            onClick: () => { void saveSlide(session.id, Math.min(slides.length, currentIndex + 1), { jump: true }) },
          }, '下一页')),
        speech !== null && speech.available === true && speech.phase !== 'ready' && speech.phase !== 'standby'
          ? h('div', { className: 'dcn-row' },
            h('span', { className: 'dcn-hint' }, speechLine(speech)),
            h(Button, {
              disabled: state.speechPreparing === true,
              onClick: () => { void prepareSpeech(session.id) },
            }, state.speechPreparing === true ? '准备中…' : '准备模型'))
          : h('div', { className: 'dcn-hint' }, speechLine(speech)),
      )
    }

    // ─────────────────────────── export controls ──────────────────────────

    function ExportCard(props) {
      const { session, busy } = props
      const state = useSnapshot()
      const result = exportFor(state, session)
      const downloads = result?.downloads ?? {}
      // The host half hands back ready-to-use loopback paths; older builds only
      // gave a bare file name, so accept both.
      const link = (href) => {
        const value = String(href ?? '')
        if (value.startsWith('/')) return value
        return `${API}/sessions/${encodeURIComponent(session.id)}/file?name=${encodeURIComponent(value)}`
      }
      const fileName = (href) => {
        const value = String(href ?? '')
        const at = value.indexOf('name=')
        return at < 0 ? value : decodeURIComponent(value.slice(at + 5))
      }
      return h(Card, { head: '④ 导出笔记' },
        h('div', { className: 'dcn-row' },
          h(Button, {
            variant: 'primary',
            disabled: busy === 'export' || (session.slides ?? []).length === 0,
            onClick: () => { void exportNotes(session.id) },
          }, busy === 'export' ? '正在写备注…' : '导出 PPT 和 Markdown'),
          h(Pill, null, `${session.progress?.noted ?? 0}/${(session.slides ?? []).length} 页有话`)),
        result === null || result === undefined
          ? h('div', { className: 'dcn-hint' }, '导出的是原 PPT 副本，讲课内容写进每页的「备注」，老师原来的备注不会被动。')
          : h('div', { className: 'dcn-card-body' },
            h('div', { className: 'dcn-hint' }, `写进 ${result.notesWritten} 页备注。文件：`),
            h('div', { className: 'dcn-hint' }, result.target),
            h('div', { className: 'dcn-row' },
              downloads.pptx
                ? h('a', { className: 'dcn-btn', href: link(downloads.pptx), download: fileName(downloads.pptx) }, '下载 PPTX')
                : null,
              downloads.md
                ? h('a', { className: 'dcn-btn', href: link(downloads.md), download: fileName(downloads.md) }, '下载 Markdown')
                : null,
              result.pagesOut ? h('span', { className: 'dcn-hint' }, result.pagesOut) : null)),
      )
    }

    // ──────────────────────────── the recap ───────────────────────────────

    /** `**bold**` is the only inline markup the model is asked to use. */
    function inlineNodes(text) {
      const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
      return parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return h('strong', { key: `b${index}` }, part.slice(2, -2))
        }
        return part === '' ? null : part
      })
    }

    /**
     * A small Markdown renderer for the recap: headings, bullet/numbered lists,
     * rules and paragraphs. Deliberately not a general parser — the prompt asks
     * for exactly these shapes, and anything else falls back to a paragraph.
     */
    function renderRecap(markdown) {
      const lines = String(markdown).replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let list = null
      let key = 0
      const flush = () => {
        if (list !== null) {
          blocks.push(h('ul', { key: `l${key++}`, className: 'dcn-md-list' }, list))
          list = null
        }
      }
      for (const raw of lines) {
        const line = raw.trim()
        if (line === '') {
          flush()
          continue
        }
        if (/^---+$/.test(line)) {
          flush()
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading !== null) {
          flush()
          const level = heading[1].length
          blocks.push(h('div', {
            key: `h${key++}`,
            className: level <= 2 ? 'dcn-md-h' : 'dcn-md-h dcn-md-h--sub',
          }, inlineNodes(heading[2])))
          continue
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(line)
        const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
        if (bullet !== null || numbered !== null) {
          if (list === null) list = []
          list.push(h('li', { key: `i${key++}` }, inlineNodes((bullet ?? numbered)[1])))
          continue
        }
        flush()
        blocks.push(h('div', { key: `p${key++}`, className: 'dcn-md-p' }, inlineNodes(line)))
      }
      flush()
      return blocks
    }

    function SummaryCard(props) {
      const { session, busy } = props
      const state = useSnapshot()
      const summary = session.summary ?? { at: null, model: '', markdown: '', error: '' }
      const recap = summary.markdown ?? ''
      const hasNotes = (session.progress?.chars ?? 0) > 0
      const working = busy === 'summary'
      const downloads = exportFor(state, session)?.downloads ?? {}
      const recapHref = downloads.summary === undefined
        ? null
        : String(downloads.summary).startsWith('/')
          ? downloads.summary
          : `${API}/sessions/${encodeURIComponent(session.id)}/file?name=${encodeURIComponent(downloads.summary)}`
      return h(Card, { head: '⑤ AI 纪要' },
        h('div', { className: 'dcn-row' },
          h(Button, {
            variant: recap === '' ? 'primary' : undefined,
            disabled: working || !hasNotes || (session.slides ?? []).length === 0,
            onClick: () => { void summarizeNotes(session.id) },
          }, working ? '正在整理…' : recap === '' ? '总结这节课' : '重新总结'),
          summary.at === null || summary.at === undefined ? null : h(Pill, { tone: 'ok' }, '已整理'),
          summary.model === '' || summary.model === undefined
            ? null
            : h('span', { className: 'dcn-hint dcn-hint--soft' }, summary.model)),
        recap === ''
          ? h('div', { className: 'dcn-hint' },
            hasNotes
              ? '把这一节课听到的内容整理成一份纪要：一句话概括、按顺序讲了什么、重点与易错、复习清单。'
              : '先记一点录音再来总结。')
          : h('div', { className: 'dcn-md' }, renderRecap(recap)),
        summary.error === '' || summary.error === undefined
          ? null
          : h('div', { className: 'dcn-hint dcn-hint--warn' }, summary.error),
        recap !== '' && recapHref !== null
          ? h('div', { className: 'dcn-row' }, h('a', { className: 'dcn-btn', href: recapHref, download: '听课纪要.md' }, '下载纪要'))
          : null,
      )
    }

    // ──────────────────────────── slide inspector ─────────────────────────

    function SlideRow(props) {
      const { session, slide, current, open, onToggle } = props
      const [draft, setDraft] = useState(slide.notes ?? '')
      const [kw, setKw] = useState('')
      const [saving, setSaving] = useState(false)
      useEffect(() => { setDraft(slide.notes ?? '') }, [slide.notes, slide.index])

      const keywords = slide.keywords ?? []
      const removeKeyword = (word) => {
        void saveSlide(session.id, slide.index, { keywords: keywords.filter((item) => item !== word) })
      }
      const addKeyword = () => {
        const word = kw.trim()
        if (word === '') return
        setKw('')
        if (keywords.includes(word)) return
        void saveSlide(session.id, slide.index, { keywords: [...keywords, word].slice(0, 40) })
      }
      const saveNotes = async () => {
        setSaving(true)
        const ok = await saveSlide(session.id, slide.index, { notes: draft })
        setSaving(false)
        if (ok) notify('success', `第 ${slide.index} 页备注存好了`)
      }

      return h('div', { className: `dcn-slide${current ? ' dcn-slide--current' : ''}` },
        h('div', { className: 'dcn-slide-head', onClick: onToggle },
          h('span', { className: 'dcn-slide-no' }, String(slide.index).padStart(2, '0')),
          h('span', { className: 'dcn-slide-title' }, slide.title === '' ? '（无标题）' : slide.title),
          h('span', { className: 'dcn-slide-meta' },
            `${keywords.length} 词 · ${slide.segmentCount ?? (slide.segments ?? []).length} 段`),
          current ? h(Pill, { tone: 'live' }, '在这页') : null),
        open
          ? h('div', { className: 'dcn-slide-body' },
            h('div', { className: 'dcn-hint' }, `关键词（${SOURCE_LABELS[slide.keywordSource] ?? '识别'}）`),
            h('div', { className: 'dcn-kw' },
              keywords.length === 0 ? h('span', { className: 'dcn-hint' }, '还没有') : null,
              keywords.map((word) => {
                const gloss = slide.keywordGlosses?.[word] ?? ''
                return h('span', {
                  key: word,
                  className: `dcn-chip${gloss === '' ? '' : ' dcn-chip--gloss'}`,
                  title: gloss === '' ? '还没有译文' : `录音里听到「${gloss}」也算命中`,
                },
                gloss === '' ? word : `${word} · ${gloss}`,
                h('button', {
                  type: 'button',
                  className: 'dcn-chip-x',
                  title: '删掉这个词',
                  onClick: (event) => { event.stopPropagation(); removeKeyword(word) },
                }, '×'))
              }),
            ),
            h('div', { className: 'dcn-row' },
              h('input', {
                className: 'dcn-input',
                style: { flex: 1, minWidth: 110 },
                placeholder: '补一个这页特有的词，回车加上',
                value: kw,
                onChange: (event) => setKw(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') addKeyword() },
              }),
              h(Button, { disabled: kw.trim() === '', onClick: addKeyword }, '加')),
            (slide.segments ?? []).length > 0
              ? h('div', { className: 'dcn-card-body' },
                (slide.segments ?? []).map((segment, index) => h('div', { key: `${segment.at}-${index}`, className: 'dcn-seg' }, segment.text)))
              : h('div', { className: 'dcn-hint' }, '这页还没有录音内容'),
            h('div', { className: 'dcn-hint' }, '自己的补充（会跟在录音笔记后面）'),
            h('textarea', {
              className: 'dcn-input dcn-textarea',
              value: draft,
              placeholder: '比如：这个定义老师说要背',
              onChange: (event) => setDraft(event.target.value),
            }),
            h('div', { className: 'dcn-row' },
              h(Button, { disabled: saving, onClick: () => { void saveNotes() } }, saving ? '保存中…' : '保存备注'),
              h(Button, {
                onClick: () => { void saveSlide(session.id, slide.index, { jump: true }) },
              }, '跳到这页')))
          : null,
      )
    }

    // ──────────────────────────────── panel ───────────────────────────────

    function SessionPanel(props) {
      const state = useSnapshot()
      const session = state.session
      const [openIndex, setOpenIndex] = useState(0)
      const [titleDraft, setTitleDraft] = useState('')
      const [courseDraft, setCourseDraft] = useState('')
      // Only this class's own work may spin its buttons.
      const busy = busyKind(state, session)

      useEffect(() => {
        setTitleDraft(session?.title ?? '')
        setCourseDraft(session?.course ?? '')
      }, [session?.id, session?.title, session?.course])

      useEffect(() => {
        if (session !== null) setOpenIndex(session.recording?.currentIndex ?? 1)
      }, [session?.id])

      if (session === null && state.sessionLoading === true) {
        return h('div', { className: 'dcn-empty' },
          h('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '正在打开这节课…'))
      }

      if (session === null) {
        return h('div', { className: 'dcn-empty' },
          h('div', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '还没有听课'),
          h('div', null, '新建一节课 → 放进这堂课的 PPT → 认出每页关键词 → 开始录音'),
          h('div', null, '讲到哪一页，录音就记到哪一页的备注里。'),
          h(Button, { variant: 'primary', disabled: state.busy?.kind === 'create', onClick: () => { void createSession() } }, '新建一节课'))
      }

      const slides = session.slides ?? []
      const liveActive = state.live.status === 'recording' && state.live.sessionId === session.id

      return h('div', null,
        h('div', { className: 'dcn-main-head' },
          h('div', { className: 'dcn-head-row' },
            h('input', {
              className: 'dcn-title-input',
              value: titleDraft,
              onChange: (event) => setTitleDraft(event.target.value),
              onBlur: () => {
                if (titleDraft !== session.title) void patchSession(session.id, { title: titleDraft })
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
            }),
            h(Pill, { tone: liveActive ? 'live' : session.status === 'done' ? 'ok' : undefined },
              liveActive ? '正在记' : (STATUS_LABELS[session.status] ?? session.status)),
            h(Button, { variant: 'danger', disabled: busy === 'delete', onClick: () => { void deleteSession(session.id) } }, '删掉')),
          h('div', { className: 'dcn-row' },
            h('span', { className: 'dcn-hint' }, '课程'),
            h('input', {
              className: 'dcn-input',
              style: { width: 160 },
              value: courseDraft,
              placeholder: '比如 数据科学导论',
              onChange: (event) => setCourseDraft(event.target.value),
              onBlur: () => {
                if (courseDraft !== session.course) void patchSession(session.id, { course: courseDraft })
              },
            }),
            h('span', { className: 'dcn-hint' }, session.date),
            h('span', { className: 'dcn-hint' }, `关键词 ${session.progress?.keywords ?? 0} · 录音 ${session.recording?.chunks ?? 0} 段 · 翻页 ${session.progress?.advances ?? 0} 次`))),
        h('div', { className: 'dcn-steps' },
          h(DeckCard, { session, busy }),
          h(KeywordsCard, { session, busy }),
          h(LiveCard, { session }),
          h(ExportCard, { session, busy }),
          h(SummaryCard, { session, busy })),
        h('div', { className: 'dcn-row', style: { marginBottom: 8, justifyContent: 'space-between' } },
          h('span', { className: 'dcn-side-title' }, `课件 ${slides.length} 页`),
          h('span', { className: 'dcn-hint' }, '点开一页能改关键词、看录音、写自己的补充')),
        h('div', { className: 'dcn-slides' },
          slides.map((slide) => h(SlideRow, {
            key: slide.index,
            session,
            slide,
            current: slide.index === (session.recording?.currentIndex ?? 0),
            open: openIndex === slide.index,
            onToggle: () => setOpenIndex(openIndex === slide.index ? 0 : slide.index),
          }))),
      )
    }

    function ClassNotesPanel() {
      const state = useSnapshot()
      const sessions = state.sessions ?? []

      useEffect(() => {
        void refreshAll()
        return undefined
      }, [])

      useEffect(() => {
        const timer = window.setInterval(() => { void refreshAll({ silent: true, autoSelect: false }) }, SPEECH_POLL_MS)
        return () => { window.clearInterval(timer) }
      }, [])

      return h('div', { className: 'dcn-shell' },
        h('aside', { className: 'dcn-side' },
          h('div', { className: 'dcn-side-head' },
            h('span', { className: 'dcn-side-title' }, '听课笔记'),
            h(Button, { disabled: state.busy?.kind === 'create', onClick: () => { void createSession() } }, '新建')),
          h('div', { className: 'dcn-side-list' },
            sessions.length === 0
              ? h('div', { className: 'dcn-hint', style: { padding: '10px 6px' } }, '还没有课，点右上角新建。')
              : sessions.map((item) => h('button', {
                key: item.id,
                type: 'button',
                className: `dcn-item${item.id === state.selectedId ? ' dcn-item--active' : ''}`,
                onClick: () => { void loadSession(item.id) },
              },
              h('span', { className: 'dcn-item-title' }, item.title === '' ? '未命名听课' : item.title),
              h('span', { className: 'dcn-item-meta' },
                h('span', null, STATUS_LABELS[item.status] ?? item.status),
                h('span', null, '·'),
                h('span', null, `${item.notedCount ?? 0}/${item.slideCount ?? 0} 页`),
                item.finishedAt ? h('span', null, '· 完成') : null))))),
        h('main', { className: 'dcn-main' },
          state.status === 'loading' && state.session === null
            ? h('div', { className: 'dcn-empty' }, '正在打开听课笔记…')
            : null,
          state.status === 'error' && state.session === null
            ? h('div', { className: 'dcn-empty' },
              h('div', null, state.error ?? '听课笔记服务没起来'),
              h(Button, { onClick: () => { void refreshAll() } }, '再试一次'))
            : null,
          state.status !== 'loading' && state.status !== 'error'
            ? h(SessionPanel, null)
            : null),
      )
    }

    // ──────────────────────────── plugin body ─────────────────────────────

    const inject = ['slots', 'layout']

    function apply(ctx) {
      clientContext = ctx
      ensureStyle()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'class-notes',
        order: 47,
        label: '听课笔记',
      }, ClassNotesGlyph))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'class-notes',
      }, ClassNotesPanel))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'class-notes-toasts',
        order: 31,
        label: '听课笔记通知',
      }, ToastOverlay))
      ctx.effect(() => {
        const timer = window.setInterval(() => {
          if (engine.status === 'recording') commitLive()
        }, 1000)
        return () => { window.clearInterval(timer) }
      }, 'class-notes: live clock')
      void refreshAll()
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})
