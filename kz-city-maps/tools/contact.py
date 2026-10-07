"""Contact sheets of the still previews.

    python3 contact.py out.jpg Astana Almaty ...   # 3 columns, big tiles
    python3 contact.py --overview                  # output/overview.jpg with every city
"""
import json, os, sys, math
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output")


def sheet(fn, slugs, cols=3, tw=460, th=410):
    tiles = []
    for s in slugs:
        im = Image.open(os.path.join(OUT, "previews", s + ".jpg"))
        tiles.append(im.crop((1000, 260, 1920, 1080)).resize((tw, th), Image.LANCZOS))
    out = Image.new("RGB", (tw * cols, th * math.ceil(len(tiles) / cols)), (3, 248, 11))
    for i, t in enumerate(tiles):
        out.paste(t, ((i % cols) * tw, (i // cols) * th))
    out.save(fn, quality=88)


if __name__ == "__main__":
    if sys.argv[1] == "--overview":
        idx = json.load(open(os.path.join(OUT, "cities", "index.json"), encoding="utf-8"))
        sheet(os.path.join(OUT, "overview.jpg"), [c["slug"] for c in idx], cols=10, tw=276, th=246)
    else:
        sheet(sys.argv[1], sys.argv[2:])
