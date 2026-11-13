/**
 * Durable session store.
 *
 * One JSON document per class session under
 * `$DSH_HOME/storages/class-notes/<id>/session.json`, next to the uploaded deck
 * (`source.pptx`) and every export the panel produced. Per-file storage keeps a
 * long lecture's transcript out of one giant blob and makes "delete this class"
 * a single directory removal.
 *
 * Writes go through one promise chain and land via temp-file + rename, so a
 * reader never sees a half-written session and a crash cannot tear the file.
 *
 * @module dsh-plugin-class-notes/store
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataDir } from './runtime.js'
import { newId, normalizeSession } from './model.js'

/** Per-session files. */
export const SESSION_FILE = 'session.json'
/** The uploaded deck, kept immutable so exports always have a clean source. */
export const SOURCE_FILE = 'source.pptx'

/** One session's directory. */
export function sessionDir(id) {
  return join(dataDir(), id)
}

/** Durable write: temp file then rename. */
async function atomicWrite(file, text) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/** In-memory cache + serialized durable writes. */
export class ClassNotesStore {
  /** @type {Map<string, {session: object, mtime: number}>} */
  #cache = new Map()
  #chain = Promise.resolve()
  #logger
  #root

  /** @param options - `root`, `logger`. */
  constructor(options = {}) {
    this.#root = options.root ?? dataDir()
    this.#logger = options.logger
  }

  /** Root directory holding every session directory. */
  get root() {
    return this.#root
  }

  /** Absolute path of one session document. */
  file(id) {
    return join(this.#root, id, SESSION_FILE)
  }

  /** Absolute path of one session's uploaded deck. */
  sourcePath(id) {
    return join(this.#root, id, SOURCE_FILE)
  }

  /** Absolute path inside one session's directory. */
  pathIn(id, name) {
    return join(this.#root, id, name)
  }

  /** Ensure the session directory exists and return it. */
  async prepareDir(id) {
    const dir = join(this.#root, id)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** Run one mutation on the serialized write chain. */
  #exclusive(task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Read from disk, bypassing the cache. */
  async #loadFromDisk(key) {
    const file = this.file(key)
    let info
    try {
      info = await stat(file)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#cache.delete(key)
        return null
      }
      throw error
    }
    const cached = this.#cache.get(key)
    if (cached !== undefined && cached.mtime === info.mtimeMs) return cached.session

    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#logger?.warn?.(`class-notes: unreadable session ${file} (${String(error?.message ?? error)})`)
      return null
    }
    const session = normalizeSession(parsed, { now: new Date(parsed?.createdAt ?? Date.now()) })
    this.#cache.set(key, { session, mtime: info.mtimeMs })
    return session
  }

  /**
   * Read one session, honoring the cache when the file is unchanged.
   * @param {string} id - session id.
   * @returns {Promise<object|null>} the canonical session or null.
   */
  async read(id) {
    const key = String(id ?? '')
    if (key === '' || key.includes('/') || key.includes('\\') || key.includes('..')) return null
    return this.#loadFromDisk(key)
  }

  /** Persist a fully normalized session (no locking: internal use only). */
  async #persist(session) {
    const dir = await this.prepareDir(session.id)
    const file = join(dir, SESSION_FILE)
    await atomicWrite(file, `${JSON.stringify(session, null, 2)}\n`)
    const info = await stat(file)
    this.#cache.set(session.id, { session, mtime: info.mtimeMs })
    return session
  }

  /** Persist one session (creating it when needed). */
  async write(session) {
    return this.#exclusive(async () => {
      const now = new Date()
      const normalized = normalizeSession(session, { now })
      normalized.updatedAt = now.toISOString()
      return this.#persist(normalized)
    })
  }

  /**
   * Load → mutate → persist under one lock.
   * @param {string} id - session id.
   * @param {(session: object) => (object|void|Promise<object|void>)} mutate - mutator.
   * @returns {Promise<object>} the persisted session.
   */
  async update(id, mutate) {
    return this.#exclusive(async () => {
      const current = await this.#loadFromDisk(String(id ?? ''))
      if (current === null) {
        const error = new Error(`未找到听课记录：${id}`)
        error.status = 404
        throw error
      }
      const draft = structuredClone(current)
      const result = await mutate(draft)
      const now = new Date()
      const next = normalizeSession(result ?? draft, { now })
      next.createdAt = current.createdAt
      next.updatedAt = now.toISOString()
      return this.#persist(next)
    })
  }

  /** Create a brand-new empty session (no deck yet). */
  async create(input = {}) {
    const now = new Date()
    const session = normalizeSession(
      {
        id: newId('cls', now),
        title: input.title,
        course: input.course,
        date: input.date ?? undefined,
        asrMode: input.asrMode,
        status: 'draft',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        slides: [],
      },
      { now },
    )
    await this.prepareDir(session.id)
    return this.write(session)
  }

  /** List every session directory, newest first. */
  async list() {
    let entries = []
    try {
      entries = await readdir(this.#root, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const session = await this.read(entry.name)
      if (session !== null) sessions.push(session)
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return sessions
  }

  /** Delete one session directory (deck, notes, exports). */
  async remove(id) {
    const key = String(id ?? '')
    if (key === '' || key.includes('/') || key.includes('\\') || key.includes('..')) {
      throw new Error(`非法的听课记录 id：${id}`)
    }
    return this.#exclusive(async () => {
      this.#cache.delete(key)
      await rm(join(this.#root, key), { recursive: true, force: true })
      return { ok: true, id: key }
    })
  }

  /** Whether a session has an uploaded deck on disk. */
  hasDeck(id) {
    return existsSync(this.sourcePath(id))
  }
}
