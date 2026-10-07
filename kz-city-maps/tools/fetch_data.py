"""Step 2: download roads + water for every city window from Overture into data/raw/<slug>.pkl"""
import os, pickle, sys
import numpy as np
import pyarrow.compute as pc
from cities import load, fetch_halfsize_km, bbox, DATA
from overture import read

RAW = os.path.join(DATA, "raw")
os.makedirs(RAW, exist_ok=True)

ROAD_DROP = {"footway", "cycleway", "steps", "path", "bridleway", "sidewalk", "crosswalk"}


def split(table, cities, boxes, fields):
    bb = table.column("bbox").combine_chunks()
    x0 = bb.field("xmin").to_numpy(zero_copy_only=False); x1 = bb.field("xmax").to_numpy(zero_copy_only=False)
    y0 = bb.field("ymin").to_numpy(zero_copy_only=False); y1 = bb.field("ymax").to_numpy(zero_copy_only=False)
    cols = {f: table.column(f).to_pylist() for f in fields}
    out = {}
    for c, (a, b, cc, d) in zip(cities, boxes):
        idx = np.nonzero(~((x1 < a) | (x0 > cc) | (y1 < b) | (y0 > d)))[0]
        out[c["slug"]] = [{f: cols[f][i] for f in fields} for i in idx]
    return out


def main(only=None):
    cities = load()
    if only:
        cities = [c for c in cities if c["slug"] in only]
    cities = [c for c in cities if not os.path.exists(os.path.join(RAW, c["slug"] + ".pkl"))]
    if not cities:
        print("nothing to fetch"); return
    boxes = [bbox(c, fetch_halfsize_km(c["pop"])) for c in cities]

    def road_filter(t):
        m = pc.and_(pc.equal(t["subtype"], "road"), pc.invert(pc.is_in(t["class"], value_set=__import__("pyarrow").array(sorted(ROAD_DROP)))))
        return t.filter(m)

    roads = read("transportation", "segment", boxes, columns=["geometry", "bbox", "subtype", "class", "subclass"],
                 row_filter=road_filter)
    print("roads", len(roads), flush=True)
    water = read("base", "water", boxes, columns=["geometry", "bbox", "subtype", "class", "is_salt", "is_intermittent"])
    print("water", len(water), flush=True)
    r_by = split(roads, cities, boxes, ["geometry", "class", "subclass"])
    w_by = split(water, cities, boxes, ["geometry", "subtype", "class", "is_intermittent"])
    for c, b in zip(cities, boxes):
        with open(os.path.join(RAW, c["slug"] + ".pkl"), "wb") as f:
            pickle.dump(dict(city=c, bbox=b, roads=r_by[c["slug"]], water=w_by[c["slug"]]), f)
        print(c["slug"], len(r_by[c["slug"]]), len(w_by[c["slug"]]))


if __name__ == "__main__":
    main(sys.argv[1:] or None)
