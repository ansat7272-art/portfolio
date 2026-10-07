"""Geometry stage: project raw Overture data, derive the 'paper' city plate and
classify everything into the layers used by the renderer and the AE script."""
import math, pickle, os, random
import numpy as np
import shapely
from shapely import geometry as sg
from scipy import ndimage
from skimage import measure

from cities import DATA

URBAN = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "living_street",
         "service", "unclassified", "pedestrian", "unknown"}
OUTER = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "track"}
OUTER_MAJOR = {"motorway", "trunk", "primary", "secondary"}
RANK = {"motorway": 0, "trunk": 0, "primary": 1, "secondary": 2, "tertiary": 3}

# ---- layout constants (comp pixels, 1920x1080) ----
PLATE_SIZE = 330.0   # sqrt(plate area) on screen
PLATE_MAX = 480.0    # max plate extent on screen


def load_raw(slug):
    with open(os.path.join(DATA, "raw", slug + ".pkl"), "rb") as f:
        return pickle.load(f)


class Proj:
    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110574.0

    def __call__(self, xy):  # lon/lat -> metres, y down
        out = np.empty_like(xy)
        out[:, 0] = (xy[:, 0] - self.lon0) * self.kx
        out[:, 1] = -(xy[:, 1] - self.lat0) * self.ky
        return out


def _lines(geoms):
    """explode to LineStrings"""
    out = []
    for g in geoms:
        if g is None or g.is_empty:
            continue
        if g.geom_type == "LineString":
            out.append(g)
        elif g.geom_type in ("MultiLineString", "GeometryCollection"):
            out.extend([p for p in g.geoms if p.geom_type == "LineString" and not p.is_empty])
    return out


def _polys(geoms):
    out = []
    for g in geoms:
        if g is None or g.is_empty:
            continue
        if g.geom_type == "Polygon":
            out.append(g)
        elif g.geom_type in ("MultiPolygon", "GeometryCollection"):
            out.extend([p for p in g.geoms if p.geom_type == "Polygon" and not p.is_empty])
    return out


def density_grid(lines, half, cell):
    n = int(math.ceil(2 * half / cell))
    seg = shapely.segmentize(np.array(lines, dtype=object), cell / 3)
    coords, idx = shapely.get_coordinates(seg, return_index=True)
    same = idx[1:] == idx[:-1]
    a, b = coords[:-1][same], coords[1:][same]
    mid = (a + b) / 2
    ln = np.hypot(*(b - a).T)
    H, _, _ = np.histogram2d(mid[:, 1], mid[:, 0], bins=n, range=[[-half, half], [-half, half]], weights=ln)
    # km of road per km^2
    return H / 1000.0 / (cell * cell / 1e6), n


def _component_near_centre(m):
    lab, _ = ndimage.label(m)
    c = m.shape[0] // 2
    if lab[c, c]:
        return lab == lab[c, c]
    ys, xs = np.nonzero(lab)
    if len(ys) == 0:
        raise RuntimeError("no urban area")
    k = np.argmin((ys - c) ** 2 + (xs - c) ** 2)
    return lab == lab[ys[k], xs[k]]


def _opening(m, r):
    er = ndimage.distance_transform_edt(m) > r
    return ndimage.distance_transform_edt(~er) <= r


def _closing(m, r):
    di = ndimage.distance_transform_edt(~m) <= r
    return ndimage.distance_transform_edt(di) > r


def make_plate(urban_lines, half, rng, pop):
    """Built-up area from road density -> compact 'cut paper' polygon (metres)."""
    cell = 100.0
    D, n = density_grid(urban_lines, half, cell)
    Ds = ndimage.gaussian_filter(D, 2.2)
    m = ndimage.binary_closing(Ds > 4.5, iterations=3)
    # keep neighbouring towns / agglomerations out: limit to a disk sized by population
    r_lim = 1.3 * max(2500.0, 1600.0 * math.sqrt(max(pop, 1000) / 1e4)) / cell
    yy, xx = np.mgrid[0:n, 0:n] - (n - 1) / 2.0
    m &= (xx * xx + yy * yy) <= r_lim * r_lim
    m = ndimage.binary_fill_holes(_component_near_centre(m))
    # guarantee a minimum plate for tiny towns
    min_cells = (1600.0 / cell) ** 2
    if m.sum() < min_cells:
        r = (math.sqrt(min_cells) - math.sqrt(m.sum())) / 2
        m = ndimage.distance_transform_edt(~m) <= r
    size = math.sqrt(m.sum())
    mo = _opening(m, 0.05 * size)            # drop thin road corridors
    if mo.sum() < 0.3 * m.sum():
        mo = m
    mo = _component_near_centre(mo)
    mo = ndimage.binary_fill_holes(_closing(mo, 0.08 * size))
    size = math.sqrt(mo.sum())
    sm = ndimage.gaussian_filter(mo.astype(float), max(1.0, size * 0.012))
    cs = measure.find_contours(sm, 0.5)
    polys = [sg.Polygon(np.c_[c[:, 1] + 0.5, c[:, 0] + 0.5]) for c in cs if len(c) > 3]
    poly = max(polys, key=lambda p: p.area).buffer(0)
    poly = poly.simplify(size * 0.022, preserve_topology=True)

    # chunky tabs where the town spills out along roads (data driven, max 3)
    spill = m & ~mo
    lab, nl = ndimage.label(spill)
    if nl:
        sizes = ndimage.sum(spill, lab, range(1, nl + 1))
        reach = poly.buffer(size * 0.10, join_style="mitre")
        for k in np.argsort(sizes)[::-1][:3]:
            if sizes[k] < 0.004 * size * size:
                break
            ys, xs = np.nonzero(lab == k + 1)
            comp = sg.MultiPoint(np.c_[xs + 0.5, ys + 0.5]).buffer(0.75, cap_style="square")
            tab = comp.minimum_rotated_rectangle.intersection(reach)
            if tab.is_empty or tab.area < 0.002 * size * size:
                continue
            poly = shapely.union(poly, tab.buffer(0))
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda p: p.area)
        poly = sg.Polygon(poly.exterior).simplify(size * 0.008)

    # serrate long edges a little + jitter -> hand-cut paper look
    pts = np.array(poly.exterior.coords)
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        out.append(a + rng.uniform(-1, 1, 2) * size * 0.005)
        L = np.hypot(*(b - a))
        if L > size * 0.12:
            nrm = np.array([-(b - a)[1], (b - a)[0]]) / L
            for f in sorted(rng.uniform(0.25, 0.75, int(L // (size * 0.12)))):
                out.append(a + (b - a) * f + nrm * rng.uniform(-1, 1) * size * 0.012)
    poly = sg.Polygon(out).buffer(0)
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    # grid cells -> metres
    poly = shapely.transform(sg.Polygon(poly.exterior), lambda xy: xy * cell - half)
    return poly, size * cell / 15.0


def ray_extent(poly, cx, cy, ang, rmax):
    ray = sg.LineString([(cx, cy), (cx + rmax * math.cos(ang), cy + rmax * math.sin(ang))])
    inter = ray.intersection(poly.exterior)
    if inter.is_empty:
        return 0.0
    pts = shapely.get_coordinates(inter)
    return float(np.max(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)))


def outer_region(plate, rng, reach):
    c = plate.centroid
    rmax = 10 * math.sqrt(plate.area)
    n = 90
    ph = rng.uniform(0, 2 * math.pi, 4)
    pts = []
    for k in range(n):
        a = 2 * math.pi * k / n
        noise = (0.5 * math.sin(2 * a + ph[0]) + 0.3 * math.sin(3 * a + ph[1]) +
                 0.25 * math.sin(5 * a + ph[2]) + 0.15 * math.sin(9 * a + ph[3]))
        r = ray_extent(plate, c.x, c.y, a, rmax) + reach * (0.95 + 0.45 * noise)
        pts.append((c.x + r * math.cos(a), c.y + r * math.sin(a)))
    return sg.Polygon(pts).buffer(0)


def build(slug):
    raw = load_raw(slug)
    city = raw["city"]
    seed = sum(ord(ch) for ch in slug)
    rng = np.random.default_rng(seed)
    P = Proj(city["lon"], city["lat"])
    a, b, c, d = raw["bbox"]
    half = min((c - a) / 2 * P.kx, (d - b) / 2 * P.ky)

    rg = shapely.from_wkb([r["geometry"] for r in raw["roads"]])
    rg = shapely.transform(rg, P)
    rcls = np.array([r["class"] for r in raw["roads"]], dtype=object)

    urban = [g for g, k in zip(rg, rcls) if k in URBAN]
    plate, csz = make_plate(urban, half * 0.97, rng, city["pop"])

    # ---- scale: metres -> comp px, origin at the city point ----
    area_km2 = plate.area / 1e6
    target = PLATE_SIZE * min(1.0, max(0.78, (area_km2 / 60.0) ** 0.12))
    s = target / math.sqrt(plate.area)
    x0, y0, x1, y1 = plate.bounds
    s = min(s, PLATE_MAX / max(x1 - x0, y1 - y0))
    S = lambda g: shapely.transform(g, lambda xy: xy * s)
    plate_px = S(plate)
    rg_px = S(rg)
    m_per_px = 1.0 / s

    reach = 0.40 * PLATE_SIZE
    outer = outer_region(plate_px, rng, reach)
    outer_ring = outer.difference(plate_px)

    # ---- roads by layer ----
    by = {}
    for g, k in zip(rg_px, rcls):
        by.setdefault(k, []).append(g)

    def clip(lines, region):
        if not lines:
            return []
        arr = shapely.intersection(np.array(lines, dtype=object), region)
        return _lines(arr)

    # choose which classes are "major" (vector, animated) so every city has a few
    plen = math.sqrt(plate_px.area)
    major_cls = ["motorway", "trunk", "primary"]
    def total(cls):
        return sum(g.length for k in cls for g in clip(by.get(k, []), plate_px))
    for extra in ("secondary", "tertiary"):
        if total(major_cls) < 3.0 * plen:
            major_cls.append(extra)
    medium_cls = [k for k in ("secondary", "tertiary") if k not in major_cls]
    minor_cls = ["residential", "living_street", "unclassified", "pedestrian", "unknown", "track"]
    service = m_per_px < 75

    layers = {}
    layers["major"] = clip(sum((by.get(k, []) for k in major_cls), []), plate_px)
    layers["medium"] = clip(sum((by.get(k, []) for k in medium_cls), []), plate_px)
    layers["minor"] = clip(sum((by.get(k, []) for k in minor_cls), []), plate_px)
    layers["service"] = clip(by.get("service", []), plate_px) if service else []
    outer_major = clip(sum((by.get(k, []) for k in OUTER_MAJOR), []), outer_ring)
    outer_minor = clip(sum((by.get(k, []) for k in OUTER - OUTER_MAJOR), []), outer_ring)

    # ---- water ----
    wg = shapely.transform(shapely.from_wkb([w["geometry"] for w in raw["water"]]), P)
    wg = S(wg)
    wsub = [w["subtype"] for w in raw["water"]]
    wcls = [w["class"] for w in raw["water"]]
    wint = [bool(w.get("is_intermittent")) for w in raw["water"]]
    river_lines, stream_lines, water_polys, river_polys = [], [], [], []
    for g, st, cl, it in zip(wg, wsub, wcls, wint):
        if g is None or g.is_empty:
            continue
        gt = g.geom_type
        if "Line" in gt:
            if st == "river":
                river_lines.append(g)
            elif st in ("canal", "stream") and cl in ("canal", "stream", "river"):
                stream_lines.append(g)
        elif "Polygon" in gt:
            if cl in ("swimming_pool", "wastewater", "fountain") or st == "human_made":
                continue
            if st in ("river", "canal"):
                river_polys.append(g)
            else:
                water_polys.append(g)
    water_area = shapely.union_all(water_polys + river_polys) if (water_polys or river_polys) else None
    layers["river"] = clip(river_lines, plate_px)
    layers["stream"] = clip(stream_lines, plate_px)
    layers["water_poly"] = _polys([shapely.intersection(water_area, plate_px)]) if water_area is not None else []

    # merge & simplify vector layers that get animated in AE
    def merge(lines, tol, min_len):
        if not lines:
            return []
        mm = shapely.line_merge(shapely.union_all(lines))
        out = [g.simplify(tol) for g in _lines([mm])]
        return [g for g in out if g.length >= min_len]

    vec = {
        "major": merge(layers["major"], 0.35, 4),
        "river": merge(layers["river"], 0.35, 4),
        "stream": merge(layers["stream"], 0.35, 6),
        "outer_major": merge(outer_major, 0.45, 6),
        "outer_minor": merge(outer_minor, 0.45, 8),
    }
    # orient outer roads outward (start at the end closest to the plate)
    for k in ("outer_major", "outer_minor"):
        res = []
        for g in vec[k]:
            p0, p1 = sg.Point(g.coords[0]), sg.Point(g.coords[-1])
            if plate_px.exterior.distance(p0) > plate_px.exterior.distance(p1):
                g = sg.LineString(list(g.coords)[::-1])
            res.append(g)
        res.sort(key=lambda g: -g.length)
        vec[k] = res[:450] if k == "outer_major" else [g for g in res if g.length >= 14][:160]

    rl = sum(g.length for g in vec["river"]) / plen
    sl = sum(g.length for g in vec["stream"]) / plen
    if sl > 3.0:
        vec["stream"] = []
    river_w = 3.3 if rl < 3.0 else 2.5 if rl < 6.0 else 1.9
    return dict(city=city, scale=s, river_w=river_w, m_per_px=m_per_px, plate=plate_px, outer=outer, layers=layers, vec=vec,
                major_cls=major_cls)
