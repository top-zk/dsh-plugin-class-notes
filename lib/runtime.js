/**
 * Runtime plumbing shared by every host-side module: where the profile lives,
 * how to find the bundled Python, and how to run one Python helper safely.
 *
 * The plugin never bundles its own Python or python-pptx: the DSH primary
 * runtime payload already ships both, and the panel only ever talks to this
 * half over loopback HTTP. Keeping the resolvers here means the rest of the
 * host code can stay about lecture notes instead of about process management.
 *
 * @module dsh-plugin-class-notes/runtime
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of this module (`lib/`). */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))
/** Package root. */
export const PACKAGE_ROOT = resolve(LIB_DIR, '..')
/** Directory holding the two Python helpers. */
export const PYTHON_DIR = join(PACKAGE_ROOT, 'python')

/** `$DSH_HOME`, i.e. the profile root, falling back to the OS home. */
export function dshHome() {
  const value = process.env.DSH_HOME
  if (typeof value === 'string' && value.trim() !== '') return resolve(value.trim())
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
  return join(home, '.dsh')
}

/** Durable data root for this plugin. */
export function dataDir() {
  return join(dshHome(), 'storages', 'class-notes')
}

/** The directory the user is working in — where exported decks land by default. */
export function workspaceDir() {
  const value = process.env.DSH_WORKSPACE ?? process.env.DSH_CWD
  return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : process.cwd()
}

/** One candidate Python interpreter, in priority order. */
function pythonCandidates() {
  const list = []
  if (typeof process.env.DSH_PYTHON === 'string' && process.env.DSH_PYTHON.trim() !== '') {
    list.push(resolve(process.env.DSH_PYTHON.trim()))
  }
  if (typeof process.env.DSH_PYTHON_PATH === 'string' && process.env.DSH_PYTHON_PATH.trim() !== '') {
    list.push(resolve(process.env.DSH_PYTHON_PATH.trim()))
  }

  // The default layout: <DSH_HOME>/dsh-runtimes/<runtime>/dependencies/python/python.exe
  const runtimes = join(dshHome(), 'dsh-runtimes')
  if (existsSync(runtimes)) {
    let entries = []
    try {
      entries = readdirSync(runtimes)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const base = join(runtimes, entry, 'dependencies', 'python')
      list.push(join(base, 'python.exe'), join(base, 'bin', 'python3'), join(base, 'bin', 'python'))
    }
  }

  // The runtime payload shipped next to the app, if the app is not asar-wrapped.
  const resources = process.env.DSH_RESOURCES_DIR
  if (typeof resources === 'string' && resources.trim() !== '') {
    const base = join(resolve(resources.trim()), 'dsh', 'node_modules')
    list.push(join(base, 'python', 'python.exe'))
  }

  list.push('python.exe', 'python3', 'python')
  return list
}

/** Cached interpreter path (or null when nothing usable was found). */
let cachedPython = null

/**
 * Resolve the Python interpreter used by the two helper scripts.
 * @param {object} [options] - `refresh: true` bypasses the cache.
 * @returns {string} an absolute path, or a bare command name for PATH lookup.
 */
export function pythonExecutable(options = {}) {
  if (!options.refresh && cachedPython !== null) return cachedPython
  const candidates = pythonCandidates()
  for (const candidate of candidates) {
    if (candidate === 'python.exe' || candidate === 'python3' || candidate === 'python') {
      cachedPython = candidate
      return candidate
    }
    if (existsSync(candidate)) {
      cachedPython = candidate
      return candidate
    }
  }
  cachedPython = 'python'
  return cachedPython
}

/**
 * Run one Python helper and parse the single JSON object it prints.
 *
 * The helpers always print JSON on stdout — including on failure — so a
 * non-zero exit still yields a readable Chinese message instead of a traceback.
 *
 * @param {string} script - script file name inside `python/`.
 * @param {string[]} args - command-line arguments.
 * @param {object} [options] - `{ timeoutMs, signal, env }`.
 * @returns {Promise<object>} the parsed JSON payload.
 */
export function runPythonJson(script, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const file = join(PYTHON_DIR, script)
  const executable = pythonExecutable()
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...(options.env ?? {}),
  }

  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(executable, [file, ...args], { env, windowsHide: true })
    } catch (error) {
      reject(new Error(`无法启动 Python（${executable}）：${error?.message ?? error}`))
      return
    }

    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* the process is already gone */
      }
      reject(new Error(`Python 执行超时（${Math.round(timeoutMs / 1000)} 秒）：${script}`))
    }, timeoutMs)

    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      const error = new Error('已取消')
      error.name = 'AbortError'
      reject(error)
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      reject(new Error(`Python 启动失败：${error?.message ?? error}（解释器：${executable}）`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (out === '') {
        reject(
          new Error(
            err === ''
              ? `Python 没有输出（退出码 ${code}）：${script}`
              : `Python 执行失败（退出码 ${code}）：${err.slice(0, 600)}`,
          ),
        )
        return
      }
      try {
        resolvePromise(JSON.parse(out))
      } catch {
        reject(new Error(`Python 输出不是 JSON：${out.slice(0, 400)}`))
      }
    })
  })
}

/**
 * Write one JSON job file for a Python helper.
 * @param {string} path - target file.
 * @param {object} payload - JSON-serializable payload.
 */
export function writeJsonFile(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload), 'utf8')
}
