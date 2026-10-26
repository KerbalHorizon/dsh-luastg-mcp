#!/usr/bin/env python3
"""Analyse a danmaku video frame by frame: bullets per colour, and how fast they appear.

Samples the video with ffmpeg at a fixed interval, runs `count-bullets.py --auto` on every
frame (imported in-process, not spawned), and writes a timeline:

    analysis_result.json
    [{"time": 1.0, "total_bullets": 150, "colors": {"cyan": 120, "red": 30},
      "spawn_rate": 60.0, "spawn_rate_positive": 72.0, "estimate": 161}, ...]

`spawn_rate` is the net change per second (bullets can leave the screen, so it goes negative);
`spawn_rate_positive` only counts the frames where the field grew, which is the better proxy
for "how many bullets per second this wave spawns".

    python scripts/analyze-video-bullets.py game.mp4 --interval 0.5
    python scripts/analyze-video-bullets.py game.mp4 --start 30 --duration 20 --interval 0.25
    python scripts/analyze-video-bullets.py game.mp4 --ffmpeg=D:\\ffmpeg\\bin\\ffmpeg.exe

Frames are extracted into the system temp directory and deleted again unless --keep-frames.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
COUNTER = os.path.join(HERE, "count-bullets.py")


def load_counter():
    """Imports count-bullets.py (hyphenated filename) as a module."""
    spec = importlib.util.spec_from_file_location("count_bullets", COUNTER)
    if spec is None or spec.loader is None:
        sys.exit(f"error: cannot load {COUNTER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_ffmpeg(explicit: str | None) -> str:
    candidates = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("FFMPEG_PATH"):
        candidates.append(os.environ["FFMPEG_PATH"])
    candidates.append("ffmpeg")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates.extend(
            [
                r"C:\ffmpeg\bin\ffmpeg.exe",
                os.path.join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
                os.path.join(local, "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
            ]
        )

    for candidate in candidates:
        if not candidate:
            continue
        try:
            probe = subprocess.run([candidate, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0:
            return candidate

    sys.exit(
        "error: ffmpeg was not found.\n"
        "  install:  winget install Gyan.FFmpeg   (or scoop/choco install ffmpeg)\n"
        "  or pass:  --ffmpeg=C:\\path\\to\\ffmpeg.exe\n"
        "  or set:   FFMPEG_PATH"
    )


def extract_frames(ffmpeg: str, video: str, prefix: str, interval: float, start: float, duration: float | None, max_frames: int) -> None:
    args = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    if start > 0:
        args += ["-ss", f"{start}"]
    if duration is not None:
        args += ["-t", f"{duration}"]
    args += ["-i", video, "-vf", f"fps=1/{interval}", "-frames:v", str(max_frames), prefix + "_%05d.png"]

    # No pipes: the DSH sandbox refuses piped child stdio, so stderr goes to a file.
    log_path = prefix + ".log"
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=log, timeout=3600)
    if result.returncode != 0:
        try:
            with open(log_path, encoding="utf-8", errors="replace") as log:
                lines = [line.strip() for line in log if line.strip()]
        except OSError:
            lines = []
        sys.exit("error: ffmpeg failed: " + (lines[-1] if lines else f"exit {result.returncode}"))


def load_tracking():
    """Imports bullet_tracking.py from this folder."""
    path = os.path.join(HERE, "bullet_tracking.py")
    spec = importlib.util.spec_from_file_location("bullet_tracking", path)
    if spec is None or spec.loader is None:
        sys.exit(f"error: cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def analyse(video: str, frames: list[str], interval: float, start: float, options: dict | None = None) -> list[dict]:
    options = options or {}
    counter = load_counter()
    tracker_module = load_tracking() if options.get("tracks") else None
    tracker = (
        tracker_module.Tracker(max_speed=options.get("max_speed", 1400.0), max_misses=0)
        if tracker_module is not None
        else None
    )
    timeline: list[dict] = []

    # The playfield is fixed for a whole video: detect it once on the first frame and reuse the
    # crop, otherwise the counts jitter every time the detector picks a different band.
    first = counter.load_rgb(frames[0])
    if options.get("crop"):
        (left, top, right, bottom), crop_report = counter.parse_crop(options["crop"], first.width, first.height), {"reason": "explicit crop"}
    else:
        (left, top, right, bottom), crop_report = counter.auto_crop(first)
    fixed_crop = f"{left},{top},{right - left},{bottom - top}"
    print(
        f"playfield: {fixed_crop} ({crop_report.get('reason', 'auto')})",
        file=sys.stderr,
    )

    for index, frame in enumerate(frames):
        result = counter.analyze_path(
            frame,
            auto=True,
            crop=fixed_crop,
            limit=4000 if tracker is not None else 0,
            template=bool(options.get("template")),
            template_category=options.get("template_category", "bullet"),
            template_max_score=options.get("template_max_score", 1.8),
        )
        entry = {
            "time": round(start + index * interval, 3),
            "frame": index,
            "total_bullets": result["bullets"],
            "colors": result["byColor"],
            "estimate": result["estimatedBullets"],
            "crop": result["crop"],
        }

        if timeline:
            previous = timeline[-1]
            delta = entry["total_bullets"] - previous["total_bullets"]
            entry["delta"] = delta
            entry["spawn_rate"] = round(delta / interval, 1)
            entry["spawn_rate_positive"] = round(max(0, delta) / interval, 1)
        else:
            entry["delta"] = 0
            entry["spawn_rate"] = 0.0
            entry["spawn_rate_positive"] = 0.0

        if tracker is not None:
            detections = [
                {
                    "x": component["cx"],
                    "y": component["cy"],
                    "sprite": component.get("sprite"),
                    "area": component["area"],
                }
                for component in result["components"]
                if options.get("min_area", 0) <= component["area"] <= options.get("max_area", 10**9)
            ]
            tracker.update(detections, index, interval)
            confirmed = tracker.confirmed(index)
            entry["tracks"] = tracker_module.summarize_tracks(confirmed, interval)
            entry["bullets"] = [
                {
                    "sprite_name": track.sprite,
                    "x": round(track.x, 1),
                    "y": round(track.y, 1),
                    "vx": round(track.vx, 1),
                    "vy": round(track.vy, 1),
                    "track": track.id,
                }
                for track in confirmed[: options.get("max_bullets", 150)]
            ]
            entry["pattern"] = tracker_module.classify_pattern(entry["bullets"])

        timeline.append(entry)

    return timeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-frame bullet analysis of a danmaku video.")
    parser.add_argument("video", help="path of the video file")
    parser.add_argument("--interval", type=float, default=0.5, help="seconds between analysed frames")
    parser.add_argument("--start", type=float, default=0.0, help="skip this many seconds")
    parser.add_argument("--duration", type=float, default=None, help="analyse at most this many seconds")
    parser.add_argument("--max-frames", type=int, default=240, help="hard cap on analysed frames")
    parser.add_argument("--ffmpeg", default=None, help="path of ffmpeg.exe")
    parser.add_argument("--out", default="analysis_result.json", help="where to write the timeline JSON")
    parser.add_argument("--keep-frames", action="store_true", help="do not delete the extracted PNGs")
    parser.add_argument("--quiet", action="store_true", help="only write the file, no progress output")
    parser.add_argument(
        "--tracks",
        action="store_true",
        help="track every bullet between frames: adds sprite_name/x/y/vx/vy, track ids and the pattern",
    )
    parser.add_argument("--crop", default="", help="fixed playfield crop left,top,width,height (skips auto detection)")
    parser.add_argument("--track-min-area", type=int, default=18, help="ignore blobs smaller than this when tracking")
    parser.add_argument("--track-max-area", type=int, default=4000, help="ignore blobs larger than this when tracking")
    parser.add_argument("--track-max-speed", type=float, default=1400.0, help="match gate in px/s")
    parser.add_argument("--max-bullets", type=int, default=150, help="bullets listed per frame in the JSON")
    parser.add_argument("--no-template", action="store_true", help="with --tracks, skip sprite naming")
    args = parser.parse_args()

    if not os.path.isfile(args.video):
        print(f"error: video not found: {args.video}", file=sys.stderr)
        return 2
    if args.interval <= 0:
        print("error: --interval must be > 0", file=sys.stderr)
        return 2

    ffmpeg = find_ffmpeg(args.ffmpeg)
    # Frames go straight into the temp root: a freshly created subdirectory is not writable
    # for every process on Windows sandboxes, while the temp root is.
    stem = f"luastg_analyze_{os.getpid()}_{int(time.time())}"
    prefix = os.path.join(tempfile.gettempdir(), stem)
    started = time.time()

    try:
        extract_frames(ffmpeg, args.video, prefix, args.interval, args.start, args.duration, args.max_frames)
        frames = sorted(
            os.path.join(tempfile.gettempdir(), name)
            for name in os.listdir(tempfile.gettempdir())
            if name.startswith(stem + "_") and name.lower().endswith(".png")
        )
        if not frames:
            print("error: ffmpeg produced no frame (wrong interval or unreadable video)", file=sys.stderr)
            return 3

        timeline = analyse(
            args.video,
            frames,
            args.interval,
            args.start,
            {
                "tracks": args.tracks,
                "crop": args.crop,
                "template": args.tracks and not args.no_template,
                "template_category": "bullet",
                "template_max_score": 1.8,
                "min_area": args.track_min_area,
                "max_area": args.track_max_area,
                "max_speed": args.track_max_speed,
                "max_bullets": args.max_bullets,
            },
        )

        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(timeline, handle, ensure_ascii=False, indent=2)

        peak = max(timeline, key=lambda item: item["total_bullets"])
        rates = [item["spawn_rate_positive"] for item in timeline[1:]]
        if not args.quiet:
            print(
                f"{len(timeline)} frames, {timeline[0]['time']:.2f}s..{timeline[-1]['time']:.2f}s "
                f"-> {os.path.abspath(args.out)}"
            )
            print(
                f"peak {peak['total_bullets']} bullets at t={peak['time']:.2f}s "
                f"({', '.join(f'{name}={count}' for name, count in list(peak['colors'].items())[:4])})"
            )
            if rates:
                print(f"spawn rate: avg {sum(rates) / len(rates):.1f}/s, max {max(rates):.1f}/s, "
                      f"total {time.time() - started:.1f}s wall clock")
            if args.tracks:
                kinds = [item["pattern"]["kind"] for item in timeline if "pattern" in item]
                top = max(set(kinds), key=kinds.count) if kinds else "none"
                speeds = [item["tracks"]["speedMean"] for item in timeline if item.get("tracks", {}).get("tracks")]
                print(
                    f"patterns: {', '.join(f'{k} x{v}' for k, v in sorted(((k, kinds.count(k)) for k in set(kinds)), key=lambda kv: -kv[1]))}"
                )
                if speeds:
                    print(f"bullet speed: mean {sum(speeds)/len(speeds):.0f} px/s, dominant pattern {top}")
    finally:
        if args.keep_frames:
            print(f"frames kept: {prefix}_*.png", file=sys.stderr)
        else:
            for name in os.listdir(tempfile.gettempdir()):
                if name.startswith(stem):
                    try:
                        os.remove(os.path.join(tempfile.gettempdir(), name))
                    except OSError:
                        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
