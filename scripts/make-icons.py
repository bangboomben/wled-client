"""Erzeugt App- und Tray-Icons (resources/). Aufruf: python scripts/make-icons.py

Motiv: ein Farbring (wie ein Farbrad) mit hellem Punkt in der Mitte — eine LED.
Gerechnet wird auf 1024 px und dann herunterskaliert, damit auch 16 px sauber bleiben.
"""

import math
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "resources"
N = 1024

STOPS = [(255, 77, 109), (255, 183, 3), (61, 220, 151), (76, 201, 240), (142, 125, 255), (255, 77, 109)]


def ring_color(angle: float) -> tuple[int, int, int]:
    t = (angle % 360) / 360 * (len(STOPS) - 1)
    i = int(t)
    f = t - i
    a, b = STOPS[i], STOPS[min(i + 1, len(STOPS) - 1)]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def smooth(edge_dist: float, width: float = 1.5) -> float:
    """0..1 Deckkraft für weiche Kanten (edge_dist > 0 = innen)."""
    return max(0.0, min(1.0, 0.5 + edge_dist / width))


def render(kind: str) -> Image.Image:
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    px = img.load()
    c = N / 2
    with_bg = kind == "app"
    scale = 0.80 if with_bg else 0.98  # Tray-Symbole ohne Kachel, darum größer
    r_out = c * 0.70 * scale / 0.80 if with_bg else c * 0.96
    r_in = r_out * 0.58
    r_dot = r_out * 0.27
    tile_r = N * 0.22  # Eckenradius der Kachel

    for y in range(N):
        for x in range(N):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            d = math.hypot(dx, dy)
            r = g = b = 0
            a = 0.0

            if with_bg:
                # abgerundete Kachel mit leichtem Verlauf
                qx = max(abs(dx) - (c - tile_r), 0)
                qy = max(abs(dy) - (c - tile_r), 0)
                tile_d = tile_r - math.hypot(qx, qy)
                ta = smooth(tile_d, 2.5)
                if ta > 0:
                    t = y / N
                    r, g, b = round(30 - 14 * t), round(34 - 15 * t), round(46 - 20 * t)
                    a = ta

            # Ring
            ring_a = min(smooth(r_out - d), smooth(d - r_in))
            if ring_a > 0:
                if kind == "tray-off":
                    rc = (150, 156, 168)
                else:
                    rc = ring_color(math.degrees(math.atan2(dy, dx)) + 90)
                r = round(r * (1 - ring_a) + rc[0] * ring_a)
                g = round(g * (1 - ring_a) + rc[1] * ring_a)
                b = round(b * (1 - ring_a) + rc[2] * ring_a)
                a = max(a, ring_a)

            # Leuchtpunkt mit Schein
            dot_a = smooth(r_dot - d)
            glow = 0.0 if kind == "tray-off" else max(0.0, 1 - (d - r_dot) / (r_in - r_dot)) ** 2 * 0.35
            dc = (150, 156, 168) if kind == "tray-off" else (255, 255, 255)
            if d < r_in:
                k = max(dot_a, glow if d > r_dot else 0)
                r = round(r * (1 - k) + dc[0] * k)
                g = round(g * (1 - k) + dc[1] * k)
                b = round(b * (1 - k) + dc[2] * k)
                a = max(a, k)

            if a > 0:
                px[x, y] = (r, g, b, round(a * 255))
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    app = render("app")
    app.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    app.save(OUT / "icon.ico", sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
    for kind in ("tray-on", "tray-off"):
        img = render(kind)
        img.save(OUT / f"{kind}.ico", sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64)])
        img.resize((64, 64), Image.LANCZOS).save(OUT / f"{kind}.png")
    print("Icons geschrieben nach", OUT)


if __name__ == "__main__":
    main()
