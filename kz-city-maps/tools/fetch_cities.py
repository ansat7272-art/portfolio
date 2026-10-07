"""Step 1: list Kazakhstan localities (cities/towns) from Overture divisions."""
import json, sys
import pyarrow.compute as pc
import shapely
from overture import read

KZ = (46.4, 40.5, 87.4, 55.5)
cols = ["id", "geometry", "bbox", "country", "subtype", "class", "names", "population", "wikidata", "region"]

def flt(t):
    m = pc.and_(pc.equal(t["country"], "KZ"), pc.equal(t["subtype"], "locality"))
    return t.filter(m)

t = read("divisions", "division", [KZ], columns=cols, row_filter=flt)
rows = []
for r in t.to_pylist():
    names = r["names"] or {}
    common = dict(names.get("common") or [])
    g = shapely.from_wkb(r["geometry"])
    rows.append(dict(id=r["id"], cls=r["class"], pop=r["population"] or 0,
                     name=names.get("primary"), ru=common.get("ru"), kk=common.get("kk"),
                     en=common.get("en"), lon=g.x, lat=g.y, region=r["region"], wikidata=r["wikidata"]))
rows.sort(key=lambda r: -r["pop"])
json.dump(rows, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(rows))
for r in rows[:120]:
    print(r["cls"], r["pop"], r["ru"], r["name"], round(r["lon"], 4), round(r["lat"], 4), r["region"])
