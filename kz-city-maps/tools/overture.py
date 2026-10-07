"""Minimal Overture Maps reader: fetches only the parquet row groups whose
bbox statistics intersect the requested boxes (no STAC / DuckDB needed)."""
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import pyarrow as pa
import pyarrow.fs as pafs
import pyarrow.parquet as pq

RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-09-23.1")
BUCKET = "overturemaps-us-west-2/release/"


def _fs():
    kw = dict(anonymous=True, region="us-west-2")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        p = urlparse(proxy)
        kw["proxy_options"] = {"scheme": p.scheme, "host": p.hostname, "port": p.port}
    return pafs.S3FileSystem(**kw)


FS = _fs()


def _rg_bbox(md, rg_idx, col_idx):
    rg = md.row_group(rg_idx)
    out = {}
    for k, j in col_idx.items():
        st = rg.column(j).statistics
        if st is None or not st.has_min_max:
            return None
        out[k] = (st.min, st.max)
    return out


def _intersects(rgb, box):
    x0, y0, x1, y1 = box
    # row group extent: xmin in [min,max], xmax in [min,max] ...
    return not (rgb["xmax"][1] < x0 or rgb["xmin"][0] > x1 or
                rgb["ymax"][1] < y0 or rgb["ymin"][0] > y1)


def read(theme, type_, boxes, columns=None, row_filter=None, workers=16):
    """Return a pyarrow Table with rows whose bbox intersects any of `boxes`
    (list of (xmin, ymin, xmax, ymax))."""
    path = f"{BUCKET}{RELEASE}/theme={theme}/type={type_}/"
    files = [i.path for i in FS.get_file_info(pafs.FileSelector(path)) if i.path.endswith(".parquet")]

    def plan(fp):
        f = pq.ParquetFile(fp, filesystem=FS)
        md = f.metadata
        names = [md.row_group(0).column(j).path_in_schema for j in range(md.num_columns)]
        col_idx = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
        hits = []
        for i in range(md.num_row_groups):
            rgb = _rg_bbox(md, i, col_idx)
            if rgb is None or any(_intersects(rgb, b) for b in boxes):
                hits.append(i)
        return fp, hits

    with ThreadPoolExecutor(workers) as ex:
        plans = [p for p in ex.map(plan, files) if p[1]]

    def fetch(job):
        fp, rg = job
        f = pq.ParquetFile(fp, filesystem=FS)
        t = f.read_row_groups([rg], columns=columns)
        bb = t.column("bbox").combine_chunks()
        xmin = bb.field("xmin").to_numpy(zero_copy_only=False)
        xmax = bb.field("xmax").to_numpy(zero_copy_only=False)
        ymin = bb.field("ymin").to_numpy(zero_copy_only=False)
        ymax = bb.field("ymax").to_numpy(zero_copy_only=False)
        import numpy as np
        m = np.zeros(len(t), bool)
        for x0, y0, x1, y1 in boxes:
            m |= ~((xmax < x0) | (xmin > x1) | (ymax < y0) | (ymin > y1))
        t = t.filter(pa.array(m))
        if row_filter is not None and len(t):
            t = row_filter(t)
        return t

    jobs = [(fp, rg) for fp, rgs in plans for rg in rgs]
    print(f"[overture] {theme}/{type_}: {len(files)} files, {len(jobs)} row groups to fetch", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        parts = [t for t in ex.map(fetch, jobs) if len(t)]
    if not parts:
        return None
    return pa.concat_tables(parts, promote_options="default")
