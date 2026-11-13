#!/usr/bin/env python3
"""Read one .pptx and print a JSON description of every slide.

This script is the parsing half of the class-notes plugin. The host half runs it
through the bundled Python (python-pptx is already part of the DSH Python
payload), and gets back everything it needs to (a) feed slide text to the model
for keyword extraction and (b) decide where the lecture audio belongs.

Usage:
    python extract_pptx.py --input <deck.pptx> [--pretty]

Output (stdout, UTF-8 JSON):
{
  "ok": true,
  "file": "<absolute path>",
  "slideCount": 12,
  "slideWidth": 12192000,
  "slideHeight": 6858000,
  "slides": [
    {
      "index": 1,                      # 1-based slide number
      "title": "什么是机器学习",
      "texts": [" 什么是机器学习", " 监督学习 ..."],
      "notes": "上一节课的备注",
      "shapes": 7,
      "pictures": 1,
      "tables": [["表头1", "表头2"], ["a", "b"]],
      "chars": 84                      # 该页文本字符数（正文，不含备注）
    }
  ]
}

On failure it exits non-zero and prints {"ok": false, "error": "..."} to stdout
so the host half can surface a readable Chinese message instead of a traceback.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
except Exception as exc:  # pragma: no cover - only hit on a broken payload
    sys.stdout.write(json.dumps({"ok": False, "error": f"缺少 python-pptx：{exc}"}, ensure_ascii=False))
    sys.exit(3)


def clean(value) -> str:
    """Collapse the whitespace python-pptx hands back for one text run."""
    if value is None:
        return ""
    text = str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\v", "\n")
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line != "")


def shape_texts(shape) -> list[str]:
    """Every non-empty text this shape contributes to the slide body."""
    out: list[str] = []

    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        for child in shape.shapes:
            out.extend(shape_texts(child))
        return out

    if getattr(shape, "has_text_frame", False):
        text = clean(shape.text_frame.text)
        if text != "":
            out.append(text)
        return out

    if getattr(shape, "has_table", False):
        for row in shape.table.rows:
            for cell in row.cells:
                text = clean(cell.text)
                if text != "":
                    out.append(text)
        return out

    # Charts and SmartArt expose no text without extra plumbing; their alt text
    # is still worth keeping because teachers often name them.
    try:
        alt = clean(shape._element._nvXxPr.cNvPr.get("descr"))
    except Exception:
        alt = ""
    if alt != "":
        out.append(alt)
    return out


def table_of(shape) -> list[list[str]] | None:
    if not getattr(shape, "has_table", False):
        return None
    rows: list[list[str]] = []
    for row in shape.table.rows:
        rows.append([clean(cell.text) for cell in row.cells])
    return rows if rows else None


def describe_slide(slide, index: int) -> dict:
    texts: list[str] = []
    tables: list[list[str]] = []
    pictures = 0

    for shape in slide.shapes:
        texts.extend(shape_texts(shape))
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            pictures += 1
        table = table_of(shape)
        if table is not None:
            tables.append(table)

    notes = ""
    try:
        if slide.has_notes_slide:
            notes = clean(slide.notes_slide.notes_text_frame.text)
    except Exception:
        notes = ""

    title = ""
    try:
        placeholder = slide.shapes.title
        if placeholder is not None:
            title = clean(placeholder.text)
    except Exception:
        title = ""

    body_chars = sum(len(text) for text in texts)
    return {
        "index": index,
        "title": title,
        "texts": texts,
        "notes": notes,
        "shapes": len(slide.shapes),
        "pictures": pictures,
        "tables": tables,
        "chars": body_chars,
    }


def build_report(path: str) -> dict:
    presentation = Presentation(path)
    slides = [describe_slide(slide, i) for i, slide in enumerate(presentation.slides, start=1)]
    return {
        "ok": True,
        "file": os.path.abspath(path),
        "slideCount": len(slides),
        "slideWidth": int(presentation.slide_width or 0),
        "slideHeight": int(presentation.slide_height or 0),
        "slides": slides,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Describe every slide of a .pptx as JSON")
    parser.add_argument("--input", required=True, help="path to the .pptx file")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON output")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.input):
        sys.stdout.write(json.dumps({"ok": False, "error": f"找不到文件：{args.input}"}, ensure_ascii=False))
        return 2

    try:
        report = build_report(args.input)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"解析 PPT 失败：{exc}"}, ensure_ascii=False))
        return 1

    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
