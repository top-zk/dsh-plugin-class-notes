/**
 * Speech recognition seam.
 *
 * The harness registers a `speechToText` service (local SenseVoice by default).
 * This module wraps it in the three calls the recorder needs — `status`,
 * `prepare`, `transcribeWav` — and turns every failure into a Chinese sentence
 * the panel can show, instead of letting an undefined method blow up a route.
 *
 * @module dsh-plugin-class-notes/asr
 */

import { toCanonicalWav, readWavInfo } from './wav.js'

/** Service name in the Cordis container. */
export const SPEECH_SERVICE = 'speechToText'

/** Phases that mean "ready to transcribe". */
const READY_PHASES = new Set(['ready', 'standby'])

/** How long to wait for the local model to finish downloading/loading. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000

/** Poll interval while the model prepares. */
const POLL_MS = 1500

/** Extract readable text from anything thrown. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Abort-shaped error, matching DOM semantics. */
function abortError(text = '已取消') {
  const error = new Error(text)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Sleep that honors an AbortSignal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Normalize one provider entry. */
function normalizeProvider(provider) {
  const preparation = provider?.preparation ?? {}
  return {
    id: typeof provider?.id === 'string' ? provider.id : String(provider?.id ?? ''),
    name: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : '本地语音识别',
    languages: Array.isArray(provider?.languages) ? provider.languages.map(String) : [],
    phase: typeof preparation.phase === 'string' ? preparation.phase : 'unprepared',
    message: typeof preparation.message === 'string' ? preparation.message : null,
    completedBytes: Number.isFinite(preparation.completedBytes) ? preparation.completedBytes : 0,
    totalBytes: Number.isFinite(preparation.totalBytes) ? preparation.totalBytes : 0,
  }
}

/**
 * Pick a language hint the selected provider actually advertises.
 *
 * A session may ask for `en` while the installed provider only knows
 * `zh`/`auto`; asking for the unsupported code makes the service throw, so fall
 * back to `auto` (then to whatever it does offer).
 */
function resolveLanguage(state, providerId, wanted) {
  const provider = state.providers.find((item) => item.id === providerId) ?? null
  const supported = provider?.languages ?? []
  if (supported.length === 0) return wanted
  if (supported.includes(wanted)) return wanted
  if (supported.includes('auto')) return 'auto'
  return supported[0]
}

/**
 * Create the recognizer facade.
 * @param {object} options - `{ ctx, logger, config }`.
 */
export function createAsr(options = {}) {
  const ctx = options.ctx
  const logger = options.logger
  const language = typeof options.config?.language === 'string' ? options.config.language : 'zh'

  /** The host service, or null when this build does not ship one. */
  function service() {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null
    try {
      return ctx.get(SPEECH_SERVICE) ?? null
    } catch {
      return null
    }
  }

  /** What the panel needs to render the microphone section. */
  function status() {
    const speech = service()
    if (speech === null || typeof speech.snapshot !== 'function') {
      return {
        available: false,
        error: '本机语音识别服务未启用（缺少 speechToText 服务）',
        providers: [],
        providerId: null,
        language,
        phase: 'unavailable',
      }
    }
    let snapshot
    try {
      snapshot = speech.snapshot()
    } catch (error) {
      return {
        available: false,
        error: `读取语音识别状态失败：${messageOf(error)}`,
        providers: [],
        providerId: null,
        language,
        phase: 'unavailable',
      }
    }
    const providers = (Array.isArray(snapshot?.providers) ? snapshot.providers : []).map(normalizeProvider)
    const selected =
      typeof snapshot?.selection?.providerId === 'string' && snapshot.selection.providerId !== ''
        ? snapshot.selection.providerId
        : providers[0]?.id ?? null
    const active = providers.find((provider) => provider.id === selected) ?? providers[0] ?? null
    return {
      available: providers.length > 0,
      error: providers.length === 0 ? '本机语音识别服务未启用' : null,
      providers,
      providerId: active?.id ?? null,
      language: typeof snapshot?.selection?.language === 'string' ? snapshot.selection.language : language,
      phase: active?.phase ?? 'unavailable',
      message: active?.message ?? null,
      progress:
        active === null || active.totalBytes <= 0
          ? 0
          : Math.min(1, active.completedBytes / active.totalBytes),
    }
  }

  /** Ask the service to download/load the model; does not wait. */
  function prepare(providerId) {
    const speech = service()
    if (speech === null) throw new Error('本机语音识别服务未启用，无法准备模型')
    if (typeof speech.prepare !== 'function') throw new Error('当前语音识别服务不支持准备模型')
    const id = typeof providerId === 'string' && providerId !== '' ? providerId : status().providerId
    if (id === null) throw new Error('没有可用的语音识别 provider')
    const pending = speech.prepare(id)
    if (pending !== null && typeof pending?.then === 'function') pending.catch(() => undefined)
    return status()
  }

  /** Wait until the selected provider can transcribe. */
  async function ensureReady(speech, providerId, signal) {
    const current = status()
    if (current.available !== true) throw new Error(current.error ?? '本机语音识别服务未启用')
    const id = providerId ?? current.providerId
    if (id === null) throw new Error('没有可用的语音识别 provider')
    const find = (state) => state.providers.find((provider) => provider.id === id) ?? null

    let provider = find(current)
    if (provider !== null && READY_PHASES.has(provider.phase)) return id
    if (provider !== null && provider.phase === 'failed') {
      throw new Error(`语音识别模型准备失败：${provider.message ?? '未知原因'}`)
    }

    logger?.info?.(`class-notes: preparing speech model ${id} (phase ${provider?.phase ?? 'unknown'})`)
    prepare(id)
    const deadline = Date.now() + PREPARE_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS, signal)
      const next = status()
      if (next.available !== true) throw new Error(next.error ?? '本机语音识别服务未启用')
      provider = find(next)
      if (provider === null) throw new Error(`语音识别 provider 在准备过程中消失：${id}`)
      if (READY_PHASES.has(provider.phase)) return id
      if (provider.phase === 'failed') {
        throw new Error(`语音识别模型准备失败：${provider.message ?? '未知原因'}`)
      }
    }
    throw new Error(`语音识别模型准备超时（${Math.round(PREPARE_TIMEOUT_MS / 1000)} 秒），第一次使用要下载模型`)
  }

  /**
   * Transcribe one WAV chunk.
   *
   * @param {Uint8Array} bytes - 16kHz mono PCM16 WAV.
   * @param {object} [callOptions] - `{ signal, providerId, allowEmpty, language }`.
   *   `allowEmpty: true` returns `{ text: '' }` for silence instead of throwing,
   *   which is what a live recorder needs between sentences. `language` overrides
   *   the configured hint for this chunk (the per-session transcription mode).
   * @returns {Promise<{text: string, audioSeconds: number, inferenceSeconds: number}>}
   */
  async function transcribeWav(bytes, callOptions = {}) {
    const signal = callOptions.signal ?? new AbortController().signal
    const speech = service()
    if (speech === null) throw new Error('本机语音识别服务未启用，无法转写音频')
    if (typeof speech.resolve !== 'function' || typeof speech.transcribe !== 'function') {
      throw new Error('当前语音识别服务缺少 resolve/transcribe 方法')
    }

    const info = readWavInfo(bytes)
    if (info.seconds < 0.15) throw new Error('音频太短，没有可识别的内容')
    const canonical = toCanonicalWav(bytes)
    const id = await ensureReady(speech, callOptions.providerId ?? null, signal)
    if (signal.aborted) throw abortError()

    const hint = resolveLanguage(status(), id, callOptions.language ?? language)
    if (hint !== language) logger?.debug?.(`class-notes: transcribing with language ${hint}`)

    let spec
    try {
      spec = await speech.resolve({ audio: canonical, language: hint, providerId: id })
    } catch (error) {
      throw new Error(`语音识别准备失败：${messageOf(error)}`)
    }
    if (spec === null || spec === undefined) throw new Error('语音识别服务没有返回可用的转写规格')

    let result
    try {
      result = await speech.transcribe(spec, signal)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new Error(`语音识别失败：${messageOf(error)}`)
    }

    const text = typeof result?.text === 'string' ? result.text.trim() : ''
    if (text === '' && callOptions.allowEmpty !== true) {
      throw new Error('这一片没有识别出文字')
    }
    return {
      text,
      // The WAV header is authoritative: the recognizer's own count is measured
      // on the resampled copy and can differ by a frame, which would make a
      // lesson's "how much was recorded" drift away from the truth.
      audioSeconds: info.seconds,
      inferenceSeconds: Number.isFinite(Number(result?.inferenceSeconds)) ? Number(result.inferenceSeconds) : 0,
    }
  }

  return { status, prepare, transcribeWav }
}
