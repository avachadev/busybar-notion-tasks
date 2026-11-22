"""Renders the loading skeleton with its shimmer as transparent PNG frames for BUSY Bar's .anim format.

Usage: python3 tools/skeleton.py OUT.zip
Then convert with the firmware's converter (scripts/seq2anim.py in busybar-firmware):
    PYTHONPATH=<firmware>/scripts python3 <firmware>/scripts/seq2anim.py -o src/animations/skeleton.anim OUT.zip

While a page or a database is read for the first time, its title stays on the
top line with the firmware's spinner beside it, and under it a grey stand-in
for a line of the list: a square where the mark goes, a bar where the title
goes. A lighter band sweeps across them, slanted, then rests. The bar plays
it by itself at a steady rate, so the shimmer costs no draw requests.

The frame is 62x7 and is drawn at the list's left edge (x 0, or 10 with the
logo on) and y 9: the bottom line of the screen.
"""
import io, json, math, sys, zipfile
from PIL import Image

W, H = 62, 7
FPS = 25                 # .anim plays 25 fps true; faster rates run slow on the bar
SWEEP_S, REST_S = 1.0, 0.4
BASE = 0x2B              # the shapes' grey, on black
PEAK = 0x5E              # the band's middle
BAND = 9.0               # the band's half width, px
SLANT = 1.5              # px of x per px of y: the band leans right

# Shapes, in frame coordinates: the mark's square and the title's bar, corners cut as the plates' are.
SQUARE = (2, 1, 5, 5)    # x, y, w, h
BAR = (10, 2, 38, 3)


def inside(x: int, y: int) -> bool:
    for sx, sy, sw, sh in (SQUARE, BAR):
        if sx <= x < sx + sw and sy <= y < sy + sh:
            corner = (x in (sx, sx + sw - 1)) and (y in (sy, sy + sh - 1))
            return not corner
    return False


def render() -> list:
    sweep = int(FPS * SWEEP_S)
    frames = []
    for n in range(sweep + int(FPS * REST_S)):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        # The band's centre runs from before the left edge to past the right one.
        centre = -BAND - H * SLANT + (W + 2 * BAND + H * SLANT) * n / max(1, sweep - 1) if n < sweep else None
        for y in range(H):
            for x in range(W):
                if not inside(x, y):
                    continue
                level = BASE
                if centre is not None:
                    d = abs(x - y * SLANT - centre)
                    if d < BAND:
                        level = round(BASE + (PEAK - BASE) * (0.5 + 0.5 * math.cos(math.pi * d / BAND)))
                img.putpixel((x, y), (level, level, level, 255))
        frames.append(img)
    return frames


if __name__ == "__main__":
    out = sys.argv[1]
    frames = render()
    stem = out.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(f"{stem}/meta.json", json.dumps({"fps": FPS, "color_mode": "argb8888", "sections": []}))
        for i, f in enumerate(frames):
            b = io.BytesIO()
            f.save(b, "PNG")
            z.writestr(f"{stem}/{i}.png", b.getvalue())
    print(len(frames), "frames at", FPS, "fps")
