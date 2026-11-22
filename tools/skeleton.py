"""Renders the loading screen's two animations as transparent PNG frames for BUSY Bar's .anim format.

Usage: python3 tools/skeleton.py OUT_DIR
Then convert each with the firmware's converter (scripts/seq2anim.py in busybar-firmware):
    PYTHONPATH=<firmware>/scripts python3 <firmware>/scripts/seq2anim.py -o src/animations/load_dim.anim OUT_DIR/load_dim.zip
    PYTHONPATH=<firmware>/scripts python3 <firmware>/scripts/seq2anim.py -o src/animations/load_bars.anim OUT_DIR/load_bars.zip

While a page or a database is read for the first time, the firmware's spinner
stands where its mark goes, its title is on the top line in grey, and two
grey bars stand in for the lines to come. A lighter band sweeps across the
title and the bars together, slanted, then rests.

- load_dim, 62x7, drawn at the title's x and y 0, above it: black at 60%. The
  title is drawn white; under this it looks grey, the grey of a line out of
  focus, and where the band passes the black clears and the title shines. On
  the black screen the layer does not show. Rows 0..6 cover the title's
  accents (row 0) and descenders (row 6), its letters being rows 1..5.
- load_bars, 62x7, drawn at the title's x and y 8: two bars, 3 px tall, 1 px
  apart, the band sweeping them in step with the title's.

The bar plays both by itself at a steady rate: the shimmer costs no draw
requests. Coordinates below are the screen's, with the title at x 10.
"""
import io, json, math, sys, zipfile
from PIL import Image

FPS = 25                  # .anim plays 25 fps true; faster rates run slow on the bar
SWEEP_S, REST_S = 1.2, 0.5
BAND, SLANT = 9.0, 1.5    # the band's half width, and px of x per px of y: it leans right
DIM = 0.6                 # 60% black over white
BASE, PEAK = 0x2B, 0x5E   # the bars' grey, and the band's middle on them

X0, W = 10, 62            # both frames start at the title's x
DIM_TOP, DIM_ROWS = 0, 7
BARS_TOP, BARS_ROWS = 8, 7
BARS = [(10, 8, 46, 3), (10, 12, 30, 3)]  # x, y, w, h on the screen; corners cut as the plates' are


def centre(n: int, sweep: int):
    if n >= sweep:
        return None
    start = X0 - BAND - 16 * SLANT
    return start + (W + 2 * BAND + 16 * SLANT) * n / (sweep - 1)


def strength(x: int, y: int, c) -> float:
    if c is None:
        return 0.0
    d = abs(x - y * SLANT - c)
    return 0.5 + 0.5 * math.cos(math.pi * d / BAND) if d < BAND else 0.0


def in_bar(x: int, y: int) -> bool:
    for bx, by, bw, bh in BARS:
        if bx <= x < bx + bw and by <= y < by + bh:
            return not ((x in (bx, bx + bw - 1)) and (y in (by, by + bh - 1)))
    return False


def render():
    sweep, total = int(FPS * SWEEP_S), int(FPS * (SWEEP_S + REST_S))
    dim, bars = [], []
    for n in range(total):
        c = centre(n, sweep)
        d = Image.new("RGBA", (W, DIM_ROWS), (0, 0, 0, 0))
        b = Image.new("RGBA", (W, BARS_ROWS), (0, 0, 0, 0))
        for y in range(DIM_ROWS):
            for x in range(W):
                d.putpixel((x, y), (0, 0, 0, round(255 * DIM * (1 - strength(x + X0, y + DIM_TOP, c)))))
        for y in range(BARS_ROWS):
            for x in range(W):
                if in_bar(x + X0, y + BARS_TOP):
                    v = round(BASE + (PEAK - BASE) * strength(x + X0, y + BARS_TOP, c))
                    b.putpixel((x, y), (v, v, v, 255))
        dim.append(d)
        bars.append(b)
    return dim, bars


def write(path: str, frames) -> None:
    stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"{stem}/meta.json", json.dumps({"fps": FPS, "color_mode": "argb8888", "sections": []}))
        for i, f in enumerate(frames):
            out = io.BytesIO()
            f.save(out, "PNG")
            z.writestr(f"{stem}/{i}.png", out.getvalue())


if __name__ == "__main__":
    out = sys.argv[1].rstrip("/")
    dim, bars = render()
    write(f"{out}/load_dim.zip", dim)
    write(f"{out}/load_bars.zip", bars)
    print(len(dim), "frames at", FPS, "fps")
