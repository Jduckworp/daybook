#!/usr/bin/env python3
"""Render the home-screen icons from the same mark the favicon uses.

Run with a Python that has Pillow:
    .venv/bin/python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
NAVY = (0, 23, 75, 255)
AQUA = (0, 172, 163, 255)

# The mark in the favicon's 32-unit box: a tick from (8,16.5) via (13,21.5)
# to (24,10.5), stroked at 3.2 with round caps and joins.
TICK = [(8, 16.5), (13, 21.5), (24, 10.5)]
STROKE = 3.2
RADIUS = 7  # rounded-square corner, 32-unit box


def render(size: int, maskable: bool) -> Image.Image:
    ss = 4  # supersample, then downscale for clean edges
    box = size * ss
    img = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # A maskable icon is cropped to whatever shape the launcher wants, so it
    # must bleed to the edges; the "any" icon carries its own rounded square.
    unit = box / 32
    if maskable:
        draw.rectangle([0, 0, box, box], fill=NAVY)
        scale, offset = 0.82, box * 0.09  # keep the tick inside the safe zone
    else:
        draw.rounded_rectangle([0, 0, box - 1, box - 1], radius=RADIUS * unit, fill=NAVY)
        scale, offset = 1.0, 0.0

    pts = [(x * unit * scale + offset, y * unit * scale + offset) for x, y in TICK]
    width = STROKE * unit * scale
    draw.line(pts, fill=AQUA, width=int(round(width)), joint="curve")
    # Pillow has no round line caps, so cap the ends by hand.
    for x, y in (pts[0], pts[-1]):
        r = width / 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=AQUA)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        render(size, maskable=False).save(OUT / f"icon-{size}.png")
        render(size, maskable=True).save(OUT / f"icon-maskable-{size}.png")
    print(f"wrote 4 icons to {OUT}")


if __name__ == "__main__":
    main()
