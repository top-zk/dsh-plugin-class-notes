/**
 * Unit test: the transcription mode reaches the speech service as the right
 * language hint, and an unsupported hint degrades instead of throwing.
 *
 *   node test/asr-modes.mjs
 */
import { createAsr } from '../lib/asr.js'
import { encodeWavFromFloat32 } from '../lib/wav.js'
import { asrLanguage, normalizeAsrMode } from '../lib/model.js'

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** A speech service that records what it was asked for. */
function fakeService(languages) {
  const calls = []
  return {
    calls,
    snapshot() {
      return {
        providers: [{ id: 'fake', name: 'Fake', languages, preparation: { phase: 'ready' } }],
        selection: { providerId: 'fake', language: 'auto' },
      }
    },
    prepare() {},
    async resolve(request) {
      calls.push(request.language)
      return { audio: request.audio, language: request.language }
    },
    async transcribe(spec) {
      return { text: `lang=${spec.language}`, audioSeconds: 1, inferenceSeconds: 0 }
    },
  }
}

/** Half a second of a quiet sine, enough to pass the "too short" check. */
function sampleWav(seconds = 0.6) {
  const rate = 16000
  const samples = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.2
  return encodeWavFromFloat32(samples, rate)
}

async function run(languages, requested, mode) {
  const speech = fakeService(languages)
  const asr = createAsr({ ctx: { get: (name) => (name === 'speechToText' ? speech : null) }, logger: null })
  const result = await asr.transcribeWav(sampleWav(), { language: asrLanguage(mode), allowEmpty: true })
  return { asked: speech.calls[0] ?? null, text: result.text, requested }
}

check(normalizeAsrMode('zh') === 'zh', 'zh 模式保留')
check(normalizeAsrMode('en') === 'en', 'en 模式保留')
check(normalizeAsrMode('mixed') === 'mixed', 'mixed 模式保留')
check(normalizeAsrMode('klingon') === 'mixed', '未知模式退回中英混合')
check(asrLanguage('zh') === 'zh' && asrLanguage('mixed') === 'auto' && asrLanguage('en') === 'en', '模式映射到识别语言')

const full = ['auto', 'zh', 'en', 'yue']
for (const [mode, expected] of [['zh', 'zh'], ['mixed', 'auto'], ['en', 'en']]) {
  const got = await run(full, expected, mode)
  check(got.asked === expected, `${mode} → ${expected}`, `实际 ${got.asked}`)
}

const zhOnly = ['auto', 'zh']
const degraded = await run(zhOnly, 'auto', 'en')
check(degraded.asked === 'auto', '只有 zh 的服务，en 模式退到 auto', `实际 ${degraded.asked}`)

const enOnly = ['en']
const strict = await run(enOnly, 'en', 'zh')
check(strict.asked === 'en', '只有 en 的服务，zh 模式退到 en', `实际 ${strict.asked}`)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
