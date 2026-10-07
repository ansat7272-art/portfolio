/*
  Dry-run of after-effects/KZ_City_Maps.jsx outside After Effects.
  Mocks the parts of the AE / ScriptUI object model the script touches, runs it for
  every city, and checks: JS errors, unknown matchNames, stale property references
  (AE invalidates sibling references after addProperty/remove), ease array sizes,
  and that every expression compiles and evaluates.

      node tools/ae_mock_test.js            # all cities, default options
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const JSX = path.join(ROOT, "after-effects", "KZ_City_Maps.jsx");

// ---------------------------------------------------------------- property model
const PVT = { NO_VALUE: 0, ThreeD_SPATIAL: 1, ThreeD: 2, TwoD_SPATIAL: 3, TwoD: 4, OneD: 5, COLOR: 6, CUSTOM_VALUE: 7, MARKER: 8, LAYER_INDEX: 9, MASK_INDEX: 10, SHAPE: 11, TEXT_DOCUMENT: 12 };

const LEAF = {
  "ADBE Anchor Point": PVT.ThreeD_SPATIAL, "ADBE Position": PVT.ThreeD_SPATIAL, "ADBE Scale": PVT.ThreeD,
  "ADBE Opacity": PVT.OneD, "ADBE Rotate Z": PVT.OneD, "ADBE Position_0": PVT.OneD, "ADBE Position_1": PVT.OneD,
  "ADBE Vector Shape": PVT.SHAPE, "ADBE Vector Trim Start": PVT.OneD, "ADBE Vector Trim End": PVT.OneD,
  "ADBE Vector Trim Offset": PVT.OneD, "ADBE Vector Trim Type": PVT.OneD,
  "ADBE Vector Stroke Color": PVT.COLOR, "ADBE Vector Stroke Width": PVT.OneD, "ADBE Vector Stroke Opacity": PVT.OneD,
  "ADBE Vector Stroke Line Cap": PVT.OneD, "ADBE Vector Stroke Line Join": PVT.OneD,
  "ADBE Vector Fill Color": PVT.COLOR, "ADBE Vector Fill Opacity": PVT.OneD,
  "ADBE Vector Ellipse Size": PVT.TwoD, "ADBE Vector Ellipse Position": PVT.TwoD_SPATIAL,
  "ADBE Mask Shape": PVT.SHAPE, "ADBE Mask Feather": PVT.TwoD, "ADBE Mask Opacity": PVT.OneD, "ADBE Mask Expansion": PVT.OneD,
  "ADBE Drop Shadow-0001": PVT.COLOR, "ADBE Drop Shadow-0002": PVT.OneD, "ADBE Drop Shadow-0003": PVT.OneD,
  "ADBE Drop Shadow-0004": PVT.OneD, "ADBE Drop Shadow-0005": PVT.OneD, "ADBE Drop Shadow-0006": PVT.OneD,
  "ADBE Gaussian Blur 2-0001": PVT.OneD,
  "ADBE Text Document": PVT.TEXT_DOCUMENT, "ADBE Text Position 3D": PVT.ThreeD_SPATIAL, "ADBE Text Opacity": PVT.OneD,
  "ADBE Text Expressible Amount": PVT.ThreeD,
};
const MAXV = { "ADBE Drop Shadow-0002": 255 };
const AUTO = {
  LAYER: ["ADBE Transform Group", "ADBE Effect Parade", "ADBE Mask Parade"],
  "ADBE Transform Group": ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Opacity", "ADBE Rotate Z", "ADBE Position_0", "ADBE Position_1"],
  "ADBE Vector Group": ["ADBE Vectors Group"],
  "ADBE Vector Shape - Group": ["ADBE Vector Shape"],
  "ADBE Vector Filter - Trim": ["ADBE Vector Trim Start", "ADBE Vector Trim End", "ADBE Vector Trim Offset", "ADBE Vector Trim Type"],
  "ADBE Vector Graphic - Stroke": ["ADBE Vector Stroke Color", "ADBE Vector Stroke Width", "ADBE Vector Stroke Opacity", "ADBE Vector Stroke Line Cap", "ADBE Vector Stroke Line Join"],
  "ADBE Vector Graphic - Fill": ["ADBE Vector Fill Color", "ADBE Vector Fill Opacity"],
  "ADBE Vector Shape - Ellipse": ["ADBE Vector Ellipse Size", "ADBE Vector Ellipse Position"],
  "ADBE Mask Atom": ["ADBE Mask Shape", "ADBE Mask Feather", "ADBE Mask Opacity", "ADBE Mask Expansion"],
  "ADBE Drop Shadow": ["ADBE Drop Shadow-0001", "ADBE Drop Shadow-0002", "ADBE Drop Shadow-0003", "ADBE Drop Shadow-0004", "ADBE Drop Shadow-0005", "ADBE Drop Shadow-0006"],
  "ADBE Gaussian Blur 2": ["ADBE Gaussian Blur 2-0001"],
  "ADBE Text Properties": ["ADBE Text Document", "ADBE Text Animators"],
  "ADBE Text Animator": ["ADBE Text Animator Properties", "ADBE Text Selectors"],
  "ADBE Text Expressible Selector": ["ADBE Text Expressible Amount"],
};
const VEC = ["ADBE Vector Group", "ADBE Vector Shape - Group", "ADBE Vector Filter - Trim", "ADBE Vector Graphic - Stroke", "ADBE Vector Graphic - Fill", "ADBE Vector Shape - Ellipse"];
const ADDABLE = {
  "ADBE Root Vectors Group": VEC, "ADBE Vectors Group": VEC,
  "ADBE Mask Parade": ["ADBE Mask Atom"],
  "ADBE Effect Parade": ["ADBE Drop Shadow", "ADBE Gaussian Blur 2"],
  "ADBE Text Animators": ["ADBE Text Animator"],
  "ADBE Text Animator Properties": ["ADBE Text Position 3D", "ADBE Text Opacity"],
  "ADBE Text Selectors": ["ADBE Text Expressible Selector", "ADBE Text Selector"],
};

let STATS = { props: 0, keys: 0, expressions: [] };

class Prop {
  constructor(matchName, parent, layer) {
    this.matchName = matchName;
    this._name = matchName;
    this.parentProperty = parent;
    this._layer = layer;
    this._kids = [];
    this._keys = [];
    this._valid = true;
    this._expr = "";
    this._value = undefined;
    this._sep = false;
    STATS.props++;
  }
  _chk() { if (!this._valid) throw new Error("Object is invalid (stale reference to " + this.matchName + ")"); }
  get name() { this._chk(); return this._name; }
  set name(v) { this._chk(); this._name = v; }
  get propertyValueType() { this._chk(); return LEAF[this.matchName] !== undefined ? LEAF[this.matchName] : PVT.NO_VALUE; }
  get numProperties() { this._chk(); return this._kids.length; }
  get hasMax() { return MAXV[this.matchName] !== undefined; }
  get maxValue() { return MAXV[this.matchName]; }
  get dimensionsSeparated() { return this._sep; }
  set dimensionsSeparated(v) { this._chk(); if (this.matchName !== "ADBE Position") throw new Error("dimensionsSeparated on " + this.matchName); this._sep = v; }
  get expression() { return this._expr; }
  set expression(v) {
    this._chk();
    if (LEAF[this.matchName] === undefined) throw new Error("expression on group " + this.matchName);
    this._expr = v;
    STATS.expressions.push({ prop: this.matchName, layer: this._layer && this._layer.name, src: v });
  }
  get value() {
    this._chk();
    if (this.matchName === "ADBE Text Document") return this._value || new TextDocument("");
    return this._value;
  }
  _invalidateTree() { this._valid = false; this._kids.forEach((k) => k._invalidateTree()); }
  property(k) {
    this._chk();
    if (typeof k === "number") {
      const c = this._kids[k - 1];
      if (!c) throw new Error("no property #" + k + " in " + this.matchName);
      return c;
    }
    let c = this._kids.find((x) => x.matchName === k || x._name === k);
    const auto = AUTO[this.matchName] || [];
    if (!c && auto.includes(k)) {
      if ((k === "ADBE Position_0" || k === "ADBE Position_1") && !this.property("ADBE Position")._sep)
        throw new Error("Position_1 used before dimensionsSeparated");
      c = new Prop(k, this, this._layer);
      this._kids.push(c);
    }
    if (!c) throw new Error('property "' + k + '" not found in ' + this.matchName);
    return c;
  }
  addProperty(mn) {
    this._chk();
    const ok = ADDABLE[this.matchName] || [];
    if (!ok.includes(mn)) throw new Error("cannot add " + mn + " to " + this.matchName);
    this._kids.forEach((k) => k._invalidateTree()); // AE: existing siblings become invalid
    this._kids = this._kids.map((k) => { const n = Object.assign(Object.create(Prop.prototype), k); n._valid = true; return n; });
    const p = new Prop(mn, this, this._layer);
    this._kids.push(p);
    return p;
  }
  remove() {
    this._chk();
    const par = this.parentProperty;
    par._kids.forEach((k) => k._invalidateTree());
    par._kids = par._kids.filter((k) => k.matchName !== this.matchName || k._name !== this._name)
      .map((k) => { const n = Object.assign(Object.create(Prop.prototype), k); n._valid = true; return n; });
  }
  setValue(v) {
    this._chk();
    if (LEAF[this.matchName] === undefined) throw new Error("setValue on group " + this.matchName);
    if (v === undefined || v === null || (typeof v === "number" && isNaN(v))) throw new Error("bad value for " + this.matchName);
    if (Array.isArray(v) && v.some((x) => typeof x !== "number" || isNaN(x))) throw new Error("NaN in " + this.matchName + " " + JSON.stringify(v));
    if (this.matchName.includes("Shape") && LEAF[this.matchName] === PVT.SHAPE && !(v instanceof Shape)) throw new Error("not a Shape");
    if (v instanceof Shape) v._check();
    this._value = v;
  }
  setValueAtTime(t, v) {
    if (typeof t !== "number" || isNaN(t)) throw new Error("bad time");
    this.setValue(v);
    const i = this._keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
    if (i >= 0) this._keys[i].v = v; else this._keys.push({ t, v });
    this._keys.sort((a, b) => a.t - b.t);
    STATS.keys++;
  }
  nearestKeyIndex(t) {
    let best = 1, bd = 1e9;
    this._keys.forEach((k, i) => { if (Math.abs(k.t - t) < bd) { bd = Math.abs(k.t - t); best = i + 1; } });
    return best;
  }
  setInterpolationTypeAtKey(k, a, b) { this._chk(); if (k < 1 || k > this._keys.length) throw new Error("key index"); }
  keyInInterpolationType() { return 6612; }
  setTemporalEaseAtKey(k, inE, outE) {
    this._chk();
    if (k < 1 || k > this._keys.length) throw new Error("key index");
    const pvt = this.propertyValueType;
    const need = pvt === PVT.ThreeD ? 3 : pvt === PVT.TwoD ? 2 : 1;
    if (inE.length !== need || outE.length !== need) throw new Error("ease dims " + inE.length + " != " + need + " for " + this.matchName);
    [...inE, ...outE].forEach((e) => { if (!(e.influence >= 0.1 && e.influence <= 100)) throw new Error("influence " + e.influence); });
  }
}

class Shape {
  constructor() { this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true; }
  _check() {
    if (!this.vertices.length) throw new Error("empty Shape");
    this.vertices.forEach((p) => { if (p.length !== 2 || p.some((x) => typeof x !== "number" || isNaN(x))) throw new Error("bad vertex " + JSON.stringify(p)); });
    if (this.inTangents.length && this.inTangents.length !== this.vertices.length) throw new Error("tangent count");
  }
}
class KeyframeEase { constructor(speed, influence) { this.speed = speed; this.influence = influence; } }
class TextDocument { constructor(t) { this.text = t; this.fontSize = 12; } resetCharStyle() {} resetParagraphStyle() {} }

// ---------------------------------------------------------------- layers / items
class Layer {
  constructor(comp, kind, name) {
    this.containingComp = comp; this.kind = kind; this._name = name; this.parent = null; this.locked = false;
    this._root = new Prop("LAYER", null, this);
    if (kind === "shape") { this._root._kids.push(new Prop("ADBE Root Vectors Group", this._root, this)); }
    if (kind === "text") { const tp = new Prop("ADBE Text Properties", this._root, this); this._root._kids.push(tp); tp.property("ADBE Text Document")._value = new TextDocument(name); }
  }
  get name() { return this._name; }
  set name(v) { this._name = v; }
  set parent(p) { if (p && !(p instanceof Layer)) throw new Error("parent must be layer"); this._parent = p; }
  get parent() { return this._parent; }
  property(k) { return this._root.property(k); }
  sourceRectAtTime(t, ext) {
    if (this.kind !== "text") throw new Error("sourceRectAtTime on " + this.kind);
    const td = this.property("ADBE Text Properties").property("ADBE Text Document").value;
    const w = td.text.length * td.fontSize * 0.75;
    return { left: -w, top: -td.fontSize * 0.72, width: w, height: td.fontSize * 0.72 };
  }
  moveToBeginning() { const L = this.containingComp.layers; L._list.splice(L._list.indexOf(this), 1); L._list.unshift(this); }
  moveToEnd() { const L = this.containingComp.layers; L._list.splice(L._list.indexOf(this), 1); L._list.push(this); }
  moveAfter(o) { const L = this.containingComp.layers; L._list.splice(L._list.indexOf(this), 1); L._list.splice(L._list.indexOf(o) + 1, 0, this); }
  set quality(v) { if (v === undefined) throw new Error("quality undefined"); }
  set samplingQuality(v) { if (v === undefined) throw new Error("samplingQuality undefined"); }
  set startTime(v) { this._start = v; }
}
class LayerCollection {
  constructor(comp) { this.comp = comp; this._list = []; }
  _add(l) { this._list.unshift(l); return l; }
  addShape() { return this._add(new Layer(this.comp, "shape", "Shape Layer")); }
  addNull(d) { return this._add(new Layer(this.comp, "null", "Null")); }
  addSolid(c, n, w, h, pa, d) { if (c.length !== 3) throw new Error("solid color"); return this._add(new Layer(this.comp, "solid", n)); }
  addText(t) { if (typeof t !== "string") throw new Error("addText"); return this._add(new Layer(this.comp, "text", t)); }
  add(item) { if (!item) throw new Error("add(null)"); return this._add(new Layer(this.comp, "footage", item.name)); }
  get length() { return this._list.length; }
}
let NEXT_ID = 1;
class Item { constructor(name) { this.name = name; this.id = NEXT_ID++; this.parentFolder = PROJECT.rootFolder; } }
class FolderItem extends Item {}
class CompItem extends Item {
  constructor(n, w, h, pa, d, fps) {
    super(n);
    [n, w, h, pa, d, fps].forEach((v, i) => { if (i && !(v > 0)) throw new Error("addComp arg " + i + " = " + v); });
    this.width = w; this.height = h; this.duration = d; this.frameRate = fps; this.layers = new LayerCollection(this);
  }
  openInViewer() {}
}
class FootageItem extends Item {}
const PROJECT = {
  rootFolder: { id: 0 },
  items: {
    length: 0,
    _push(it) { this.length++; this[this.length] = it; return it; },
    addComp(...a) { return this._push(new CompItem(...a)); },
    addFolder(n) { return this._push(new FolderItem(n)); },
  },
  importFile(io) { if (!fs.existsSync(io.file._p)) throw new Error("import: missing " + io.file._p); return PROJECT.items._push(new FootageItem(path.basename(io.file._p))); },
  renderQueue: { items: { add(c) { return { outputModule() { return { applyTemplate() {}, file: { name: "x.mov" } }; } }; } } },
};

class File {
  constructor(p) { this._p = p; this.encoding = "BINARY"; }
  get fsName() { return this._p; }
  get name() { return path.basename(this._p); }
  get exists() { return fs.existsSync(this._p); }
  get parent() { return new Folder(path.dirname(this._p)); }
  open() { return fs.existsSync(this._p); }
  read() { if (this.encoding !== "UTF-8") throw new Error("encoding not set"); return fs.readFileSync(this._p, "utf8"); }
  close() {}
}
class Folder extends File { static selectDialog() { return null; } }
class ImportOptions { constructor(f) { this.file = f; } }

// ---------------------------------------------------------------- ScriptUI
class Ctl {
  constructor(type, a, b, c) {
    this.type = type; this.children = []; this.items = []; this._sel = null;
    if (type === "edittext" || type === "statictext" || type === "button" || type === "checkbox") this.text = b;
    if (type === "dropdownlist") (b || []).forEach((t) => this.add("item", t));
    this.value = false;
  }
  add(type, a, b, c) {
    if (type === "item") { const it = { text: a, index: this.items.length, selected: false }; this.items.push(it); return it; }
    const k = new Ctl(type, a, b, c); this.children.push(k); return k;
  }
  removeAll() { this.items = []; }
  set selection(v) {
    if (v === null) { this.items.forEach((i) => (i.selected = false)); this._sel = null; return; }
    this._sel = typeof v === "number" ? this.items[v] : v;
  }
  get selection() { return this._sel; }
  show() { return 1; } close() {} update() {}
}
class Window extends Ctl { constructor(t, title) { super("window"); } }

// ---------------------------------------------------------------- run
function run(opts) {
  let alerts = [];
  const ctx = {
    app: { project: PROJECT, newProject() {}, beginUndoGroup() {}, endUndoGroup() {} },
    $: { fileName: JSX }, File, Folder, ImportOptions, Window, Shape, KeyframeEase, FolderItem,
    PropertyValueType: PVT,
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
    ParagraphJustification: { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415 },
    LayerQuality: { BEST: 4914 }, LayerSamplingQuality: { BICUBIC: 4813 },
    alert: (m) => alerts.push(String(m)),
    JSON: undefined, // ExtendScript has no JSON -> exercise the eval fallback
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(JSX, "utf8"), ctx, { filename: "KZ_City_Maps.jsx" });
  return alerts;
}

const alerts = run();
console.log(alerts.join("\n"));
const comps = [];
for (let i = 1; i <= PROJECT.items.length; i++) if (PROJECT.items[i] instanceof CompItem) comps.push(PROJECT.items[i]);
console.log("comps:", comps.length, "props:", STATS.props, "keys:", STATS.keys, "expressions:", STATS.expressions.length);
const c0 = comps.find((c) => c.name === "KZ_Astana");
if (c0) console.log("Astana layer order:", c0.layers._list.map((l) => l.name).join(" | "));

// ---- compile + evaluate expressions with a tiny expression runtime
let exprErr = 0;
const sampleW = 180;
for (const e of STATS.expressions) {
  const env = {
    time: 0, value: e.prop === "ADBE Position_1" ? 0 : [0, 0], textIndex: 1, textTotal: 6,
    thisLayer: { sourceRectAtTime: () => ({ width: sampleW }) },
    thisComp: { layer: (n) => { if (n !== "LABEL") throw new Error("layer " + n); return { sourceRectAtTime: () => ({ width: sampleW }) }; } },
    clamp: (v, a, b) => Math.min(Math.max(v, a), b),
    createPath: (p, it, ot, cl) => ({ p, cl }),
    Math,
  };
  try {
    const body = e.src.replace(/;\s*$/, "");
    const lines = body.split("\n");
    const last = lines.pop();
    const fn = new Function(...Object.keys(env), lines.join("\n") + "\nreturn (" + last.replace(/;\s*$/, "") + ");");
    for (const t of [0, 1.3, 1.6, 3, 5.4, 5.9]) {
      env.time = t;
      const r = fn(...Object.values(env));
      if (r === undefined || (Array.isArray(r) && r.some((x) => isNaN(x)))) throw new Error("bad result " + JSON.stringify(r));
    }
  } catch (err) {
    exprErr++;
    if (exprErr < 5) console.log("EXPR FAIL", e.layer, e.prop, err.message, "\n" + e.src);
  }
}
console.log("expression failures:", exprErr);
const bad = alerts.some((a) => /Ошибки|error|Error/.test(a));
process.exit(bad || exprErr ? 1 : 0);
