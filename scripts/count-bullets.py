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


def detect(image: Image.Image, min_area: int, max_area: int, min_value: int, min_saturation: int, keep_white: bool = True):
    # int32, not int16: (value - low) * 255 overflows int16 for saturated bullets.
    rgb = np.asarray(image, dtype=np.int32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    value = rgb.max(axis=2)
    low = rgb.min(axis=2)
    saturation = np.where(value == 0, 0, (value - low) * 255 // np.maximum(value, 1))

    # Bullets are bright and either saturated or near-white; the playfield/background is not.
    mask = (value >= min_value) & (saturation >= min_saturation)
    if keep_white:
        mask = mask | (value >= 245)

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
        bx, by, bw, bh = component["bbox"]
        draw.rectangle([bx, by, bx + bw - 1, by + bh - 1], outline=(0, 255, 0), width=1)
    canvas.save(destination)


# --------------------------------------------------------------------------------- auto mode


def _profiles(image: Image.Image):
    """Small high-contrast detail map plus its column/row projections (1/4 scale).

    Bullets are small and sharp; wallpaper, gradients and the dark playfield are not. Using
    local contrast instead of raw saturation is what keeps the tool from locking onto a
    colourful background.
    """
    from PIL import ImageFilter

    small = image.resize((max(1, image.width // 4), max(1, image.height // 4)))
    blurred = small.filter(ImageFilter.BoxBlur(4))
    array = np.asarray(small, dtype=np.int32)
    smooth = np.asarray(blurred, dtype=np.int32)
    detail = np.abs(array - smooth).max(axis=2)
    value = array.max(axis=2)
    activity = (detail >= 35) & (value >= 110)
    return activity, activity.sum(axis=0).astype(np.float64), activity.sum(axis=1).astype(np.float64), small.size


def _band(profile: np.ndarray, fraction: float = 0.5, keep: float = 0.05) -> tuple[int, int]:
    """Longest contiguous band around the densest window of a projection."""
    length = profile.size
    if length == 0:
        return 0, 0
    window = max(8, int(length * fraction))
    if window >= length:
        return 0, length - 1
    sums = np.convolve(profile, np.ones(window), mode="valid")
    start = int(np.argmax(sums))
    mean = sums[start] / window
    low, high = start, start + window - 1
    while low > 0 and profile[low - 1] >= mean * keep:
        low -= 1
    while high < length - 1 and profile[high + 1] >= mean * keep:
        high += 1
    return low, high


def _cut_valley(profile: np.ndarray, low: int, high: int) -> tuple[int, int]:
    """Splits the band at the deepest internal valley and keeps the heavier side."""
    segment = profile[low : high + 1]
    if segment.size < 20:
        return low, high
    mean = float(segment.mean()) or 1.0
    index = int(np.argmin(segment))
    margin = max(4, int(segment.size * 0.08))
    if margin < index < segment.size - margin and segment[index] < mean * 0.15:
        left_mass = float(segment[:index].sum())
        right_mass = float(segment[index + 1 :].sum())
        if right_mass <= left_mass:
            return low, low + index - 1
        return low + index + 1, high
    return low, high


def auto_crop(image: Image.Image) -> tuple[tuple[int, int, int, int], dict]:
    """Finds the playfield and reports what it decided."""
    activity, columns, rows, small_size = _profiles(image)
    total = int(activity.sum())
    fallback = (0, 0, image.width, image.height)
    if total < 40:
        return fallback, {"enabled": True, "reason": "too little bright activity, kept the full frame"}

    scale_x = image.width / small_size[0]
    scale_y = image.height / small_size[1]
    x0, x1 = _band(columns)
    y0, y1 = _band(rows)
    # A HUD panel is separated from the playfield by a column valley: cut at the deepest one
    # instead of swallowing the score bar into the bullet count.
    x0, x1 = _cut_valley(columns, x0, x1)
    # Trim the sparse tails: the playfield carries almost all of the activity mass, a HUD
    # strip or a sliver of wallpaper only adds a percent or two.
    segment = columns[x0 : x1 + 1]
    mass = float(segment.sum())
    if mass > 0:
        cumulative = np.cumsum(segment)
        x0 += int(np.searchsorted(cumulative, mass * 0.02))
        x1 -= int(np.searchsorted(cumulative[::-1], mass * 0.02))
    if x1 <= x0:
        x0, x1 = 0, len(columns) - 1

    left = int(x0 * scale_x)
    top = int(y0 * scale_y)
    right = min(image.width, int((x1 + 1) * scale_x))
    bottom = min(image.height, int((y1 + 1) * scale_y))

    # Never return a sliver: a "playfield" thinner than a third of the frame means the
    # projection locked onto the HUD or a single effect.
    if (right - left) < image.width * 0.3 or (bottom - top) < image.height * 0.3:
        return fallback, {"enabled": True, "reason": "detected band too small, kept the full frame"}

    return (left, top, right, bottom), {
        "enabled": True,
        "reason": "brightest saturated band",
        "activityPixels": total,
    }


def auto_thresholds(crop: Image.Image) -> tuple[int, int, list[str], dict]:
    """Percentile thresholds (and the dominant hue families) for one crop."""
    array = np.asarray(crop, dtype=np.int32)
    value = array.max(axis=2)
    saturation = (value - array.min(axis=2)) * 255 // np.maximum(value, 1)
    strong = (value >= 140) & (saturation >= 80)
    count = int(strong.sum())

    if count < 50:
        return 120, 60, [], {"reason": "too little colour, kept the default thresholds"}

    min_saturation = int(np.clip(np.percentile(saturation[strong], 35), 60, 200))
    min_value = int(np.clip(np.percentile(value[strong], 20), 100, 235))

    # Which colour families actually carry the mask? Anything under 3% is background noise.
    import colorsys

    picked = array[strong][:: max(1, count // 20000)]
    families: dict[str, int] = {}
    for red, green, blue in picked:
        name = classify(float(red), float(green), float(blue))
        families[name] = families.get(name, 0) + 1
    total = sum(families.values()) or 1
    dominant = [name for name, hits in sorted(families.items(), key=lambda item: -item[1]) if hits / total >= 0.03]

    return min_saturation, min_value, dominant, {
        "reason": "percentile of the saturated pixels",
        "saturatedPixels": count,
        "families": {name: round(hits / total, 3) for name, hits in sorted(families.items(), key=lambda item: -item[1])[:6]},
    }


# --------------------------------------------------------------------------- template matching

SPRITE_INDEX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "sprite-index.json")


def load_templates(index_path: str, category: str, size: int = 16) -> list[dict]:
    """Loads the sliced sprites (docs/sprites_sliced) as a matching bank.

    Every template is resized to `size`×`size` and premultiplied by its alpha, so sprites of
    different original sizes compare structurally.
    """
    if not os.path.isfile(index_path):
        print(
            f"warning: {index_path} is missing; run scripts/slice-sprites.py first. Template matching is off.",
            file=sys.stderr,
        )
        return []

    with open(index_path, encoding="utf-8") as handle:
        entries = json.load(handle)

    root = os.path.dirname(os.path.dirname(os.path.abspath(index_path)))
    bank: list[dict] = []
    for entry in entries:
        if category != "all" and entry.get("category") != category:
            continue
        path = os.path.join(root, entry["file"])
        if not os.path.isfile(path):
            continue
        try:
            sprite = Image.open(path).convert("RGBA")
        except OSError:
            continue
        thumb = sprite.resize((size, size), Image.BILINEAR)
        array = np.asarray(thumb, dtype=np.float32)
        alpha = array[:, :, 3:4] / 255.0
        bank.append({"name": entry["name"], "w": entry["w"], "h": entry["h"], "array": edge_signature(array[:, :, :3] * alpha)})
    return bank


def edge_signature(rgb: np.ndarray) -> np.ndarray:
    """Contrast-normalised edge map of a small thumbnail.

    Matching on edges instead of raw pixels is what makes a white-cored bullet with a cyan rim
    comparable to the same sprite drawn on a bright HUD-free background: brightness and colour
    cancel out, the silhouette stays.
    """
    grey = rgb.mean(axis=2)
    edges = np.zeros_like(grey)
    edges[:, :-1] += np.abs(np.diff(grey, axis=1))
    edges[:-1, :] += np.abs(np.diff(grey, axis=0))
    edges -= edges.mean()
    return edges / (edges.std() + 1e-6)


def match_templates(signature: np.ndarray, stack: np.ndarray, names: list[str]) -> tuple[str | None, float]:
    """Returns the closest template name and its mean squared edge difference (0 = identical)."""
    if stack.size == 0:
        return None, 99.0
    scores = ((stack - signature[None, :, :]) ** 2).mean(axis=(1, 2))
    best = int(np.argmin(scores))
    return names[best], float(scores[best])


def apply_templates(
    region: Image.Image,
    components: list[dict],
    index_path: str,
    category: str,
    max_score: float,
    size: int = 16,
) -> dict[str, int]:
    """Annotates every component with its best sprite match and counts the matches by sprite."""
    bank = load_templates(index_path, category, size)
    if not bank:
        return {}

    stack = np.stack([item["array"] for item in bank])
    names = [item["name"] for item in bank]
    array = np.asarray(region.convert("RGBA"), dtype=np.uint8)

    counts: dict[str, int] = {}
    for component in components:
        x, y, width, height = component["bbox"]
        patch = Image.fromarray(array[y : y + height, x : x + width])
        thumb = patch.resize((size, size), Image.BILINEAR)
        data = np.asarray(thumb, dtype=np.float32)
        name, score = match_templates(edge_signature(data[:, :, :3]), stack, names)
        component["sprite"] = name
        component["spriteScore"] = round(score, 2)
        if name is not None and score <= max_score:
            counts[name] = counts.get(name, 0) + 1

    return dict(sorted(counts.items(), key=lambda item: -item[1]))


def analyze_path(
    image_path: str,
    *,
    auto: bool = False,
    crop: str | None = None,
    min_area: int = MIN_AREA_DEFAULT,
    max_area: int = MAX_AREA_DEFAULT,
    min_value: int | None = None,
    min_saturation: int | None = None,
    no_white: bool = False,
    limit: int = 0,
    annotate_path: str | None = None,
    template: bool = False,
    template_index: str = SPRITE_INDEX,
    template_category: str = "bullet",
    template_max_score: float = 1.8,
) -> dict:
    """Counts the bullets of one image and returns the JSON-ready result.

    Kept free of argparse so `analyze-video-bullets.py` can import it and analyse every
    extracted frame in the same process instead of spawning a Python per frame.
    """
    started = time.time()
    image = load_rgb(image_path)
    full_size = image.size

    auto_report: dict = {"enabled": False}
    if crop:
        left, top, right, bottom = parse_crop(crop, *full_size)
        auto_report["cropReason"] = "explicit crop"
    elif auto:
        (left, top, right, bottom), crop_report = auto_crop(image)
        auto_report.update(crop_report)
    else:
        left, top, right, bottom = parse_crop(None, *full_size)

    region = image.crop((left, top, right, bottom))

    if auto:
        detected_sat, detected_value, dominant, threshold_report = auto_thresholds(region)
        saturation_floor = detected_sat if min_saturation is None else min_saturation
        value_floor = detected_value if min_value is None else min_value
        auto_report["thresholds"] = threshold_report
        auto_report["minValue"] = value_floor
        auto_report["minSaturation"] = saturation_floor
        auto_report["dominantFamilies"] = dominant
        # On a coloured playfield the white bypass re-admits the background: auto drops it.
        keep_white = not no_white and not dominant
    else:
        saturation_floor = 60 if min_saturation is None else min_saturation
        value_floor = 120 if min_value is None else min_value
        keep_white = not no_white

    components, _, _ = detect(region, min_area, max_area, value_floor, saturation_floor, keep_white)

    by_color: dict[str, int] = {}
    for component in components:
        by_color[component["color"]] = by_color.get(component["color"], 0) + 1

    # Touching bullets merge into one blob: split round blobs by the median bullet area.
    typical = float(np.median([component["area"] for component in components])) if components else 0.0
    estimated = 0
    merged = 0
    for component in components:
        ratio = component["area"] / typical if typical > 0 else 1.0
        _, _, width, height = component["bbox"]
        roundish = height > 0 and 0.7 <= width / height <= 1.4
        count = min(6, max(1, int(round(ratio)))) if ratio >= 1.8 and roundish else 1
        component["estimate"] = count
        estimated += count
        if count > 1:
            merged += 1

    annotated = None
    if annotate_path is not None:
        annotated = annotate_path or os.path.join(
            tempfile.gettempdir(),
            f"bullets_{os.path.splitext(os.path.basename(image_path))[0]}_{int(time.time())}.png",
        )
        annotate(region, components, annotated)

    return {
        "ok": True,
        "image": os.path.abspath(image_path),
        "size": {"width": full_size[0], "height": full_size[1]},
        "crop": {"left": left, "top": top, "width": right - left, "height": bottom - top},
        "mode": "auto" if (auto and not crop) else ("manual" if crop else "full"),
        "auto": auto_report,
        "bullets": len(components),
        "estimatedBullets": estimated,
        "mergedBlobs": merged,
        "byColor": dict(sorted(by_color.items(), key=lambda item: -item[1])),
        "sprites": (
            apply_templates(region, components, template_index, template_category, template_max_score)
            if template
            else {}
        ),
        "components": components[:limit],
        "annotated": annotated,
        "elapsedMs": int((time.time() - started) * 1000),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Count bullets in a danmaku screenshot.")
    parser.add_argument("image", help="path of the screenshot (png/jpg/webp/gif)")
    parser.add_argument("--crop", help="analyse only left,top,width,height")
    parser.add_argument("--auto", action="store_true", help="detect the playfield and the thresholds automatically")
    parser.add_argument("--min-area", type=int, default=MIN_AREA_DEFAULT, help="drop blobs smaller than this")
    parser.add_argument("--max-area", type=int, default=MAX_AREA_DEFAULT, help="drop blobs larger than this")
    parser.add_argument("--min-value", type=int, default=None, help="brightness floor (0-255)")
    parser.add_argument("--min-saturation", type=int, default=None, help="saturation floor (0-255)")
    parser.add_argument(
        "--no-white",
        action="store_true",
        help="drop the very-bright pixels that bypass the saturation floor; use it on light backgrounds",
    )
    parser.add_argument("--limit", type=int, default=40, help="how many components to list")
    parser.add_argument(
        "--annotate",
        nargs="?",
        const="",
        default=None,
        help="write a PNG with every kept blob boxed; default path is under the temp directory",
    )
    parser.add_argument(
        "--template",
        action="store_true",
        help="match every blob against docs/sprites_sliced (run scripts/slice-sprites.py first)",
    )
    parser.add_argument("--template-index", default=SPRITE_INDEX, help="sprite index JSON")
    parser.add_argument("--template-category", default="bullet", help="bullet / enemy / item / laser / misc / all")
    parser.add_argument("--template-max-score", type=float, default=1.8, help="worst accepted edge-MSE for a name")
    parser.add_argument("--json-only", action="store_true", help="print the JSON without the summary line")
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        print(f"error: image not found: {args.image}", file=sys.stderr)
        return 2

    result = analyze_path(
        args.image,
        auto=args.auto,
        crop=args.crop,
        min_area=args.min_area,
        max_area=args.max_area,
        min_value=args.min_value,
        min_saturation=args.min_saturation,
        no_white=args.no_white,
        limit=args.limit,
        annotate_path=args.annotate,
        template=args.template,
        template_index=args.template_index,
        template_category=args.template_category,
        template_max_score=args.template_max_score,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.json_only:
        summary = ", ".join(f"{name}={count}" for name, count in result["byColor"].items()) or "none"
        extra = f" (~{result['estimatedBullets']} after splitting {result['mergedBlobs']} merged blobs)" if result["mergedBlobs"] else ""
        crop = result["crop"]
        print(
            f"{result['bullets']} bullets{extra} ({summary}) in {result['elapsedMs']} ms "
            f"[{result['mode']}: {crop['left']},{crop['top']} {crop['width']}x{crop['height']}]"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())