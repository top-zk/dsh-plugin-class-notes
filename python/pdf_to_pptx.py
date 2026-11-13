#!/usr/bin/env python3
"""Turn one PDF into a .pptx the rest of the plugin already understands.

Two things happen here:

1. Every PDF page's text is extracted with pypdf (vendored under `python/vendor`).
   The host half uses that text for keyword extraction, because a picture of a
   slide carries no text at all.
2. A deck is written where each PDF page becomes one slide. When the host half
   managed to rasterize the pages (LibreOfficeKit / PDFium), the PNG is placed
   full-bleed so the slide looks exactly like the PDF. Without images we fall
   back to a text slide built from the extracted text, which still works for
   keyword matching and for the notes the lecture audio is written into.

Usage:
    python pdf_to_pptx.py --input <file.pdf> --out <deck.pptx> [--images <dir>]
                          [--title "第 3 讲"] [--pretty]

Output (stdout, UTF-8 JSON):
{
  "ok": true,
  "file": "<absolute path of the pdf>",
  "out": "<absolute path of the pptx>",
  "slideCount": 12,
  "slideWidth": 12192000,
  "slideHeight": 6858000,
  "imagePages": 11,            # how many slides got a rendered page image
  "textChars": 5321,
  "warning": "",               # e.g. "没能读取 PDF 文字，只能按图片导入"
  "pages": [{"index": 1, "title": "封面", "text": "...", "image": "page-0001.png"}]
}

On failure it exits non-zero and prints {"ok": false, "error": "..."} to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(VENDOR) and VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)

EMU_PER_INCH = 914400
DECK_WIDTH = 12192000  # 13.333in, the same width the plugin uses for 16:9 decks
DECK_HEIGHT = 6858000  # 7.5in
EDGE_INSET = 457200  # 0.5in
TEXT_SLIDE_WIDTH = DECK_WIDTH - 2 * EDGE_INSET
TEXT_SLIDE_HEIGHT = DECK_HEIGHT - 2 * EDGE_INSET


def fail(message: str, code: int = 1) -> int:
    sys.stdout.write(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return code


def clean(value) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n").replace("\v", "\n")
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line != "")


LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
}


def tidy_text(raw: str) -> str:
    """Make PDF text usable: kill ligatures, soft hyphens, junk control chars."""
    text = str(raw or "")
    for source, target in LIGATURES.items():
        text = text.replace(source, target)
    text = text.replace("\u00ad", "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    lines = [line.strip() for line in text.replace("\r", "\n").split("\n")]
    return "\n".join(line for line in lines if line != "")


def read_pdf(path: str) -> tuple[list[dict], str]:
    """Return `[{index, title, text}]` plus a non-fatal warning."""
    try:
        from pypdf import PdfReader
    except Exception as exc:  # pragma: no cover - vendored copy normally present
        return [], f"没装 pypdf，无法读取 PDF 文字（{exc}）"

    try:
        reader = PdfReader(path)
    except Exception as exc:
        return [], f"PDF 打不开：{exc}"

    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception:
            return [], "PDF 有密码，读不了"

    pages: list[dict] = []
    empty = 0
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = tidy_text(page.extract_text() or "")
        except Exception:
            text = ""
        if text == "":
            empty += 1
        pages.append({"index": index, "title": "", "text": text})

    warning = ""
    if pages and empty == len(pages):
        warning = "这份 PDF 是扫描件或纯图片，没能读到文字，关键词只能按图片导入"
    elif empty > 0:
        warning = f"有 {empty} 页没读到文字（大概是图片页）"
    return pages, warning


def first_line(text: str, limit: int = 60) -> str:
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped != "":
            return stripped[:limit]
    return ""


def page_title(page: dict) -> str:
    title = str(page.get("title") or "").strip()
    if title != "":
        return title
    return first_line(str(page.get("text") or ""), 24) or f"第 {page['index']} 页"


def image_sizes(images_dir: str) -> dict[str, tuple[int, int]]:
    """Pixel sizes for the rendered pages, best effort (Pillow is bundled)."""
    sizes: dict[str, tuple[int, int]] = {}
    try:
        from PIL import Image
    except Exception:
        return sizes
    try:
        names = os.listdir(images_dir)
    except OSError:
        return sizes
    for name in names:
        if not name.lower().endswith(".png"):
            continue
        try:
            with Image.open(os.path.join(images_dir, name)) as handle:
                sizes[name] = (int(handle.width), int(handle.height))
        except Exception:
            continue
    return sizes


def collect_images(images_dir: str) -> list[str]:
    """`page-0001.png` … in page order."""
    if images_dir == "" or not os.path.isdir(images_dir):
        return []
    entries = []
    for name in os.listdir(images_dir):
        match = re.match(r"^page-(\d+)\.png$", name, re.IGNORECASE)
        if match is None:
            continue
        entries.append((int(match.group(1)), name))
    entries.sort()
    return [name for _, name in entries]


def deck_size(image_name: str, sizes: dict[str, tuple[int, int]]) -> tuple[int, int]:
    """Keep the PDF page shape so a full-bleed picture is not distorted."""
    size = sizes.get(image_name)
    if size is None or size[0] <= 0 or size[1] <= 0:
        return DECK_WIDTH, DECK_HEIGHT
    width, height = size
    deck_height = int(round(DECK_WIDTH * height / width))
    # Guard against absurd shapes (a very tall page would produce an unusable deck).
    if deck_height < EMU_PER_INCH:
        return DECK_WIDTH, DECK_HEIGHT
    return DECK_WIDTH, deck_height


def set_alt_text(shape, text: str) -> None:
    """Park the page's real text on the picture.

    The slide is a picture, so extraction would otherwise see no text at all and
    the body would just be the file name. Keeping the PDF text as the image's
    description means our own parser (and any accessibility tool) still reads it.
    """
    value = str(text or "").strip()
    if value == "":
        return
    try:
        shape._element._nvXxPr.cNvPr.set("descr", value[:4000])
    except Exception:
        return


def add_text_slide(prs, page: dict) -> None:
    """No image available: lay the extracted text out as a plain slide."""
    from pptx.util import Emu, Pt

    slide = prs.slides.add_slide(prs.slide_layouts[6])
    title = page_title(page)
    body_text = str(page.get("text") or "")

    title_box = slide.shapes.add_textbox(Emu(EDGE_INSET), Emu(EDGE_INSET), Emu(TEXT_SLIDE_WIDTH), Emu(int(1.1 * EMU_PER_INCH)))
    frame = title_box.text_frame
    frame.word_wrap = True
    frame.text = title
    for paragraph in frame.paragraphs:
        for run in paragraph.runs:
            run.font.size = Pt(28)
            run.font.bold = True

    body = body_text
    if title != "" and body.startswith(title):
        body = body[len(title) :].lstrip("\n")
    body_box = slide.shapes.add_textbox(
        Emu(EDGE_INSET),
        Emu(EDGE_INSET + int(1.3 * EMU_PER_INCH)),
        Emu(TEXT_SLIDE_WIDTH),
        Emu(max(TEXT_SLIDE_HEIGHT - int(1.3 * EMU_PER_INCH), EMU_PER_INCH)),
    )
    body_frame = body_box.text_frame
    body_frame.word_wrap = True
    lines = body.split("\n") if body != "" else [""]
    body_frame.text = lines[0]
    for line in lines[1:]:
        body_frame.add_paragraph().text = line
    for paragraph in body_frame.paragraphs:
        paragraph.space_after = 0
        for run in paragraph.runs:
            run.font.size = Pt(18)


def build(input_path: str, out_path: str, images_dir: str) -> int:
    try:
        from pptx import Presentation
        from pptx.util import Emu
    except Exception as exc:  # pragma: no cover
        return fail(f"缺少 python-pptx：{exc}", 3)

    pages, warning = read_pdf(input_path)
    if pages == [] and warning == "":
        return fail("这份 PDF 里没有页面")
    if pages == []:
        return fail(warning)

    names = collect_images(images_dir)
    sizes = image_sizes(images_dir) if names else {}

    prs = Presentation()
    deck_width, deck_height = deck_size(names[0], sizes) if names else (DECK_WIDTH, DECK_HEIGHT)
    prs.slide_width = Emu(deck_width)
    prs.slide_height = Emu(deck_height)

    image_pages = 0
    total_chars = 0
    for position, page in enumerate(pages):
        name = names[position] if position < len(names) else ""
        image_path = os.path.join(images_dir, name) if name != "" else ""
        if image_path != "" and os.path.isfile(image_path):
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            picture = slide.shapes.add_picture(image_path, 0, 0, Emu(deck_width), Emu(deck_height))
            set_alt_text(picture, str(page.get("text") or ""))
            image_pages += 1
            page["image"] = name
        else:
            add_text_slide(prs, page)
            page["image"] = ""
        page["title"] = page_title(page)
        total_chars += len(str(page.get("text") or ""))

    if image_pages == 0 and names:
        warning = (warning + "；" if warning != "" else "") + "页面图片没能用上，已按文字导入"

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    prs.save(out_path)

    payload = {
        "ok": True,
        "file": os.path.abspath(input_path),
        "out": os.path.abspath(out_path),
        "slideCount": len(pages),
        "slideWidth": int(deck_width),
        "slideHeight": int(deck_height),
        "imagePages": image_pages,
        "textChars": total_chars,
        "warning": warning,
        "pages": pages,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF into a class-notes .pptx")
    parser.add_argument("--input", required=True, help="path to the .pdf file")
    parser.add_argument("--out", required=True, help="path of the .pptx to write")
    parser.add_argument("--images", default="", help="directory holding page-0001.png, page-0002.png, …")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.input):
        return fail(f"找不到文件：{args.input}", 2)

    try:
        return build(args.input, args.out, args.images)
    except Exception as exc:
        return fail(f"PDF 转 PPT 失败：{exc}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
