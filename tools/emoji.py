"""Makes the 7x7 page icons from Twemoji's 72x72 PNGs, as 64 animation packs.

Usage: python3 tools/emoji.py <twemoji>/assets/72x72 <busybar-firmware> src/animations

Twemoji (https://github.com/jdecked/twemoji, graphics CC-BY 4.0) covers the
whole Unicode emoji list, so any emoji a Notion page can have as its icon has
a picture. Each is cropped to its drawing, centred in a square, shrunk to 7x7
by area averaging (Pillow premultiplies the alpha for it) and kept with its
transparency. 7x7 is the place of a line's mark.

Why packs of animations (measured on the bar, 22.11):
- 4009 files, one an icon, did not install: the bar unpacks an app file by
  file, and after 120 s it was still at it, drawing 1-2 frames a second;
- an app cannot read its own installed files (only its data folder), so a
  pack the app would open itself is out;
- the firmware plays an .anim section by name: an icon is a section of one
  frame, in one of 64 files. Opening one reads its header and section table
  (about 1.5 KB for 60-70 icons) and one frame; the frame then stays on screen
  with no further file work. 16 icons at once took 11 ms each to make; a
  redraw next to them cost 8.0 ms (median) against 10.2 ms next to 16 PNGs.

An icon's section is named as Twemoji names the file: the code points in hex
joined by "-", U+FE0F dropped unless the sequence has a U+200D. Its pack is
the name's 32-bit FNV-1a modulo FOLDERS, in two hex digits (`e_2a.anim`); the
app computes the same (`emoji.ts`). The packs lie among the app's other
animations: `busy-cli build` lays `src/animations` out flat, folders dropped.
"""
import io, json, os, subprocess, sys, tempfile, zipfile
from PIL import Image

SIZE = 7
FOLDERS = 64


def pack_of(name: str) -> str:
    h = 0x811C9DC5
    for ch in name:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return "%02x" % (h % FOLDERS)


def icon(path: str) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    box = im.getbbox() or (0, 0, im.width, im.height)
    im = im.crop(box)
    side = max(im.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(im, ((side - im.width) // 2, (side - im.height) // 2))
    return square.resize((SIZE, SIZE), Image.BOX, reducing_gap=None)


def main(src: str, firmware: str, out: str) -> None:
    names = sorted(n[:-4] for n in os.listdir(src) if n.endswith(".png") and not n.startswith("."))
    packs: dict = {}
    for name in names:
        packs.setdefault(pack_of(name), []).append(name)
    os.makedirs(out, exist_ok=True)
    env = dict(os.environ, PYTHONPATH=os.path.join(firmware, "scripts"))
    with tempfile.TemporaryDirectory() as tmp:
        for pack, members in sorted(packs.items()):
            zpath = os.path.join(tmp, f"{pack}.zip")
            sections = [{"name": n, "start": i, "end": i} for i, n in enumerate(members)]
            with zipfile.ZipFile(zpath, "w") as z:
                z.writestr(f"{pack}/meta.json", json.dumps({"fps": 25, "color_mode": "argb8888", "sections": sections}))
                for i, n in enumerate(members):
                    b = io.BytesIO()
                    icon(os.path.join(src, f"{n}.png")).save(b, "PNG")
                    z.writestr(f"{pack}/{i}.png", b.getvalue())
            subprocess.run([sys.executable, os.path.join(firmware, "scripts", "seq2anim.py"), "-o", os.path.join(out, f"e_{pack}.anim"), zpath],
                           check=True, env=env, stdout=subprocess.DEVNULL)
    print(len(names), "icons in", len(packs), "packs")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
