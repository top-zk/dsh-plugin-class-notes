import { readFile } from 'node:fs/promises'

const file = process.argv[2]
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? 1e9)
const text = await readFile(file, 'utf8')
let depth = 0
let line = 1
let quote = null
let template = 0
let escape = false
let comment = null
const report = []
for (let i = 0; i < text.length; i += 1) {
  const ch = text[i]
  if (ch === '\n') {
    if (line >= from && line <= to) report.push([line, depth, quote, template, comment])
    line += 1
    if (comment === 'line') comment = null
    escape = false
    continue
  }
  if (comment === 'line') continue
  if (comment === 'block') {
    if (ch === '*' && text[i + 1] === '/') { comment = null; i += 1 }
    continue
  }
  if (quote !== null) {
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === quote) quote = null
    continue
  }
  if (ch === '/' && text[i + 1] === '/') { comment = 'line'; i += 1; continue }
  if (ch === '/' && text[i + 1] === '*') { comment = 'block'; i += 1; continue }
  if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
  if (ch === '(' || ch === '[' || ch === '{') depth += 1
  else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
}
for (const [n, d, q, t, c] of report) console.log(`${String(n).padStart(5)}: depth ${d}${q ? ` quote ${q}` : ''}`)
