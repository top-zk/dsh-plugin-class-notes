import { readFile } from "node:fs/promises"
const base = "http://127.0.0.1:65039/dsh-class-notes"
const j = async (p, o) => (await fetch(base + p, o)).json()
const created = await j("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "探针" }) })
const id = created.session.id
const bytes = await readFile("test/demo-lecture.pptx")
const up = await j(`/sessions/${id}/deck`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": "demo-lecture.pptx" }, body: bytes })
console.log("slides:", up.session.slides.length)
for (const s of up.session.slides) console.log(s.index, JSON.stringify(s.title), "notes=", JSON.stringify(s.notes ?? ""), "kw=", (s.keywords||[]).length)
await j(`/sessions/${id}`, { method: "DELETE" })
