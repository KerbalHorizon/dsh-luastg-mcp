#!/usr/bin/env python3
"""Bullet tracking and pattern classification for a danmaku frame sequence.

Velocity needs two frames, so this module is used by `analyze-video-bullets.py --tracks`:
every detection of frame N is matched to the nearest detection of frame N-1 (mutual nearest
neighbour inside a speed gate), which yields a persistent track id and a velocity in px/s.
The velocity field is then classified into the shapes a pattern author actually thinks in:

    parallel      all bullets fly the same way (a wall / a stream)
    fan_spread    the backward rays meet at one point: bullets leave one muzzle at many angles
    aimed         the forward rays meet at one point: everything converges on a target
    ring          the positions sit on a circle and the velocities point outward
    chaos         none of the above

Coordinates are pixels of the analysed crop; y grows downward (image space).
"""

from __future__ import annotations

import math

import numpy as np


class Track:
    """One bullet followed over consecutive frames."""

    __slots__ = ("id", "x", "y", "px", "py", "vx", "vy", "first_frame", "last_frame", "sprite", "misses")

    def __init__(self, track_id: int, x: float, y: float, frame: int, sprite: str | None):
        self.id = track_id
        self.x = x
        self.y = y
        self.px = x
        self.py = y
        self.vx = 0.0
        self.vy = 0.0
        self.first_frame = frame
        self.last_frame = frame
        self.sprite = sprite
        self.misses = 0

    def update(self, x: float, y: float, frame: int, dt: float, sprite: str | None) -> None:
        if dt > 0:
            self.vx = (x - self.x) / dt
            self.vy = (y - self.y) / dt
        self.px, self.py = self.x, self.y
        self.x, self.y = x, y
        self.last_frame = frame
        self.misses = 0
        if sprite is not None:
            self.sprite = sprite


class Tracker:
    """Greedy mutual-nearest-neighbour tracker with a speed gate."""

    def __init__(self, max_speed: float = 1400.0, max_misses: int = 0):
        self.max_speed = max_speed
        self.max_misses = max_misses
        self.tracks: list[Track] = []
        self.next_id = 1

    def update(self, detections: list[dict], frame: int, dt: float) -> list[Track]:
        """Advances one frame; `detections` need x, y and optionally sprite."""
        gate = max(24.0, self.max_speed * dt)
        alive = [track for track in self.tracks if track.misses <= self.max_misses]

        if not alive or not detections:
            self.tracks = alive
            for detection in detections:
                self.tracks.append(
                    Track(self.next_id, detection["x"], detection["y"], frame, detection.get("sprite"))
                )
                self.next_id += 1
            return self.tracks

        # Distance matrix (tracks x detections) inside the gate.
        previous = np.array([[track.x, track.y] for track in alive], dtype=np.float64)
        current = np.array([[item["x"], item["y"]] for item in detections], dtype=np.float64)
        distances = np.linalg.norm(previous[:, None, :] - current[None, :, :], axis=2)
        distances[distances > gate] = np.inf

        best_for_track = np.argmin(distances, axis=1)
        best_for_detection = np.argmin(distances, axis=0)

        matched_tracks: set[int] = set()
        matched_detections: set[int] = set()

        for track_index, track in enumerate(alive):
            detection_index = int(best_for_track[track_index])
            if not np.isfinite(distances[track_index, detection_index]):
                continue
            # Mutual best: both sides must pick each other, which kills most crossings.
            if int(best_for_detection[detection_index]) != track_index:
                continue
            if detection_index in matched_detections:
                continue
            detection = detections[detection_index]
            track.update(detection["x"], detection["y"], frame, dt, detection.get("sprite"))
            matched_tracks.add(track_index)
            matched_detections.add(detection_index)

        survivors: list[Track] = []
        for track_index, track in enumerate(alive):
            if track_index in matched_tracks:
                survivors.append(track)
            else:
                track.misses += 1
                if track.misses <= self.max_misses:
                    survivors.append(track)

        for detection_index, detection in enumerate(detections):
            if detection_index in matched_detections:
                continue
            survivors.append(
                Track(self.next_id, detection["x"], detection["y"], frame, detection.get("sprite"))
            )
            self.next_id += 1

        self.tracks = survivors
        return self.tracks

    def confirmed(self, frame: int) -> list[Track]:
        """Tracks that have at least one real velocity sample."""
        return [track for track in self.tracks if track.last_frame == frame and track.first_frame < frame]


# ------------------------------------------------------------------------------- pattern logic


def _unit(vx: float, vy: float) -> tuple[float, float]:
    length = math.hypot(vx, vy)
    if length <= 1e-6:
        return 0.0, 0.0
    return vx / length, vy / length


def _circular_std(angles: list[float]) -> float:
    if not angles:
        return 0.0
    radians = np.radians(angles)
    mean = np.arctan2(np.sin(radians).mean(), np.cos(radians).mean())
    diff = np.angle(np.exp(1j * (radians - mean)))
    return float(np.degrees(np.sqrt(np.mean(diff**2))))


def _ray_convergence(points: np.ndarray, directions: np.ndarray) -> tuple[np.ndarray | None, float]:
    """Least-squares point where the infinite rays come closest to meeting.

    For each ray, n·(q - p) = 0 with n the ray normal; solving the 2x2 normal equations gives the
    point minimising the summed squared perpendicular distance. Returns (point, rms).
    """
    normals = np.stack([-directions[:, 1], directions[:, 0]], axis=1)
    matrix = normals.T @ normals
    if abs(np.linalg.det(matrix)) < 1e-6:
        return None, float("inf")
    # b = sum(n_i * (n_i . p_i)); the previous version assigned the per-ray scalar to a 2-vector.
    scalar = (normals * points).sum(axis=1)
    rhs = (normals * scalar[:, None]).sum(axis=0)
    point = np.linalg.solve(matrix, rhs)
    residuals = normals @ point - (normals * points).sum(axis=1)
    return point, float(np.sqrt(np.mean(residuals**2)))


def classify_pattern(bullets: list[dict], min_bullets: int = 8) -> dict:
    """Classifies the velocity field of one frame.

    `bullets` items need x, y, vx, vy; returns {kind, confidence, ...diagnostics}.
    """
    moving = [b for b in bullets if abs(b["vx"]) > 1e-6 or abs(b["vy"]) > 1e-6]
    if len(moving) < min_bullets:
        return {"kind": "too_few", "confidence": 0.0, "samples": len(moving)}

    points = np.array([[b["x"], b["y"]] for b in moving], dtype=np.float64)
    units = np.array([_unit(b["vx"], b["vy"]) for b in moving], dtype=np.float64)
    angles = [math.degrees(math.atan2(b["vy"], b["vx"])) % 360.0 for b in moving]

    spread = _circular_std(angles)
    if spread <= 10.0:
        return {"kind": "parallel", "confidence": round(1.0 - spread / 10.0, 2), "spreadDeg": round(spread, 1), "samples": len(moving)}

    # Ring before convergence: a symmetric ring's rays all pass through its centre, so it would
    # otherwise look like a 360° fan. The position spread is what separates the two.
    center = points.mean(axis=0)
    radius = np.linalg.norm(points - center, axis=1)
    if radius.mean() > 1 and radius.std() / radius.mean() <= 0.25:
        outward = points - center
        outward /= np.maximum(np.linalg.norm(outward, axis=1, keepdims=True), 1e-6)
        alignment = float(np.mean(np.sum(units * outward, axis=1)))
        coverage = _angular_coverage(points - center)
        if abs(alignment) >= 0.65 and coverage >= 240.0:
            return {
                "kind": "ring",
                "confidence": round(abs(alignment), 2),
                "center": [round(float(center[0]), 1), round(float(center[1]), 1)],
                "radius": round(float(radius.mean()), 1),
                "coverageDeg": round(coverage, 1),
                "direction": "outward" if alignment > 0 else "inward",
                "samples": len(moving),
            }

    # Any pattern that is fired from one muzzle or aimed at one target has converging lines.
    point, rms = _ray_convergence(points, units)
    if point is not None and rms <= 45.0:
        ahead = float(np.mean(np.sum(units * (point - points), axis=1)))
        confidence = round(max(0.0, min(1.0, 1.0 - rms / 45.0)), 2)
        kind = "aimed" if ahead > 0 else "fan_spread"
        return {
            "kind": kind,
            "confidence": confidence,
            "spreadDeg": round(spread, 1),
            "center": [round(float(point[0]), 1), round(float(point[1]), 1)],
            "residualPx": round(rms, 1),
            "samples": len(moving),
        }

    return {"kind": "chaos", "confidence": 0.0, "spreadDeg": round(spread, 1), "samples": len(moving)}


def _angular_coverage(offsets: np.ndarray) -> float:
    """How much of the circle the positions cover (360 - the largest empty gap)."""
    angles = np.degrees(np.arctan2(offsets[:, 1], offsets[:, 0]))
    ordered = np.sort(angles % 360.0)
    if ordered.size < 2:
        return 0.0
    gaps = np.diff(np.concatenate([ordered, [ordered[0] + 360.0]]))
    return float(360.0 - gaps.max())


def summarize_tracks(tracks: list[Track], interval: float) -> dict:
    """Aggregate statistics over the live tracks of one frame."""
    if not tracks:
        return {"tracks": 0}
    speeds = [math.hypot(track.vx, track.vy) for track in tracks]
    lifetimes = [(track.last_frame - track.first_frame + 1) * interval for track in tracks]
    return {
        "tracks": len(tracks),
        "speedMean": round(float(np.mean(speeds)), 1),
        "speedMax": round(float(np.max(speeds)), 1),
        "lifetimeMean": round(float(np.mean(lifetimes)), 2),
    }
