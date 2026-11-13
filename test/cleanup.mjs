/**
 * Remove the leftovers of test runs. Only title patterns that tests use are
 * touched — real lessons in the panel are never deleted.
 *
 * The GUI port changes between launches, so the base URL comes from
 * DSH_WEB_URL (or argv[2]) instead of a hard-coded port.
 */
const base = `${(process.env.DSH_WEB_URL ?? process.argv[2] ?? 'http://127.0.0.1:54235').replace(/\/$/, '')}/dsh-class-notes`
const j = async (p, o) => (await fetch(base + p, o)).json()
const s = await j('/state')
for (const item of s.sessions) {
  console.log(item.id, item.title, item.slideCount)
  if (/探针|HTTP 联调课|联调|隔离测试/.test(item.title)) {
    await j(`/sessions/${item.id}`, { method: 'DELETE' })
    console.log('  deleted')
  }
}
const after = await j('/state')
console.log('剩余', after.sessions.length)
