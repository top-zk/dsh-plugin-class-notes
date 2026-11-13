#!/usr/bin/env python3
"""Write class notes back into a .pptx (speaker notes) and/or export text pages.

Two jobs, both idempotent:

1. `--notes` mode: take the deck (or a copy of it) and write each slide's
   accumulated lecture transcript into that slide's speaker notes. The block the
   plugin owns is fenced with markers, so running this twice replaces only its
   own block and never touches notes the teacher already had.

2. `--pages` mode: render a `姓名：内容` text report of the whole deck (slide
   titles, keywords and the note body) which the panel shows as a preview and
   offers as a .md download.

Usage:
    python write_notes.py --json <job.json>

where job.json is:
{
  "mode": "notes" | "pages" | "both",
  "source": "C:/path/deck.pptx",          # 原始 PPT（只读，不修改）
  "target": "C:/path/deck-听课笔记.pptx",  # 写备注的输出文件（mode 含 notes 时必填）
  "pagesOut": "C:/path/deck-听课笔记.md",  # 文本报告输出路径（mode 含 pages 时必填）
  "title": "第 3 讲 机器学习入门",
  "date": "2026-11-06",
  "bySlide": [
    {"index": 1, "title": "什么是机器学习", "note": "第一页讲的内容…"}
  ]
}

Output (stdout, UTF-8 JSON): {"ok": true, "target": "...", "notesWritten": 12,
"pagesOut": "...", "pages": ["..."]}
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from pptx import Presentation
except Exception as exc:  # pragma: no cover
    sys.stdout.write(json.dumps({"ok": False, "error": f"缺少 python-pptx：{exc}"}, ensure_ascii=False))
    sys.exit(3)

NOTE_START = "【听课笔记 · 录音整理】"
NOTE_END = "【听课笔记结束】"


def read_job(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    if not isinstance(job, dict):
        raise ValueError("job.json 必须是一个 JSON 对象")
    return job


def notes_map(job: dict) -> dict[int, dict]:
    """Normalize the bySlide list into {index: entry}."""
    out: dict[int, dict] = {}
    raw = job.get("bySlide")
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            index = int(entry.get("index"))
        except (TypeError, ValueError):
            continue
        if index < 1:
            continue
        note = entry.get("note")
        out[index] = {
            "index": index,
            "title": str(entry.get("title") or ""),
            "note": str(note).strip() if isinstance(note, str) else "",
        }
    return out


def build_note_block(job: dict, entry: dict) -> str:
    header_title = str(job.get("title") or "").strip()
    date = str(job.get("date") or "").strip()
    lines = [NOTE_START]
    meta = " · ".join(part for part in (header_title, date) if part != "")
    if meta != "":
        lines.append(meta)
    if entry.get("title"):
        lines.append(f"本页：{entry['title']}")
    lines.append("")
    lines.append(entry.get("note") or "（这一页没有识别到讲课内容）")
    lines.append(NOTE_END)
    return "\n".join(lines)


def merge_note(existing: str, block: str) -> str:
    """Replace our own fenced block, keep anything the teacher wrote by hand."""
    text = existing or ""
    if NOTE_START in text:
        head, _, rest = text.partition(NOTE_START)
        if NOTE_END in rest:
            tail = rest.partition(NOTE_END)[2]
        else:
            tail = ""
        head = head.rstrip("\n")
        tail = tail.strip("\n")
        pieces = [piece for piece in (head, block, tail) if piece != ""]
        return "\n\n".join(pieces) + "\n"
    if text.strip() == "":
        return block + "\n"
    return text.rstrip("\n") + "\n\n" + block + "\n"


def write_notes(job: dict, source: str, target: str) -> dict:
    if target == "":
        raise ValueError("写备注需要 target 路径")
    presentation = Presentation(source)
    by_slide = notes_map(job)
    written = 0
    for position, slide in enumerate(presentation.slides, start=1):
        entry = by_slide.get(position)
        if entry is None:
            continue
        frame = slide.notes_slide.notes_text_frame
        if frame is None:
            continue
        existing = frame.text
        block = build_note_block(job, entry)
        merged = merge_note(existing, block)
        # clear() drops every paragraph but keeps one empty wrapper, so re-adding
        # one paragraph per line is enough to rebuild the note verbatim.
        frame.clear()
        first = True
        for line in merged.rstrip("\n").split("\n"):
            paragraph = frame.paragraphs[0] if first else frame.add_paragraph()
            first = False
            paragraph.add_run().text = line
        written += 1
    directory = os.path.dirname(os.path.abspath(target))
    if directory:
        os.makedirs(directory, exist_ok=True)
    presentation.save(target)
    return {"target": os.path.abspath(target), "notesWritten": written}


def write_pages(job: dict, source: str, pages_out: str) -> dict:
    if pages_out == "":
        raise ValueError("导出文本需要 pagesOut 路径")
    presentation = Presentation(source)
    by_slide = notes_map(job)
    title = str(job.get("title") or "").strip() or "听课笔记"
    date = str(job.get("date") or "").strip()
    lines = [f"# {title}"]
    if date != "":
        lines.append(f"日期：{date}")
    lines.append("")

    note_count = 0
    for position, slide in enumerate(presentation.slides, start=1):
        entry = by_slide.get(position, {})
        heading = entry.get("title") or _slide_title(slide) or f"第 {position} 页"
        lines.append(f"## {position}. {heading}")
        keywords = entry.get("keywords") or []
        if isinstance(keywords, list) and keywords:
            lines.append("关键词：" + "、".join(str(word) for word in keywords))
        body = entry.get("note") or ""
        if body.strip() == "":
            lines.append("（这一页没有识别到讲课内容）")
        else:
            note_count += 1
            lines.append(body.strip())
        lines.append("")

    text = "\n".join(lines)
    directory = os.path.dirname(os.path.abspath(pages_out))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(pages_out, "w", encoding="utf-8") as handle:
        handle.write(text)
    return {
        "pagesOut": os.path.abspath(pages_out),
        "pages": text.split("\n"),
        "slidesWithNotes": note_count,
    }


def _slide_title(slide) -> str:
    try:
        placeholder = slide.shapes.title
        if placeholder is not None:
            return " ".join(str(placeholder.text or "").split())
    except Exception:
        return ""
    return ""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Write class notes into a .pptx")
    parser.add_argument("--json", required=True, help="path to the job JSON file")
    args = parser.parse_args(argv)

    try:
        job = read_job(args.json)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"读取任务失败：{exc}"}, ensure_ascii=False))
        return 2

    source = str(job.get("source") or "")
    if source == "" or not os.path.isfile(source):
        sys.stdout.write(json.dumps({"ok": False, "error": f"找不到原始 PPT：{source}"}, ensure_ascii=False))
        return 2

    mode = str(job.get("mode") or "notes")
    result: dict = {"ok": True}
    try:
        if mode in ("notes", "both"):
            result.update(write_notes(job, source, str(job.get("target") or "")))
        if mode in ("pages", "both"):
            result.update(write_pages(job, source, str(job.get("pagesOut") or "")))
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"写备注失败：{exc}"}, ensure_ascii=False))
        return 1

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
