"""Render stage: plate PNG (for After Effects), map.json (vectors + layout for the
AE script), a still preview and an animated green-screen preview video.

    python3 render.py Astana Almaty ...      # selected cities
    python3 render.py --all [--video]        # everything (+ green-screen mp4)
    python3 render.py Astana --alpha         # + transparent ProRes 4444 .mov
"""
import json, math, os, subprocess, sys
from multiprocessing import Pool

import cairo
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import shapely

import geo

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "output")
FONT = os.path.join(ROOT, "fonts", "Montserrat-ExtraBold.ttf")

W, H, FPS = 1920, 1080, 25
DURATION, OUT_START = 6.0, 5.2
SS = 2  # supersampling of the plate PNG

GREEN = (3 / 255, 248 / 255, 11 / 255)


def hexc(h, a=1.0):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (a,)


STYLE = {
    "plate": "#F2F2F7",
    "plate_rim": "#FFFFFF",
    "service": ("#D2D3DF", 0.55),
    "minor": ("#C5C6D5", 0.85),
    "medium": ("#AFB0C5", 1.35),
    "major": ("#9896B3", 2.9),
    "water_poly": "#A3D3F3",
    "river": ("#38A6E6", 2.7),
    "river_halo": ("#F6FAFF", 1.6),   # extra width each side
    "stream": ("#4FB2EA", 1.4),
    "outer_major": ("#FFFFFF", 1.8),
    "outer_minor": ("#FFFFFF", 1.15),
    "line": ("#F5B323", 4.4),
    "text": "#FFFFFF",
    "font_size": 36,
    "tracking": 0.6,
}

# label geometry relative to the marker (comp px)
LINE_START = (9.0, -15.0)
ELBOW = (80.0, -86.0)
TEXT_GAP = 9.0          # baseline above the line
TEXT_PAD_LEFT = 50.0    # min distance elbow -> text left edge
TEXT_CLEAR = 16.0       # min distance plate edge -> text left edge
MARKER_POS = (1564.0, 744.0)
SAFE = 56.0

# ------------------------------------------------------------------ timing
T = {
    "plate": (0.00, 0.80), "outer": (0.30, 1.70), "major": (0.40, 1.40), "river": (0.35, 1.50),
    "marker": (0.75, 1.25), "line": (1.05, 1.50), "text": (1.25, 0.035, 0.42),  # start, stagger, dur
    "out_text": (5.20, 0.025, 0.30), "out_line": (5.30, 5.62), "out_marker": (5.45, 5.72),
    "out_roads": (5.35, 5.85), "out_plate": (5.45, 6.00),
}


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def prog(t, a, b):
    return clamp01((t - a) / (b - a)) if b > a else float(t >= a)


def e_out_cubic(x):
    return 1 - (1 - x) ** 3


def e_in_cubic(x):
    return x ** 3


def e_inout_cubic(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def e_out_back(x, s=1.70158):
    x -= 1
    return 1 + (s + 1) * x ** 3 + s * x ** 2


def e_in_back(x, s=1.70158):
    return (s + 1) * x ** 3 - s * x ** 2


# ------------------------------------------------------------------ helpers
class Paths:
    """polylines with cumulative lengths for fast trimming"""

    def __init__(self, lines):
        self.p = [np.asarray(g.coords, float) for g in lines]
        self.cum = []
        for a in self.p:
            d = np.hypot(*np.diff(a, axis=0).T)
            self.cum.append(np.concatenate([[0], np.cumsum(d)]))

    def draw(self, ctx, t0=0.0, t1=1.0):
        if t1 <= t0:
            return
        for a, c in zip(self.p, self.cum):
            L = c[-1]
            if L <= 0:
                continue
            s, e = t0 * L, t1 * L
            if t0 <= 0 and t1 >= 1:
                pts = a
            else:
                i0 = np.searchsorted(c, s, "right")
                i1 = np.searchsorted(c, e, "left")
                def at(v):
                    k = min(max(np.searchsorted(c, v) - 1, 0), len(c) - 2)
                    f = (v - c[k]) / max(c[k + 1] - c[k], 1e-9)
                    return a[k] + (a[k + 1] - a[k]) * f
                pts = np.vstack([at(s), a[i0:i1], at(e)])
            ctx.move_to(*pts[0])
            for x, y in pts[1:]:
                ctx.line_to(x, y)


def stroke_lines(ctx, lines, color, width, alpha=1.0):
    ctx.set_source_rgba(*hexc(color, alpha))
    ctx.set_line_width(width)
    for g in lines:
        c = g.coords
        ctx.move_to(*c[0])
        for x, y in c[1:]:
            ctx.line_to(x, y)
    ctx.stroke()


def poly_path(ctx, poly):
    for ring in [poly.exterior] + list(poly.interiors):
        c = ring.coords
        ctx.move_to(*c[0])
        for x, y in c[1:]:
            ctx.line_to(x, y)
        ctx.close_path()


def surface_from_pil(img):
    """PIL RGBA -> cairo ARGB32 (premultiplied)"""
    a = np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
    al = a[..., 3:4]
    pm = np.concatenate([a[..., :3] * al, al], axis=2)
    bgra = (pm[..., [2, 1, 0, 3]] * 255 + 0.5).astype(np.uint8)
    h, w = bgra.shape[:2]
    stride = cairo.ImageSurface.format_stride_for_width(cairo.FORMAT_ARGB32, w)
    buf = np.zeros((h, stride), np.uint8)
    buf[:, : w * 4] = bgra.reshape(h, w * 4)
    return cairo.ImageSurface.create_for_data(memoryview(buf), cairo.FORMAT_ARGB32, w, h, stride), buf


def surface_to_pil(surf):
    w, h, st = surf.get_width(), surf.get_height(), surf.get_stride()
    a = np.frombuffer(surf.get_data(), np.uint8).reshape(h, st)[:, : w * 4].reshape(h, w, 4).astype(np.float32)
    al = a[..., 3:4] / 255.0
    rgb = np.where(al > 0, a[..., [2, 1, 0]] / np.maximum(al, 1e-6), 0)
    out = np.concatenate([np.clip(rgb, 0, 255), a[..., 3:4]], axis=2).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


# ------------------------------------------------------------------ marker (vector, 0,0 = gem centre)
GEM_SCALE = 1.15
GEM = {"T": (0, -29), "R": (17.5, -6), "B": (0, 29), "L": (-17.5, -6), "C": (0, -6)}
GEM_FACETS = [  # (points, colour)
    (("T", "C", "L"), "#FFD072"),
    (("T", "R", "C"), "#F9A825"),
    (("L", "C", "B"), "#F39A1C"),
    (("C", "R", "B"), "#D9730A"),
]


def draw_gem(ctx):
    G = GEM
    for pts, col in GEM_FACETS:
        ctx.move_to(*G[pts[0]])
        for p in pts[1:]:
            ctx.line_to(*G[p])
        ctx.close_path()
        ctx.set_source_rgba(*hexc(col))
        ctx.fill()
    # soft vertical gradient sheen
    g = cairo.LinearGradient(-17, -29, 17, 29)
    g.add_color_stop_rgba(0, 1, 1, 1, 0.35)
    g.add_color_stop_rgba(0.5, 1, 1, 1, 0.0)
    g.add_color_stop_rgba(1, 0.55, 0.25, 0.0, 0.25)
    for k in ("T", "R", "B", "L"):
        ctx.line_to(*G[k])
    ctx.close_path()
    ctx.set_source(g)
    ctx.fill()
    # facet edges + highlight
    ctx.set_line_width(0.9)
    ctx.set_source_rgba(*hexc("#FFE3A6", 0.85))
    ctx.move_to(*G["L"]); ctx.line_to(*G["C"]); ctx.line_to(*G["R"])
    ctx.move_to(*G["T"]); ctx.line_to(*G["C"]); ctx.line_to(*G["B"])
    ctx.stroke()
    ctx.set_line_width(1.4)
    ctx.set_source_rgba(1, 1, 1, 0.75)
    ctx.move_to(-3, -22); ctx.line_to(-12, -8)
    ctx.stroke()
    ctx.set_line_width(1.0)
    ctx.set_source_rgba(*hexc("#B85F05", 0.9))
    for k in ("T", "R", "B", "L"):
        ctx.line_to(*G[k])
    ctx.close_path()
    ctx.stroke()


# ------------------------------------------------------------------ scene
class Scene:
    def __init__(self, slug):
        self.slug = slug
        r = geo.build(slug)
        self.r = r
        self.city = r["city"]
        L = r["layers"]
        V = r["vec"]
        plate = r["plate"]
        self.plate = plate
        self.river_w = r["river_w"]

        # ---- label layout
        self.font = ImageFont.truetype(FONT, int(STYLE["font_size"] * SS))
        self.name = self.city["ru"].upper()
        self.chars, self.text_w = self._layout_chars(self.name)
        fsz = STYLE["font_size"]
        b = self.font.getbbox("Н")
        self.cap_h = (b[3] - b[1]) / SS
        line_y = ELBOW[1]
        base_y = line_y - TEXT_GAP
        band = shapely.box(-1e5, base_y - self.cap_h - 8, 1e5, line_y + 6)
        inter = plate.intersection(band)
        band_right = inter.bounds[2] if not inter.is_empty else -1e5
        self.line_end = max(ELBOW[0] + TEXT_PAD_LEFT + self.text_w, band_right + TEXT_CLEAR + self.text_w)
        self.base_y = base_y
        self.band_right = band_right

        # ---- placement of the marker in the comp
        x0, y0, x1, y1 = plate.bounds
        mx, my = MARKER_POS
        right = max(x1 + 40, self.line_end)
        mx = min(mx, W - SAFE - right)
        mx = max(mx, SAFE - x0)
        my = min(my, H - 40 - y1)
        my = max(my, 40 + self.cap_h - line_y + TEXT_GAP, 40 - y0)
        self.pos = (round(mx), round(my))

        # ---- static plate surface (PNG for AE, also used for preview)
        margin = 6
        self.px0, self.py0 = math.floor(x0) - margin, math.floor(y0) - margin
        pw, ph = math.ceil(x1 - self.px0) + margin, math.ceil(y1 - self.py0) + margin
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, pw * SS, ph * SS)
        ctx = cairo.Context(surf)
        ctx.scale(SS, SS)
        ctx.translate(-self.px0, -self.py0)
        ctx.set_line_join(cairo.LINE_JOIN_ROUND)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        poly_path(ctx, plate)
        ctx.set_source_rgba(*hexc(STYLE["plate"]))
        ctx.fill_preserve()
        ctx.clip()
        for p in L["water_poly"]:
            poly_path(ctx, p)
        ctx.set_source_rgba(*hexc(STYLE["water_poly"]))
        ctx.fill()
        stroke_lines(ctx, L["service"], STYLE["service"][0], STYLE["service"][1])
        stroke_lines(ctx, L["minor"], STYLE["minor"][0], STYLE["minor"][1])
        stroke_lines(ctx, L["medium"], STYLE["medium"][0], STYLE["medium"][1])
        # rim
        poly_path(ctx, plate)
        ctx.set_source_rgba(*hexc(STYLE["plate_rim"]))
        ctx.set_line_width(4.4)
        ctx.stroke()
        surf.flush()
        self.plate_surf = surf
        self.plate_png_size = (pw * SS, ph * SS)

        # shadow (comp px, blurred)
        sh = Image.new("L", (pw + 40, ph + 40), 0)
        d = ImageDraw.Draw(sh)
        d.polygon([(x - self.px0 + 20, y - self.py0 + 20) for x, y in plate.exterior.coords], fill=255)
        sh = sh.filter(ImageFilter.GaussianBlur(7))
        shimg = Image.new("RGBA", sh.size, (20, 30, 40, 0))
        shimg.putalpha(sh.point(lambda v: int(v * 0.32)))
        self.shadow_surf, self._shbuf = surface_from_pil(shimg)

        # vectors
        self.vec = V
        self.P = {k: Paths(V[k]) for k in V}

        # per-character text images
        self.char_surfs = []
        for ch, x in self.chars:
            if ch == " ":
                continue
            bb = self.font.getbbox(ch)
            im = Image.new("RGBA", (bb[2] + 8 * SS, int(self.font.size * 1.3)), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((4 * SS, 0), ch, font=self.font, fill=STYLE["text"])
            shadow = Image.new("RGBA", im.size, (0, 0, 0, 0))
            shadow.putalpha(im.getchannel("A").filter(ImageFilter.GaussianBlur(2.5 * SS)).point(lambda v: int(v * 0.35)))
            comb = Image.new("RGBA", im.size, (0, 0, 0, 0))
            comb.alpha_composite(shadow, (0, int(1.5 * SS)))
            comb.alpha_composite(im)
            s, buf = surface_from_pil(comb)
            self.char_surfs.append((s, buf, x - 4))
        self.ascent = self.font.getmetrics()[0] / SS

    def _layout_chars(self, text):
        x, out = 0.0, []
        tr = STYLE["tracking"]
        for ch in text:
            out.append((ch, x))
            x += self.font.getlength(ch) / SS + tr
        return out, x - tr

    # ---------------------------------------------------------------- export for AE
    def export(self, d):
        os.makedirs(d, exist_ok=True)
        surface_to_pil(self.plate_surf).save(os.path.join(d, "plate.png"), optimize=True)

        def pl(lines):
            return [[[round(x, 1), round(y, 1)] for x, y in g.coords] for g in lines]

        x0, y0, x1, y1 = self.plate.bounds
        c = self.city
        meta = {
            "slug": self.slug, "ru": c["ru"], "kk": c["kk"], "en": c["en"] or self.slug,
            "label": self.name,
            "labels": {"ru": c["ru"].upper(), "kk": (c["kk"] or c["ru"]).upper(), "en": self.slug.upper()},
            "population": c["pop"], "lon": c["lon"], "lat": c["lat"],
            "metres_per_px": round(self.r["m_per_px"], 2),
            "comp": {"w": W, "h": H, "fps": FPS, "duration": DURATION, "out_start": OUT_START},
            "marker_pos": list(self.pos),
            "plate_png": {"file": "plate.png", "scale": 1.0 / SS, "origin": [self.px0, self.py0],
                          "size": list(self.plate_png_size)},
            "plate_bounds": [round(v, 1) for v in (x0, y0, x1, y1)],
            "plate_outline": [[round(x, 1), round(y, 1)] for x, y in list(self.plate.exterior.coords)[:-1]],
            "label_layout": {"line_start": list(LINE_START), "elbow": list(ELBOW), "text_gap": TEXT_GAP,
                             "text_pad_left": TEXT_PAD_LEFT, "text_min_left": round(self.band_right + TEXT_CLEAR, 1),
                             "font_size": STYLE["font_size"], "tracking": STYLE["tracking"],
                             "line_end_estimate": round(self.line_end, 1)},
            "style": dict(STYLE, river=(STYLE["river"][0], self.river_w), gem_scale=GEM_SCALE),
            "paths": {k: pl(v) for k, v in self.vec.items()},
            "source": "© OpenStreetMap contributors, Overture Maps Foundation (ODbL)",
        }
        with open(os.path.join(d, "map.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    # ---------------------------------------------------------------- frame
    def frame(self, t, bg=GREEN):
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
        ctx = cairo.Context(surf)
        if bg is not None:
            ctx.set_source_rgb(*bg)
            ctx.paint()
        ctx.translate(*self.pos)
        ctx.set_line_join(cairo.LINE_JOIN_ROUND)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)

        x0, y0, x1, y1 = self.plate.bounds
        rmax = max(math.hypot(x, y) for x, y in ((x0, y0), (x0, y1), (x1, y0), (x1, y1))) + 30

        # plate reveal / out
        pin = e_out_cubic(prog(t, *T["plate"]))
        pout = e_in_cubic(prog(t, *T["out_plate"]))
        reveal = rmax * pin * (1 - pout)
        sc = (0.86 + 0.14 * e_out_back(prog(t, *T["plate"]), 1.2)) * (1 - 0.1 * pout)
        op = prog(t, 0.0, 0.2) * (1 - prog(t, T["out_plate"][0] + 0.25, T["out_plate"][1]))

        # outer roads (under the plate)
        o_in = e_inout_cubic(prog(t, *T["outer"]))
        o_out = e_in_cubic(prog(t, *T["out_roads"]))
        o_end = o_in * (1 - o_out)
        if o_end > 0:
            for k, (col, wdt) in (("outer_minor", STYLE["outer_minor"]), ("outer_major", STYLE["outer_major"])):
                ctx.set_source_rgba(*hexc(col, 0.95 * min(1, o_in * 3)))
                ctx.set_line_width(wdt)
                self.P[k].draw(ctx, 0, o_end)
                ctx.stroke()

        if reveal > 1 and op > 0:
            ctx.save()
            ctx.scale(sc, sc)
            # radial feathered reveal mask
            feather = 60
            rg = cairo.RadialGradient(0, 0, max(reveal - feather, 0), 0, 0, reveal)
            rg.add_color_stop_rgba(0, 0, 0, 0, op)
            rg.add_color_stop_rgba(1, 0, 0, 0, 0)
            ctx.push_group()
            ctx.set_source_surface(self.shadow_surf, self.px0 - 20 + 2, self.py0 - 20 + 6)
            ctx.paint()
            ctx.save()
            ctx.translate(self.px0, self.py0)
            ctx.scale(1 / SS, 1 / SS)
            ctx.set_source_surface(self.plate_surf, 0, 0)
            ctx.get_source().set_filter(cairo.FILTER_GOOD)
            ctx.paint()
            ctx.restore()
            # vectors on the plate
            m_end = e_out_cubic(prog(t, *T["major"])) * (1 - o_out)
            r_end = e_inout_cubic(prog(t, *T["river"])) * (1 - o_out)
            if r_end > 0:
                col, wdt = STYLE["river"][0], self.river_w
                hcol, hw = STYLE["river_halo"]
                for k, w0 in (("stream", STYLE["stream"][1]), ("river", wdt)):
                    ctx.set_source_rgba(*hexc(hcol, 0.9))
                    ctx.set_line_width(w0 + 2 * hw * (0.6 if k == "stream" else 1))
                    self.P[k].draw(ctx, 0, r_end)
                    ctx.stroke()
                ctx.set_source_rgba(*hexc(STYLE["stream"][0]))
                ctx.set_line_width(STYLE["stream"][1])
                self.P["stream"].draw(ctx, 0, r_end)
                ctx.stroke()
                ctx.set_source_rgba(*hexc(col))
                ctx.set_line_width(wdt)
                self.P["river"].draw(ctx, 0, r_end)
                ctx.stroke()
            if m_end > 0:
                ctx.set_source_rgba(*hexc(STYLE["major"][0]))
                ctx.set_line_width(STYLE["major"][1])
                self.P["major"].draw(ctx, 0, m_end)
                ctx.stroke()
            ctx.pop_group_to_source()
            ctx.mask(rg)
            ctx.restore()

        # marker
        mk = prog(t, *T["marker"])
        mo = e_in_back(prog(t, *T["out_marker"]))
        if mk > 0 and mo < 1:
            drop = -95 * (1 - e_out_back(mk, 2.2))
            s = (0.35 + 0.65 * e_out_back(min(1, mk * 1.6), 1.8)) * (1 - mo)
            bob = 2.0 * math.sin((t - T["marker"][1]) * 2.6) if t > T["marker"][1] else 0.0
            if s > 0.01:
                # contact shadow
                ctx.save()
                ctx.translate(0, 29 * GEM_SCALE)
                ctx.scale(1, 0.32)
                g = cairo.RadialGradient(0, 0, 0, 0, 0, 22 * s)
                g.add_color_stop_rgba(0, 0.1, 0.12, 0.2, 0.35 * min(1, mk * 2) * (1 - mo))
                g.add_color_stop_rgba(1, 0.1, 0.12, 0.2, 0)
                ctx.set_source(g)
                ctx.arc(0, 0, 22 * s, 0, 2 * math.pi)
                ctx.fill()
                ctx.restore()
                ctx.save()
                ctx.translate(0, drop + bob)
                ctx.scale(s * GEM_SCALE, s * GEM_SCALE)
                ctx.push_group()
                draw_gem(ctx)
                ctx.pop_group_to_source()
                ctx.paint_with_alpha(min(1, mk * 5))
                ctx.restore()

        # leader line
        li = e_inout_cubic(prog(t, *T["line"]))
        lo = e_inout_cubic(prog(t, *T["out_line"]))
        if li > 0 and lo < 1:
            pts = np.array([LINE_START, ELBOW, (self.line_end, ELBOW[1])])
            lp = Paths([shapely.LineString(pts)])
            col, wdt = STYLE["line"]
            ctx.set_source_rgba(*hexc(col))
            ctx.set_line_width(wdt)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            lp.draw(ctx, 0, li * (1 - lo))
            ctx.stroke()

        # text: per-character slide up, clipped above the line
        t0, stg, dur = T["text"]
        o0, ostg, odur = T["out_text"]
        tx0 = self.line_end - self.text_w
        n = len(self.char_surfs)
        ctx.save()
        ctx.rectangle(tx0 - 20, self.base_y - self.cap_h - 60, self.text_w + 60, 60 + self.cap_h + TEXT_GAP - 2.5)
        ctx.clip()
        for i, (s, _, x) in enumerate(self.char_surfs):
            pi = e_out_cubic(prog(t, t0 + i * stg, t0 + i * stg + dur))
            po = e_in_cubic(prog(t, o0 + (n - 1 - i) * ostg, o0 + (n - 1 - i) * ostg + odur))
            if pi <= 0 or po >= 1:
                continue
            dy = (1 - pi) * (self.cap_h + 14) + po * (self.cap_h + 14)
            ctx.save()
            ctx.translate(tx0 + x, self.base_y - self.ascent + dy)
            ctx.scale(1 / SS, 1 / SS)
            ctx.set_source_surface(s, 0, 0)
            ctx.paint_with_alpha(min(1, pi * 1.5) * (1 - po))
            ctx.restore()
        ctx.restore()
        surf.flush()
        return surf


def frame_bytes(surf):
    w, h, st = surf.get_width(), surf.get_height(), surf.get_stride()
    return np.frombuffer(surf.get_data(), np.uint8).reshape(h, st)[:, : w * 4].tobytes()


def render_city(slug, video=False, alpha=False):
    sc = Scene(slug)
    d = os.path.join(OUT, "cities", slug)
    sc.export(d)
    os.makedirs(os.path.join(OUT, "previews"), exist_ok=True)
    surface_to_pil(sc.frame(3.0)).convert("RGB").save(os.path.join(OUT, "previews", slug + ".jpg"), quality=90)
    if video:
        os.makedirs(os.path.join(OUT, "video"), exist_ok=True)
        fn = os.path.join(OUT, "video", slug + ".mp4")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}",
               "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", fn]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(int(DURATION * FPS)):
            p.stdin.write(frame_bytes(sc.frame(i / FPS)))
        p.stdin.close()
        p.wait()
    if alpha:  # transparent ProRes 4444 (big files, not committed)
        os.makedirs(os.path.join(OUT, "video_alpha"), exist_ok=True)
        fn = os.path.join(OUT, "video_alpha", slug + ".mov")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}",
               "-r", str(FPS), "-i", "-", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
               "-vendor", "apl0", fn]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(int(DURATION * FPS)):
            p.stdin.write(frame_bytes(sc.frame(i / FPS, bg=None)))
        p.stdin.close()
        p.wait()
    return slug


def write_index():
    """output/cities/index.json: list used by the AE script UI"""
    from cities import load
    d = os.path.join(OUT, "cities")
    idx = []
    for c in load():
        if os.path.exists(os.path.join(d, c["slug"], "map.json")):
            idx.append({"slug": c["slug"], "ru": c["ru"], "kk": c["kk"], "population": c["pop"]})
    with open(os.path.join(d, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    print("index:", len(idx))


def _job(args):
    slug, video, alpha = args
    try:
        render_city(slug, video, alpha)
        return slug, None
    except Exception as e:  # keep going with the other cities
        import traceback
        return slug, traceback.format_exc()


if __name__ == "__main__":
    args = sys.argv[1:]
    video = "--video" in args
    alpha = "--alpha" in args
    args = [a for a in args if not a.startswith("--")]
    if "--all" in sys.argv:
        from cities import load
        args = [c["slug"] for c in load()]
    if "--index" in sys.argv:
        write_index()
        sys.exit(0)
    with Pool(int(os.environ.get("JOBS", os.cpu_count() or 2))) as pool:
        for slug, err in pool.imap_unordered(_job, [(a, video, alpha) for a in args]):
            print(slug, "OK" if err is None else "FAILED\n" + err, flush=True)
    write_index()
