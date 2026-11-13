/**
 * Just enough WAV handling to talk to the local recognizer.
 *
 * The panel records 16kHz mono PCM16 and encodes the canonical 44-byte header,
 * but a body can still arrive from a different recorder or a future client, so
 * every chunk is validated here and rebuilt with a clean header before it goes
 * to the speech service. The native recognizer's wave reader rejects odd chunks
 * (LIST/INFO and friends) that a general decoder would happily tolerate.
 *
 * @module dsh-plugin-class-notes/wav
 */

/** Bytes in the canonical RIFF/WAVE header we emit. */
export const CANONICAL_HEADER_BYTES = 44

/** Read a little-endian u32. */
function readU32(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

/** Read a little-endian u16. */
function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

/** Write a little-endian u32. */
function writeU32(view, offset, value) {
  view[offset] = value & 0xff
  view[offset + 1] = (value >>> 8) & 0xff
  view[offset + 2] = (value >>> 16) & 0xff
  view[offset + 3] = (value >>> 24) & 0xff
}

/** Write a little-endian u16. */
function writeU16(view, offset, value) {
  view[offset] = value & 0xff
  view[offset + 1] = (value >>> 8) & 0xff
}

/** Normalize any byte container to Uint8Array. */
export function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('音频数据格式不正确，需要 WAV 字节')
}

/**
 * Walk the RIFF chunks and report what the file actually contains.
 * @param {Uint8Array|ArrayBuffer} value - wav bytes.
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number, dataOffset: number, dataBytes: number, seconds: number, format: number}}
 */
export function readWavInfo(value) {
  const bytes = asBytes(value)
  if (bytes.length < 12) throw new Error('音频太短，不是有效的 WAV')
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  if (tag !== 'RIFF' || wave !== 'WAVE') throw new Error('音频不是 WAV 格式')

  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let format = 0
  let dataOffset = -1
  let dataBytes = 0

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = readU32(bytes, offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = readU16(bytes, body)
      channels = readU16(bytes, body + 2)
      sampleRate = readU32(bytes, body + 4)
      bitsPerSample = readU16(bytes, body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, bytes.length - body)
      break
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0) throw new Error('WAV 里没有 data 段')
  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0) throw new Error('WAV 的 fmt 段不完整')
  if (format !== 1) throw new Error('只支持未压缩的 PCM WAV')

  const frameBytes = (channels * bitsPerSample) / 8
  const seconds = frameBytes > 0 ? dataBytes / frameBytes / sampleRate : 0
  return { sampleRate, channels, bitsPerSample, dataOffset, dataBytes, seconds, format }
}

/**
 * Rebuild a WAV with the canonical 44-byte header, keeping only the samples.
 * @param {Uint8Array|ArrayBuffer} value - source wav.
 * @returns {Uint8Array} canonical wav.
 */
export function toCanonicalWav(value) {
  const bytes = asBytes(value)
  const info = readWavInfo(bytes)
  const data = bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes)
  const out = new Uint8Array(CANONICAL_HEADER_BYTES + data.length)
  const view = out
  const tag = (offset, text) => {
    for (let index = 0; index < 4; index += 1) view[offset + index] = text.charCodeAt(index)
  }
  const byteRate = (info.sampleRate * info.channels * info.bitsPerSample) / 8
  const blockAlign = (info.channels * info.bitsPerSample) / 8

  tag(0, 'RIFF')
  writeU32(view, 4, 36 + data.length)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  writeU32(view, 16, 16)
  writeU16(view, 20, 1)
  writeU16(view, 22, info.channels)
  writeU32(view, 24, info.sampleRate)
  writeU32(view, 28, byteRate)
  writeU16(view, 32, blockAlign)
  writeU16(view, 34, info.bitsPerSample)
  tag(36, 'data')
  writeU32(view, 40, data.length)
  out.set(data, CANONICAL_HEADER_BYTES)
  return out
}

/**
 * Convert a float32 chunk of mono samples into a complete 16-bit WAV.
 * Used by the server-side tests, where no AudioContext is available.
 * @param {Float32Array} samples - samples in [-1, 1].
 * @param {number} sampleRate - output rate.
 */
export function encodeWavFromFloat32(samples, sampleRate = 16_000) {
  const data = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    data[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff)
  }
  const out = new Uint8Array(CANONICAL_HEADER_BYTES + data.byteLength)
  const view = out
  const tag = (offset, text) => {
    for (let index = 0; index < 4; index += 1) view[offset + index] = text.charCodeAt(index)
  }
  const dataBytes = data.byteLength
  tag(0, 'RIFF')
  writeU32(view, 4, 36 + dataBytes)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  writeU32(view, 16, 16)
  writeU16(view, 20, 1)
  writeU16(view, 22, 1)
  writeU32(view, 24, sampleRate)
  writeU32(view, 28, sampleRate * 2)
  writeU16(view, 32, 2)
  writeU16(view, 34, 16)
  tag(36, 'data')
  writeU32(view, 40, dataBytes)
  out.set(new Uint8Array(data.buffer, data.byteOffset, dataBytes), CANONICAL_HEADER_BYTES)
  return out
}
