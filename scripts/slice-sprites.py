#!/usr/bin/env python3
"""Slice LuaSTG sprite sheets into individual PNGs and build a sprite index.

The authoritative atlas metadata lives in the THlib Lua scripts, not in the texture folder:
`LoadImage(name, tex, x, y, w, h)` for one sprite and
`LoadImageGroup(prefix, tex, x, y, w, h, cols, rows)` for a grid (row-major, frames named
prefix..1..N — see docs/thlib-scripts/lib/Lresources.lua). Those calls are parsed first; a
sheet without metadata falls back to alpha-based blob detection so nothing is skipped.

    python scripts/slice-sprites.py
    python scripts/slice-sprites.py --only bullet1,enemy1 --out docs/sprites_sliced
    python scripts/slice-sprites.py --no-alpha          # only trust the Lua metadata

Writes:
    docs/sprites_sliced/<category>/<name>.png        one file per sprite
    docs/sprite-index.json                           [{name, file, sheet, category, x, y, w, h, source}]
    docs/sprites_sliced/contact_sheet.png            preview grid of everything sliced
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - the bundled runtime always has both
    sys.exit("error: numpy and Pillow are required (pip install numpy pillow)")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SOURCES = os.path.join(ROOT, "docs", "thlib-sprites")
DEFAULT_LUA = os.path.join(ROOT, "docs", "thlib-scripts")
DEFAULT_OUT = os.path.join(ROOT, "docs", "sprites_sliced")

NUMBER = r"-?\d+(?:\.\d+)?"


def load_counter_module():
    """Reuses the tested blob labeller from count-bullets.py (hyphenated filename)."""
    path = os.path.join(HERE, "count-bullets.py")
    spec = importlib.util.spec_from_file_location("count_bullets", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ------------------------------------------------------------------ Lua metadata (authoritative)


def parse_lua_metadata(lua_root: str) -> tuple[dict[str, str], list[dict]]:
    """Returns (texture name -> png basename, slice recipes) from every THlib *.lua file."""
    textures: dict[str, str] = {}
    recipes: list[dict] = []

    texture_re = re.compile(r"LoadTexture\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]")
    image_re = re.compile(
        r"LoadImage\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*,\s*"
        rf"({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})"
    )
    group_re = re.compile(
        r"LoadImageGroup\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*,\s*"
        rf"({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*"
        rf"({NUMBER})\s*,\s*({NUMBER})"
    )

    for folder, _, files in os.walk(lua_root):
        for name in files:
            if not name.endswith(".lua"):
                continue
            path = os.path.join(folder, name)
            try:
                with open(path, encoding="utf-8", errors="replace") as handle:
                    text = handle.read()
            except OSError:
                continue

            for match in texture_re.finditer(text):
                textures[match.group(1)] = os.path.basename(match.group(2))

            for match in image_re.finditer(text):
                image, texture = match.group(1), match.group(2)
                x, y, w, h = (int(round(float(match.group(i)))) for i in range(3, 7))
                recipes.append(
                    {
                        "name": image,
                        "texture": texture,
                        "x": x,
                        "y": y,
                        "w": w,
                        "h": h,
                        "cols": 1,
                        "rows": 1,
                        "lua": os.path.relpath(path, ROOT),
                    }
                )

            for match in group_re.finditer(text):
                prefix, texture = match.group(1), match.group(2)
                x, y, w, h, cols, rows = (int(round(float(match.group(i)))) for i in range(3, 9))
                if cols <= 0 or rows <= 0 or w <= 0 or h <= 0:
                    continue
                recipes.append(
                    {
                        "name": prefix,
                        "texture": texture,
                        "x": x,
                        "y": y,
                        "w": w,
                        "h": h,
                        "cols": cols,
                        "rows": rows,
                        "lua": os.path.relpath(path, ROOT),
                    }
                )

    return textures, recipes


# ------------------------------------------------------------------------- slicing primitives


def safe_name(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")
    return cleaned or "sprite"


def slice_recipes(sheet_root: str, textures: dict[str, str], recipes: list[dict], out_dir: str) -> list[dict]:
    entries: list[dict] = []
    cache: dict[str, Image.Image] = {}

    for recipe in recipes:
        file_name = textures.get(recipe["texture"])
        if file_name is None:
            continue
        sheet_path = find_sheet(sheet_root, file_name)
        if sheet_path is None:
            continue

        sheet = cache.get(sheet_path)
        if sheet is None:
            sheet = Image.open(sheet_path).convert("RGBA")
            cache[sheet_path] = sheet

        category = os.path.basename(os.path.dirname(sheet_path))
        os.makedirs(os.path.join(out_dir, category), exist_ok=True)

        cols, rows = recipe["cols"], recipe["rows"]
        total = cols * rows
        for index in range(total):
            # Row-major, exactly like Lresources.lua: x + w*(i%cols), y + h*int(i/cols).
            left = recipe["x"] + recipe["w"] * (index % cols)
            top = recipe["y"] + recipe["h"] * (index // cols)
            box = (left, top, left + recipe["w"], top + recipe["h"])
            if box[2] > sheet.width or box[3] > sheet.height:
                continue
            sprite = sheet.crop(box)
            if sprite.getbbox() is None:
                continue  # fully transparent cell

            name = recipe["name"] if total == 1 else f"{recipe['name']}{index + 1}"
            file_path = os.path.join(out_dir, category, f"{safe_name(name)}.png")
            sprite.save(file_path)

            entries.append(
                {
                    "name": name,
                    "file": os.path.relpath(file_path, ROOT).replace("\\", "/"),
                    "sheet": os.path.relpath(sheet_path, ROOT).replace("\\", "/"),
                    "category": category,
                    "x": left,
                    "y": top,
                    "w": recipe["w"],
                    "h": recipe["h"],
                    "source": "lua",
                }
            )

    return entries


def find_sheet(sheet_root: str, file_name: str) -> str | None:
    for folder, _, files in os.walk(sheet_root):
        if file_name in files:
            return os.path.join(folder, file_name)
    return None


def slice_by_alpha(sheet_path: str, out_dir: str) -> list[dict]:
    """Fallback for sheets the Lua scripts never mention: one PNG per opaque blob."""
    counter = load_counter_module()
    if counter is None:
        return []

    sheet = Image.open(sheet_path).convert("RGBA")
    alpha = np.asarray(sheet)[:, :, 3]
    mask = alpha >= 16
    if not mask.any():
        return []

    labels, count = counter.label_blobs(mask)
    if count == 0:
        return []

    category = os.path.basename(os.path.dirname(sheet_path))
    base = safe_name(os.path.splitext(os.path.basename(sheet_path))[0])
    os.makedirs(os.path.join(out_dir, category), exist_ok=True)

    ys, xs = np.nonzero(mask)
    component = labels[ys, xs]
    left = np.full(count, 10**9, dtype=np.int64)
    top = np.full(count, 10**9, dtype=np.int64)
    right = np.full(count, -1, dtype=np.int64)
    bottom = np.full(count, -1, dtype=np.int64)
    np.minimum.at(left, component, xs)
    np.minimum.at(top, component, ys)
    np.maximum.at(right, component, xs)
    np.maximum.at(bottom, component, ys)

    entries: list[dict] = []
    for label in range(count):
        x0, y0 = int(left[label]), int(top[label])
        x1, y1 = int(right[label]) + 1, int(bottom[label]) + 1
        width, height = x1 - x0, y1 - y0
        if width < 2 or height < 2:
            continue
        sprite = sheet.crop((x0, y0, x1, y1))
        name = f"{base}_{label + 1:02d}"
        file_path = os.path.join(out_dir, category, f"{name}.png")
        sprite.save(file_path)
        entries.append(
            {
                "name": name,
                "file": os.path.relpath(file_path, ROOT).replace("\\", "/"),
                "sheet": os.path.relpath(sheet_path, ROOT).replace("\\", "/"),
                "category": category,
                "x": x0,
                "y": y0,
                "w": width,
                "h": height,
                "source": "alpha",
            }
        )

    return entries


def contact_sheet(entries: list[dict], destination: str, cell: int = 48, columns: int = 16) -> None:
    """Renders every sliced sprite on a dark grid so a human (or a model) can eyeball the result."""
    if not entries:
        return
    rows = (len(entries) + columns - 1) // columns
    canvas = Image.new("RGBA", (columns * cell, rows * cell), (16, 16, 22, 255))
    draw = ImageDraw.Draw(canvas)

    for index, entry in enumerate(entries):
        try:
            sprite = Image.open(os.path.join(ROOT, entry["file"])).convert("RGBA")
        except OSError:
            continue
        sprite.thumbnail((cell - 6, cell - 6))
        column, row = index % columns, index // columns
        x = column * cell + (cell - sprite.width) // 2
        y = row * cell + (cell - sprite.height) // 2
        canvas.alpha_composite(sprite, (x, y))
        draw.rectangle([column * cell, row * cell, column * cell + cell - 1, row * cell + cell - 1], outline=(45, 45, 60))

    canvas.convert("RGB").save(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description="Slice LuaSTG sprite sheets into individual PNGs.")
    parser.add_argument("--sheets", default=DEFAULT_SOURCES, help="folder with the atlas PNGs")
    parser.add_argument("--lua", default=DEFAULT_LUA, help="folder with the THlib Lua metadata")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output folder for the sliced sprites")
    parser.add_argument("--index", default=os.path.join(ROOT, "docs", "sprite-index.json"), help="index JSON path")
    parser.add_argument("--only", default="", help="comma separated sheet basenames, e.g. bullet1,enemy1")
    parser.add_argument("--no-alpha", action="store_true", help="skip sheets without Lua metadata")
    parser.add_argument("--contact", default="", help="contact sheet path (default: <out>/contact_sheet.png)")
    args = parser.parse_args()

    started = time.time()
    textures, recipes = parse_lua_metadata(args.lua)
    print(f"lua metadata: {len(recipes)} recipe(s) over {len(textures)} texture name(s)", file=sys.stderr)

    if args.only:
        wanted = {item.strip().lower() for item in args.only.split(",") if item.strip()}
        recipes = [r for r in recipes if textures.get(r["texture"], "").lower() in {f"{w}.png" for w in wanted}]

    entries = slice_recipes(args.sheets, textures, recipes, args.out)

    if not args.no_alpha:
        covered = {entry["sheet"] for entry in entries}
        for folder, _, files in os.walk(args.sheets):
            for name in sorted(files):
                if not name.lower().endswith(".png"):
                    continue
                sheet_path = os.path.join(folder, name)
                relative = os.path.relpath(sheet_path, ROOT).replace("\\", "/")
                if relative in covered:
                    continue
                if args.only:
                    if name.lower() not in {f"{w}.png" for w in wanted}:
                        continue
                added = slice_by_alpha(sheet_path, args.out)
                entries.extend(added)
                if added:
                    print(f"alpha-sliced {name}: {len(added)} sprite(s)", file=sys.stderr)

    entries.sort(key=lambda entry: (entry["category"], entry["sheet"], entry["name"]))

    os.makedirs(os.path.dirname(args.index), exist_ok=True)
    with open(args.index, "w", encoding="utf-8") as handle:
        json.dump(entries, handle, ensure_ascii=False, indent=1)

    target = args.contact or os.path.join(args.out, "contact_sheet.png")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    contact_sheet(entries, target)

    categories: dict[str, int] = {}
    for entry in entries:
        categories[entry["category"]] = categories.get(entry["category"], 0) + 1

    print(
        json.dumps(
            {
                "ok": True,
                "sprites": len(entries),
                "byCategory": categories,
                "index": os.path.relpath(args.index, ROOT).replace("\\", "/"),
                "out": os.path.relpath(args.out, ROOT).replace("\\", "/"),
                "contactSheet": os.path.relpath(target, ROOT).replace("\\", "/"),
                "elapsedMs": int((time.time() - started) * 1000),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
