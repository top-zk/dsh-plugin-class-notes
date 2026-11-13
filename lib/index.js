/**
 * Host half of the class-notes plugin.
 *
 * Responsibilities:
 * - own the durable session documents (`$DSH_HOME/storages/class-notes/<id>/`),
 * - ingest uploaded `.pptx` decks through the bundled Python + python-pptx,
 * - extract per-slide keywords (heuristic, refined through the default model),
 * - transcribe five-second WAV chunks through the harness `speechToText` service
 *   and attach each transcript row to whichever slide is currently being taught,
 * - export an annotated `.pptx` (speaker notes) plus a Markdown transcript.
 *
 * The browser half (`./client`) renders the panel and is discovered from this
 * package's `dsh.client` declaration — no second loader entry is needed.
 *
 * @module dsh-plugin-class-notes
 */

import { createAsr } from './asr.js'
import { ROUTE_PREFIX, registerRoutes } from './server.js'
import { ClassNotesStore } from './store.js'
import { workspaceDir } from './runtime.js'

/** Loader-facing plugin name. */
export const name = 'class-notes'

/** Services required before the host half can start. */
export const inject = ['webServer']

export { ROUTE_PREFIX }

/**
 * Plugin body.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  const logger = ctx.logger
  const store = new ClassNotesStore({ logger })
  const asr = createAsr({ ctx, logger, config: { language: 'zh' } })

  /** The current default model route, or `{ llm: null }` when unset. */
  function modelRoute() {
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? null
      if (selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        return { provider: null, model: null, label: '未配置默认模型', llm: null }
      }
      return {
        provider: selection.provider,
        model: selection.model,
        label: `${selection.provider} · ${selection.model}`,
        llm: {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        },
      }
    } catch (error) {
      logger?.warn?.(`class-notes: 读取默认模型失败：${String(error?.message ?? error)}`)
      return { provider: null, model: null, label: '未配置默认模型', llm: null }
    }
  }

  /** The `llm` service, read lazily: the panel only needs it for keywords. */
  function llmService() {
    try {
      return ctx.get?.('llm') ?? null
    } catch {
      return null
    }
  }

  const deps = {
    store,
    asr,
    logger,
    modelRoute,
    get llm() {
      return llmService()
    },
  }

  ctx.effect(() => registerRoutes(ctx, deps), 'class-notes: http routes')

  ctx.effect(() => {
    logger?.info?.(`class-notes: ready — api ${ROUTE_PREFIX}, data ${store.root}, export dir ${workspaceDir()}`)
    return () => undefined
  }, 'class-notes: boot log')

  // Warm the speech status once so a first upload reports a useful phase rather
  // than an empty snapshot, and never let that warm-up failure escape.
  Promise.resolve()
    .then(() => asr.status())
    .then(
      (status) => {
        if (status.available !== true) logger?.warn?.(`class-notes: ${status.error ?? '语音识别不可用'}`)
      },
      () => undefined,
    )
}
