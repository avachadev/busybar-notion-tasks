"""Renders the confetti bursts as transparent PNG frames for BUSY Bar's .anim format.

Usage: python3 tools/confetti.py STYLE OUT.zip     (STYLE: burst, fountain or streamers)
Then convert with the firmware's converter (scripts/seq2anim.py in busybar-firmware):
    PYTHONPATH=<firmware>/scripts python3 <firmware>/scripts/seq2anim.py -o src/animations/confetti_<STYLE>.anim OUT.zip

Every burst starts at the focused row's checkbox, at the same place on every
screen, so pre-rendered animations fit every tick. The bar plays them at a
steady frame rate by itself: no draw request per frame.

- burst: a pop of paper bits flying right across the title, falling gently;
- fountain: higher and to both sides, the pieces twinkling as they fall;
- streamers: fast streaks shooting right, leaving short fading tails, and sparks.
"""
import io, json, random, sys, zipfile
from PIL import Image

W, H = 72, 16
FPS = 30
ORIGIN = (14, 7)  # the focused checkbox's centre: x 11..17, y 4..10
COLORS = [(0x28, 0x83, 0xDF), (0xFF, 0xD2, 0x3F), (0xFF, 0x5C, 0x8A), (0x56, 0xF0, 0x8A),
          (0xFF, 0x9F, 0x1C), (0xFF, 0xFF, 0xFF), (0xB4, 0x8C, 0xFF)]

STYLES = {
    # pieces, seconds, gravity px/s^2, vx range, vy range (up is negative), seed
    "burst":     dict(pieces=46, seconds=1.3, gravity=45.0, vx=(-15, 120), vy=(-34, -8), seed=20261106),
    "fountain":  dict(pieces=44, seconds=1.3, gravity=55.0, vx=(-35, 60), vy=(-26, -10), seed=7),
    "streamers": dict(pieces=22, seconds=1.1, gravity=20.0, vx=(60, 160), vy=(-18, 10), seed=42),
}


def render(style: str) -> list:
    cfg = STYLES[style]
    rng = random.Random(cfg["seed"])
    pieces = []
    for i in range(cfg["pieces"]):
        pieces.append({
            "x": ORIGIN[0] + rng.uniform(-2, 2),
            "y": ORIGIN[1] + rng.uniform(-2, 2),
            "vx": rng.uniform(*cfg["vx"]),
            "vy": rng.uniform(*cfg["vy"]),
            "color": COLORS[i % len(COLORS)],
            "ribbon": rng.random() < 0.45,
            "spin": rng.randint(2, 5),      # frames per flip of a ribbon, or per twinkle
            "start": rng.uniform(0, 0.08),  # a ragged start reads as a pop, not a stamp
        })
    # Streamers also throw sparks: single white pixels that blink out early.
    sparks = []
    if style == "streamers":
        for _ in range(14):
            sparks.append({"x": ORIGIN[0] + rng.uniform(-1, 1), "y": ORIGIN[1] + rng.uniform(-1, 1),
                           "vx": rng.uniform(-30, 60), "vy": rng.uniform(-30, 20), "life": rng.uniform(0.2, 0.5)})

    seconds, gravity = cfg["seconds"], cfg["gravity"]
    count = int(FPS * seconds)
    frames = []
    for n in range(count + 1):
        t = n / FPS
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        put = lambda x, y, c: 0 <= x < W and 0 <= y < H and img.putpixel((x, y), c)
        if n < count:  # the last frame is empty, so the element can stay without a trace
            fade = 1.0 if t < seconds * 0.8 else max(0.0, (seconds - t) / (seconds * 0.2))
            for p in pieces:
                dt = t - p["start"]
                if dt < 0:
                    continue
                fx = p["x"] + p["vx"] * dt
                fy = p["y"] + p["vy"] * dt + gravity * dt * dt / 2
                x, y = round(fx), round(fy)
                c = p["color"] + (int(255 * fade),)
                if style == "streamers":
                    # A head and a tail behind it, dimmer the further back.
                    for k, a in ((0, 1.0), (1, 0.55), (2, 0.25)):
                        tx = round(fx - p["vx"] * k / FPS)
                        ty = round(fy - (p["vy"] + gravity * dt) * k / FPS)
                        put(tx, ty, p["color"] + (int(255 * fade * a),))
                    continue
                if style == "fountain" and (n // p["spin"]) % 3 == 2:
                    continue  # twinkle: off every third beat
                put(x, y, c)
                if p["ribbon"]:
                    if (n // p["spin"]) % 2 == 0:
                        put(x + 1, y, c)
                    else:
                        put(x, y + 1, c)
            for s in sparks:
                if t < s["life"]:
                    put(round(s["x"] + s["vx"] * t), round(s["y"] + s["vy"] * t), (255, 255, 255, 255))
        frames.append(img)
    return frames


if __name__ == "__main__":
    style, out = sys.argv[1], sys.argv[2]
    frames = render(style)
    # The converter expects everything in a folder named after the zip.
    stem = out.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(f"{stem}/meta.json", json.dumps({"fps": FPS, "color_mode": "argb8888", "sections": []}))
        for i, f in enumerate(frames):
            b = io.BytesIO()
            f.save(b, "PNG")
            z.writestr(f"{stem}/{i}.png", b.getvalue())
    print(style, len(frames), "frames at", FPS, "fps")
