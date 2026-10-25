#!/usr/bin/env python3
"""Count danmaku bullets in a LuaSTG / Touhou style screenshot.

The model can recognise colours and shapes but cannot count hundreds of overlapping bullets, so
this script does the pixel work: threshold the playfield, label connected blobs, drop the ones
that are too small (star particles) or too large (HUD, player, boss), then report a count per
colour family plus an optional annotated PNG.

    python scripts/count-bullets.py shot.png
    python scripts/count-bullets.py shot.png --crop=0,40,640,560 --min-area=12 --annotate
    python scripts/count-bullets.py shot.png --json-only > counts.json

Dependencies (numpy + Pillow) are installed automatically with pip when missing; set
DSH_NO_AUTO_INSTALL=1 to forbid that and get a plain error instead.

Output is a JSON document on stdout:
    { ok, image, size, bullets, byColor, components:[{id, color, area, cx, cy, bbox, hex}] }
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

MIN_AREA_DEFAULT = 8
MAX_AREA_DEFAULT = 6000


def ensure_dependencies() -> None:
    """Import numpy/Pillow, installing them once if the interpreter lacks them."""
    try:
        import numpy  # noqa: F401
        import PIL  # noqa: F401
        return
    except ImportError:
        pass

    if os.environ.get("DSH_NO_AUTO_INSTALL") == "1":
        sys.exit(
            "error: numpy and Pillow are required (pip install numpy pillow). "
            "DSH_NO_AUTO_INSTALL=1 forbids the automatic install."
        )

    print("installing missing dependencies (numpy, pillow) ...", file=sys.stderr)
    install = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "numpy", "pillow"],
        text=True,
    )
    if install.returncode != 0:
        sys.exit(
            "error: could not install numpy/Pillow. Install them manually:\n"
            f"  {sys.executable} -m pip install numpy pillow"
        )

    try:
        import numpy  # noqa: F401
        import PIL  # noqa: F401
    except ImportError:
        sys.exit("error: numpy/Pillow are still missing after the install attempt")


ensure_dependencies()

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


# --------------------------------------------------------------------------- colour families

FAMILIES = [
    # (name, min hue, max hue)  — hue in degrees, red wraps around 0
    ("red", 345, 360),
    ("red", 0, 15),
    ("orange", 15, 42),
    ("yellow", 42, 70),
    ("green", 70, 160),
    ("cyan", 160, 200),
    ("blue", 200, 250),
    ("purple", 250, 290),
    ("magenta", 290, 345),
]


def classify(r: float, g: float, b: float) -> str:
    """Maps an average bullet colour onto the family the model reasons about."""
    import colorsys

    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if s < 0.18:
        if v > 0.85:
            return "white"
        if v > 0.45:
            return "gray"
        return "dark"
    hue = h * 360.0
    for name, low, high in FAMILIES:
        if low <= hue < high:
            return name
    return "other"


# ----------------------------------------------------------------------- connected components


class UnionFind:
    __slots__ = ("parent",)

    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def add(self, label: int) -> None:
        self.parent[label] = label

    def find(self, x: int) -> int:
        parent = self.parent
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if ra < rb:
            self.parent[rb] = ra
        else:
            self.parent[ra] = rb


def label_blobs(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Labels 4-connected blobs of a boolean mask, row by row, merging overlapping runs.

    Pure numpy + a union-find: no scipy, so the script runs on the bundled runtime as is.
    """
    height, width = mask.shape
    labels = np.full((height, width), -1, dtype=np.int32)
    uf = UnionFind()
    next_label = 0
    previous: list[tuple[int, int, int]] = []

    for y in range(height):
        columns = np.flatnonzero(mask[y])
        if columns.size == 0:
            previous = []
            continue

        breaks = np.flatnonzero(np.diff(columns) > 1)
        starts = np.concatenate(([columns[0]], columns[breaks + 1]))
        ends = np.concatenate((columns[breaks], [columns[-1]]))

        current: list[tuple[int, int, int]] = []
        for start, end in zip(starts.tolist(), ends.tolist()):
            label = next_label
            next_label += 1
            uf.add(label)
            for previous_start, previous_end, previous_label in previous:
                if previous_start <= end and start <= previous_end:
                    uf.union(label, previous_label)
            current.append((start, end, label))
            labels[y, start : end + 1] = label

        previous = current

    if next_label == 0:
        return labels, 0

    # Flatten the union-find onto dense component ids: `compact` maps every raw run label to the
    # index of its root inside `unique_roots`, which is exactly the component id.
    roots = np.array([uf.find(label) for label in range(next_label)], dtype=np.int32)
    unique_roots, compact = np.unique(roots, return_inverse=True)

    flat = labels.reshape(-1)
    # -1 is the background: clipping it to 0 and masking afterwards keeps numpy away from
    # negative indexing (which would silently turn background into the last component).
    mapped = np.where(flat >= 0, compact[np.clip(flat, 0, next_label - 1)], -1)
    return mapped.reshape(labels.shape), int(unique_roots.size)


# ----------------------------------------------------------------------------------- pipeline


def parse_crop(text: str | None, width: int, height: int) -> tuple[int, int, int, int]:
    if not text:
        return 0, 0, width, height
    parts = [int(value) for value in text.replace(" ", "").split(",")]
    if len(parts) != 4:
        raise SystemExit("error: --crop must be left,top,width,height")
    left, top, crop_width, crop_height = parts
    if crop_width <= 0 or crop_height <= 0:
        raise SystemExit("error: --crop width/height must be positive")
    right = min(width, left + crop_width)
    bottom = min(height, top + crop_height)
    return max(0, left), max(0, top), right, bottom


def load_rgb(path: str) -> Image.Image:
    image = Image.open(path)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        canvas = Image.new("RGBA", image.size, (0, 0, 0, 255))
        canvas.alpha_composite(image)
        return canvas.convert("RGB")
    return image.convert("RGB")


def detect(image: Image.Image, min_area: int, max_area: int, min_value: int, min_saturation: int):
    # int32, not int16: (value - low) * 255 overflows int16 for saturated bullets.
    rgb = np.asarray(image, dtype=np.int32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    value = rgb.max(axis=2)
    low = rgb.min(axis=2)
    saturation = np.where(value == 0, 0, (value - low) * 255 // np.maximum(value, 1))

    # Bullets are bright and either saturated or near-white; the playfield/background is not.
    mask = ((value >= min_value) & (saturation >= min_saturation)) | (value >= 245)

    labels, count = label_blobs(mask)
    if count == 0:
        return [], labels, rgb

    flat = labels.reshape(-1)
    valid = flat >= 0
    areas = np.bincount(flat[valid], minlength=count)

    weights_r = rgb[:, :, 0].reshape(-1).astype(np.float64)
    weights_g = rgb[:, :, 1].reshape(-1).astype(np.float64)
    weights_b = rgb[:, :, 2].reshape(-1).astype(np.float64)
    sum_r = np.bincount(flat[valid], weights=weights_r[valid], minlength=count)
    sum_g = np.bincount(flat[valid], weights=weights_g[valid], minlength=count)
    sum_b = np.bincount(flat[valid], weights=weights_b[valid], minlength=count)

    # Bounding boxes and centroids: one vectorised pass over the label image.
    ys, xs = np.nonzero(labels >= 0)
    component = labels[ys, xs]
    box_left = np.full(count, 10**9, dtype=np.int64)
    box_top = np.full(count, 10**9, dtype=np.int64)
    box_right = np.full(count, -1, dtype=np.int64)
    box_bottom = np.full(count, -1, dtype=np.int64)
    np.minimum.at(box_left, component, xs)
    np.minimum.at(box_top, component, ys)
    np.maximum.at(box_right, component, xs)
    np.maximum.at(box_bottom, component, ys)
    sum_x = np.bincount(component, weights=xs.astype(np.float64), minlength=count)
    sum_y = np.bincount(component, weights=ys.astype(np.float64), minlength=count)

    components = []
    for label in range(count):
        area = int(areas[label])
        if area < min_area or area > max_area:
            continue
        mean_r = sum_r[label] / area
        mean_g = sum_g[label] / area
        mean_b = sum_b[label] / area
        components.append(
            {
                "id": len(components),
                "color": classify(mean_r, mean_g, mean_b),
                "hex": "#%02x%02x%02x" % (int(mean_r), int(mean_g), int(mean_b)),
                "area": area,
                "cx": round(float(sum_x[label] / area), 1),
                "cy": round(float(sum_y[label] / area), 1),
                "bbox": [
                    int(box_left[label]),
                    int(box_top[label]),
                    int(box_right[label] - box_left[label] + 1),
                    int(box_bottom[label] - box_top[label] + 1),
                ],
            }
        )

    return components, labels, rgb


def annotate(image: Image.Image, components: list[dict], destination: str) -> None:
    canvas = image.copy()
    draw = ImageDraw.Draw(canvas)
    for component in components:
        left, top, width, height = component["bbox"]
        draw.rectangle([left, top, left + width - 1, top + height - 1], outline=(0, 255, 0), width=1)
    canvas.save(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description="Count bullets in a danmaku screenshot.")
    parser.add_argument("image", help="path of the screenshot (png/jpg/webp/gif)")
    parser.add_argument("--crop", help="analyse only left,top,width,height")
    parser.add_argument("--min-area", type=int, default=MIN_AREA_DEFAULT, help="drop blobs smaller than this")
    parser.add_argument("--max-area", type=int, default=MAX_AREA_DEFAULT, help="drop blobs larger than this")
    parser.add_argument("--min-value", type=int, default=120, help="brightness floor (0-255)")
    parser.add_argument("--min-saturation", type=int, default=60, help="saturation floor (0-255)")
    parser.add_argument("--limit", type=int, default=40, help="how many components to list")
    parser.add_argument(
        "--annotate",
        nargs="?",
        const="",
        default=None,
        help="write a PNG with every kept blob boxed; default path is under the temp directory",
    )
    parser.add_argument("--json-only", action="store_true", help="print the JSON without the summary line")
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        print(f"error: image not found: {args.image}", file=sys.stderr)
        return 2

    started = time.time()
    image = load_rgb(args.image)
    full_size = image.size
    left, top, right, bottom = parse_crop(args.crop, *full_size)
    crop = image.crop((left, top, right, bottom))

    components, _, _ = detect(crop, args.min_area, args.max_area, args.min_value, args.min_saturation)

    by_color: dict[str, int] = {}
    for component in components:
        by_color[component["color"]] = by_color.get(component["color"], 0) + 1

    # Touching bullets merge into one blob. Estimate the real count from the typical blob area:
    # a blob three times as big as a normal bullet is three bullets, not one.
    typical = float(np.median([component["area"] for component in components])) if components else 0.0
    estimated = 0
    merged = 0
    for component in components:
        ratio = component["area"] / typical if typical > 0 else 1.0
        count = max(1, int(round(ratio))) if ratio >= 1.8 else 1
        component["estimate"] = count
        estimated += count
        if count > 1:
            merged += 1

    annotated = None
    if args.annotate is not None:
        annotated = args.annotate or os.path.join(
            tempfile.gettempdir(), f"bullets_{os.path.splitext(os.path.basename(args.image))[0]}_{int(time.time())}.png"
        )
        annotate(crop, components, annotated)

    result = {
        "ok": True,
        "image": os.path.abspath(args.image),
        "size": {"width": full_size[0], "height": full_size[1]},
        "crop": {"left": left, "top": top, "width": right - left, "height": bottom - top},
        "bullets": len(components),
        "estimatedBullets": estimated,
        "mergedBlobs": merged,
        "byColor": dict(sorted(by_color.items(), key=lambda item: -item[1])),
        "components": components[: args.limit],
        "annotated": annotated,
        "elapsedMs": int((time.time() - started) * 1000),
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.json_only:
        summary = ", ".join(f"{name}={count}" for name, count in result["byColor"].items()) or "none"
        extra = f" (~{estimated} after splitting {merged} merged blobs)" if merged else ""
        print(f"{result['bullets']} bullets{extra} ({summary}) in {result['elapsedMs']} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
