/*
    KZ City Maps — сборщик анимированных мини-карт городов Казахстана для After Effects
    ---------------------------------------------------------------------------------
    Запуск:  File > Scripts > Run Script File...  >  KZ_City_Maps.jsx
    Данные:  ../output/cities/<Город>/map.json + plate.png  (генерируются tools/render.py)

    Для каждого города создаётся композиция 1920x1080:
        MAP CTRL      — null: двигайте/масштабируйте его, чтобы переставить всю карту
        PLATE GRP     — null: масштаб «подложки» (анимирован)
        LABEL         — текст (можно менять, линия-выноска подстраивается сама)
        LINE          — оранжевая выноска (draw-on)
        MARKER        — оранжевый кристалл (падение + лёгкое покачивание)
        MARKER SHADOW — тень под маркером
        MAJOR ROADS   — магистрали (draw-on, Trim Paths)
        RIVERS        — реки (draw-on, Trim Paths)
        PLATE         — бумажная подложка с улицами (PNG 2x, раскрытие маской)
        OUTER ROADS   — белые загородные дороги (draw-on от города наружу)
        GREEN SCREEN  — хромакей (опционально, можно выключить глазком)

    Совместимость: After Effects CC 2018 (15.1) и новее (нужен createPath в выражениях).
    Шрифт: Montserrat ExtraBold (лежит в папке fonts/, установите перед запуском).
*/

(function KZCityMaps() {

    var SCRIPT = "KZ City Maps";
    var GREEN = [3 / 255, 248 / 255, 11 / 255];
    var BASE_DURATION = 6.0;      // тайминги ниже рассчитаны на 6 секунд
    var MARKER_DEFAULT = [1564, 744];
    var SAFE = 56;

    // Тайминги (секунды) — совпадают с tools/render.py
    var T = {
        plate: [0.00, 0.80], outer: [0.30, 1.70], major: [0.40, 1.40], river: [0.35, 1.50],
        marker: [0.75, 1.25], line: [1.05, 1.50], text: [1.25, 0.035, 0.42],
        outText: [5.20, 0.025, 0.30], outLine: [5.30, 5.62], outMarker: [5.45, 5.72],
        outRoads: [5.35, 5.85], outPlate: [5.45, 6.00]
    };

    // Геометрия кристалла (центр = точка города)
    var GEM = { T: [0, -29], R: [17.5, -6], B: [0, 29], L: [-17.5, -6], C: [0, -6] };
    var GEM_FACETS = [
        [["T", "C", "L"], "#FFD072"],
        [["T", "R", "C"], "#F9A825"],
        [["L", "C", "B"], "#F39A1C"],
        [["C", "R", "B"], "#D9730A"]
    ];

    // ------------------------------------------------------------------ utils
    function readText(f) {
        f.encoding = "UTF-8";
        if (!f.open("r")) { throw new Error("Не удалось открыть " + f.fsName); }
        var s = f.read();
        f.close();
        return s;
    }

    function parseJSON(s) {
        if (typeof JSON !== "undefined" && JSON.parse) { return JSON.parse(s); }
        return eval("(" + s + ")"); // файлы генерирует наш же python-скрипт
    }

    function hex(h) {
        h = String(h).replace("#", "");
        return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
    }

    function num(v) { return (Math.round(v * 1000) / 1000).toString(); }

    function makeEase(n, infl) {
        var a = [];
        for (var i = 0; i < n; i++) { a.push(new KeyframeEase(0, infl)); }
        return a;
    }

    function dimsOf(prop) {
        var t = prop.propertyValueType;
        if (t === PropertyValueType.ThreeD) { return 3; }
        if (t === PropertyValueType.TwoD) { return 2; }
        return 1;
    }

    function setEase(prop, k, inInf, outInf) {
        var tries = [dimsOf(prop), 1, 2, 3];
        for (var i = 0; i < tries.length; i++) {
            try {
                prop.setTemporalEaseAtKey(k, makeEase(tries[i], inInf), makeEase(tries[i], outInf));
                return;
            } catch (e) { }
        }
    }

    // сегмент: "out" — замедление к концу, "in" — разгон, "inout" — плавно, "lin" — линейно
    function influence(seg, side) {
        if (!seg || seg === "lin") { return 33.33; }
        if (seg === "out") { return side === "start" ? 0.1 : 85; }
        if (seg === "in") { return side === "start" ? 85 : 0.1; }
        return 55;
    }

    /* keys: [[time, value, segmentTypeToNextKey], ...] */
    function animate(prop, keys) {
        var i, k, n = keys.length;
        for (i = 0; i < n; i++) { prop.setValueAtTime(keys[i][0], keys[i][1]); }
        for (i = 0; i < n; i++) {
            k = prop.nearestKeyIndex(keys[i][0]);
            var segOut = i < n - 1 ? (keys[i][2] || "inout") : null;
            var segIn = i > 0 ? (keys[i - 1][2] || "inout") : null;
            var inType = segIn === "lin" ? KeyframeInterpolationType.LINEAR : KeyframeInterpolationType.BEZIER;
            var outType = segOut === "lin" ? KeyframeInterpolationType.LINEAR : KeyframeInterpolationType.BEZIER;
            // ease first: setting temporal ease may switch a key to Bezier, so the types are applied after it
            if (inType === KeyframeInterpolationType.BEZIER || outType === KeyframeInterpolationType.BEZIER) {
                setEase(prop, k, influence(segIn, "end"), influence(segOut, "start"));
            }
            try { prop.setInterpolationTypeAtKey(k, inType, outType); } catch (e1) { }
        }
    }

    function circleShape(cx, cy, r) {
        var k = 0.5523 * r, s = new Shape();
        s.vertices = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
        s.inTangents = [[-k, 0], [0, -k], [k, 0], [0, k]];
        s.outTangents = [[k, 0], [0, k], [-k, 0], [0, -k]];
        s.closed = true;
        return s;
    }

    function rectShape(x0, y0, x1, y1) {
        var s = new Shape();
        s.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        s.closed = true;
        return s;
    }

    function tr(layer) { return layer.property("ADBE Transform Group"); }

    function setXY(prop, xy) {
        try { prop.setValue([xy[0], xy[1]]); } catch (e) { prop.setValue([xy[0], xy[1], 0]); }
    }

    function addShapeLayer(comp, name, parent) {
        var l = comp.layers.addShape();
        l.name = name;
        l.parent = parent;
        setXY(tr(l).property("ADBE Anchor Point"), [0, 0]);
        setXY(tr(l).property("ADBE Position"), [0, 0]);
        return l;
    }

    function addGroup(layer, name) {
        var root = layer.property("ADBE Root Vectors Group");
        var g = root.addProperty("ADBE Vector Group");
        g.name = name;
        return root.property(name);
    }

    function contentsOf(layer, groupName) {
        return layer.property("ADBE Root Vectors Group").property(groupName).property("ADBE Vectors Group");
    }

    function addPaths(layer, groupName, paths, closed) {
        var c = contentsOf(layer, groupName);
        for (var i = 0; i < paths.length; i++) {
            if (!paths[i] || paths[i].length < 2) { continue; }
            var sh = new Shape();
            sh.vertices = paths[i];
            sh.closed = !!closed;
            c.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(sh);
        }
    }

    function addTrim(layer, groupName, keys) {
        var c = contentsOf(layer, groupName);
        var trim = c.addProperty("ADBE Vector Filter - Trim");
        trim.name = "Trim";
        try { trim.property("ADBE Vector Trim Type").setValue(1); } catch (e) { } // одновременно
        animate(contentsOf(layer, groupName).property("Trim").property("ADBE Vector Trim End"), keys);
    }

    function addStroke(layer, groupName, name, color, width, opacity) {
        var c = contentsOf(layer, groupName);
        var s = c.addProperty("ADBE Vector Graphic - Stroke");
        s.name = name;
        s.property("ADBE Vector Stroke Color").setValue(color);
        s.property("ADBE Vector Stroke Width").setValue(width);
        s.property("ADBE Vector Stroke Opacity").setValue(opacity === undefined ? 100 : opacity);
        s.property("ADBE Vector Stroke Line Cap").setValue(2);  // round
        s.property("ADBE Vector Stroke Line Join").setValue(2); // round
    }

    function addFill(layer, groupName, color, opacity) {
        var c = contentsOf(layer, groupName);
        var f = c.addProperty("ADBE Vector Graphic - Fill");
        f.property("ADBE Vector Fill Color").setValue(color);
        f.property("ADBE Vector Fill Opacity").setValue(opacity === undefined ? 100 : opacity);
    }

    function percentProp(prop, pct) {
        // часть эффектов хранит «проценты» в диапазоне 0..255
        var max = 100;
        try { if (prop.hasMax && prop.maxValue > 100) { max = prop.maxValue; } } catch (e) { }
        prop.setValue(pct / 100 * max);
    }

    function addDropShadow(layer, color, opacityPct, direction, distance, softness) {
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        fx.property("ADBE Drop Shadow-0001").setValue(color);
        percentProp(fx.property("ADBE Drop Shadow-0002"), opacityPct);
        fx.property("ADBE Drop Shadow-0003").setValue(direction);
        fx.property("ADBE Drop Shadow-0004").setValue(distance);
        fx.property("ADBE Drop Shadow-0005").setValue(softness);
    }

    function findOrCreateFolder(name, parent) {
        var items = app.project.items;
        var pid = parent ? parent.id : app.project.rootFolder.id;
        for (var i = 1; i <= items.length; i++) {
            var it = items[i];
            if (it instanceof FolderItem && it.name === name && it.parentFolder && it.parentFolder.id === pid) { return it; }
        }
        var f = items.addFolder(name);
        if (parent) { f.parentFolder = parent; }
        return f;
    }

    // ------------------------------------------------------------------ build one city
    function buildCity(dir, opts, folders) {
        var meta = parseJSON(readText(new File(dir.fsName + "/map.json")));
        var W = meta.comp.w, H = meta.comp.h;
        var dur = opts.duration;
        var sh = dur - BASE_DURATION; // уход «прилипает» к концу композиции
        var st = meta.style;
        var lay = meta.label_layout;
        var gemScale = (st.gem_scale || 1.15) * 100;
        var label = (meta.labels && meta.labels[opts.lang]) ? meta.labels[opts.lang] : meta.label;
        var out = opts.outAnim;

        var comp = app.project.items.addComp(opts.prefix + meta.slug, W, H, 1, dur, opts.fps);
        comp.parentFolder = folders.comps;
        comp.bgColor = [0.1, 0.1, 0.1];

        // footage
        var plateFile = new File(dir.fsName + "/" + meta.plate_png.file);
        var plateItem = app.project.importFile(new ImportOptions(plateFile));
        plateItem.name = meta.slug + "_plate.png";
        plateItem.parentFolder = folders.footage;

        // background
        if (opts.green) {
            var bg = comp.layers.addSolid(GREEN, "GREEN SCREEN", W, H, 1, dur);
            bg.locked = true;
        }

        // controller null at the city point
        var ctrl = comp.layers.addNull(dur);
        ctrl.name = "MAP CTRL";
        setXY(tr(ctrl).property("ADBE Anchor Point"), [0, 0]);
        setXY(tr(ctrl).property("ADBE Position"), MARKER_DEFAULT);

        var plateGrp = comp.layers.addNull(dur);
        plateGrp.name = "PLATE GRP";
        plateGrp.parent = ctrl;
        setXY(tr(plateGrp).property("ADBE Anchor Point"), [0, 0]);
        setXY(tr(plateGrp).property("ADBE Position"), [0, 0]);
        var pgScale = [[T.plate[0], [86, 86], "out"], [T.plate[0] + 0.55, [101.5, 101.5], "inout"], [T.plate[1], [100, 100], "lin"]];
        if (out) { pgScale.push([T.outPlate[0] + sh, [100, 100], "in"]); pgScale.push([T.outPlate[1] + sh, [90, 90]]); }
        animate(tr(plateGrp).property("ADBE Scale"), pgScale);

        var roadOut = out ? [[T.outRoads[0] + sh, 100, "in"], [T.outRoads[1] + sh, 0]] : [];

        // ---- OUTER ROADS
        var outer = addShapeLayer(comp, "OUTER ROADS", ctrl);
        var groups = [["Minor", meta.paths.outer_minor, st.outer_minor], ["Major", meta.paths.outer_major, st.outer_major]];
        for (var g = 0; g < groups.length; g++) {
            if (!groups[g][1] || !groups[g][1].length) { continue; }
            addGroup(outer, groups[g][0]);
            addPaths(outer, groups[g][0], groups[g][1], false);
            addTrim(outer, groups[g][0], [[T.outer[0], 0, "inout"], [T.outer[1], 100, "lin"]].concat(roadOut));
            addStroke(outer, groups[g][0], "Stroke", hex(groups[g][2][0]), groups[g][2][1], 95);
        }
        animate(tr(outer).property("ADBE Opacity"), [[T.outer[0], 0, "lin"], [T.outer[0] + 0.15, 100]]);

        // ---- PLATE (PNG 2x)
        var plate = comp.layers.add(plateItem);
        plate.name = "PLATE";
        plate.parent = plateGrp;
        var ss = 1 / meta.plate_png.scale;
        var anchor = [-meta.plate_png.origin[0] * ss, -meta.plate_png.origin[1] * ss];
        setXY(tr(plate).property("ADBE Anchor Point"), anchor);
        setXY(tr(plate).property("ADBE Position"), [0, 0]);
        tr(plate).property("ADBE Scale").setValue([100 / ss, 100 / ss]);
        try { plate.quality = LayerQuality.BEST; } catch (e2) { }
        try { plate.samplingQuality = LayerSamplingQuality.BICUBIC; } catch (e3) { }
        var b = meta.plate_bounds;
        var rmax = Math.max(Math.sqrt(b[0] * b[0] + b[1] * b[1]), Math.sqrt(b[2] * b[2] + b[1] * b[1]),
            Math.sqrt(b[0] * b[0] + b[3] * b[3]), Math.sqrt(b[2] * b[2] + b[3] * b[3])) + 60;
        var mask = plate.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        mask.name = "Reveal";
        mask = plate.property("ADBE Mask Parade").property("Reveal");
        mask.property("ADBE Mask Feather").setValue([60 * ss, 60 * ss]);
        var mk = [[T.plate[0], circleShape(anchor[0], anchor[1], 2 * ss), "out"], [T.plate[1], circleShape(anchor[0], anchor[1], rmax * ss), "lin"]];
        if (out) { mk.push([T.outPlate[0] + sh, circleShape(anchor[0], anchor[1], rmax * ss), "in"]); mk.push([T.outPlate[1] + sh, circleShape(anchor[0], anchor[1], 2 * ss)]); }
        animate(mask.property("ADBE Mask Shape"), mk);
        var pop = [[0, 0, "lin"], [0.2, 100, "lin"]];
        if (out) { pop.push([T.outPlate[0] + 0.25 + sh, 100, "lin"]); pop.push([T.outPlate[1] + sh, 0]); }
        animate(tr(plate).property("ADBE Opacity"), pop);
        addDropShadow(plate, [20 / 255, 30 / 255, 40 / 255], 34, 160, 6 * ss, 16 * ss);

        // ---- RIVERS
        var rivers = addShapeLayer(comp, "RIVERS", plateGrp);
        var rg = [["Streams", meta.paths.stream, st.stream[0], st.stream[1], st.river_halo[1] * 0.6],
                  ["Rivers", meta.paths.river, st.river[0], st.river[1], st.river_halo[1]]];
        for (g = 0; g < rg.length; g++) {
            if (!rg[g][1] || !rg[g][1].length) { continue; }
            addGroup(rivers, rg[g][0]);
            addPaths(rivers, rg[g][0], rg[g][1], false);
            addTrim(rivers, rg[g][0], [[T.river[0], 0, "inout"], [T.river[1], 100, "lin"]].concat(roadOut));
            addStroke(rivers, rg[g][0], "Water", hex(rg[g][2]), rg[g][3], 100);
            addStroke(rivers, rg[g][0], "Halo", hex(st.river_halo[0]), rg[g][3] + 2 * rg[g][4], 90);
        }

        // ---- MAJOR ROADS
        var major = addShapeLayer(comp, "MAJOR ROADS", plateGrp);
        if (meta.paths.major && meta.paths.major.length) {
            addGroup(major, "Major");
            addPaths(major, "Major", meta.paths.major, false);
            addTrim(major, "Major", [[T.major[0], 0, "out"], [T.major[1], 100, "lin"]].concat(roadOut));
            addStroke(major, "Major", "Stroke", hex(st.major[0]), st.major[1], 100);
        }

        // ---- MARKER SHADOW
        var msh = addShapeLayer(comp, "MARKER SHADOW", ctrl);
        addGroup(msh, "Shadow");
        var ec = contentsOf(msh, "Shadow");
        ec.addProperty("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").setValue([44, 14]);
        addFill(msh, "Shadow", [0.1, 0.12, 0.2], 40);
        setXY(tr(msh).property("ADBE Position"), [0, 29 * gemScale / 100]);
        msh.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2").property("ADBE Gaussian Blur 2-0001").setValue(5);
        var mss = [[T.marker[0], [0, 0], "out"], [T.marker[0] + 0.3, [100, 100], "lin"]];
        if (out) { mss.push([T.outMarker[0] + sh, [100, 100], "in"]); mss.push([T.outMarker[1] + sh, [0, 0]]); }
        animate(tr(msh).property("ADBE Scale"), mss);

        // ---- MARKER (gem): группы выше в списке рисуются поверх, поэтому сначала обводка/блики, потом грани
        var gem = addShapeLayer(comp, "MARKER", ctrl);
        addGroup(gem, "Outline");
        addPaths(gem, "Outline", [[GEM.T, GEM.R, GEM.B, GEM.L]], true);
        addStroke(gem, "Outline", "Stroke", hex("#B85F05"), 1.0, 90);
        addGroup(gem, "Highlight");
        addPaths(gem, "Highlight", [[[-3, -22], [-12, -8]]], false);
        addStroke(gem, "Highlight", "Stroke", [1, 1, 1], 1.4, 75);
        addGroup(gem, "Edges");
        addPaths(gem, "Edges", [[GEM.L, GEM.C, GEM.R], [GEM.T, GEM.C, GEM.B]], false);
        addStroke(gem, "Edges", "Stroke", hex("#FFE3A6"), 0.9, 85);
        for (var f = 0; f < GEM_FACETS.length; f++) {
            var nm = "Facet " + (f + 1);
            addGroup(gem, nm);
            var pts = [];
            for (var q = 0; q < GEM_FACETS[f][0].length; q++) { pts.push(GEM[GEM_FACETS[f][0][q]]); }
            addPaths(gem, nm, [pts], true);
            addFill(gem, nm, hex(GEM_FACETS[f][1]), 100);
        }
        addDropShadow(gem, [0.35, 0.18, 0.0], 30, 180, 3, 8);
        tr(gem).property("ADBE Position").dimensionsSeparated = true;
        var gy = tr(gem).property("ADBE Position_1");
        animate(gy, [[T.marker[0], -95, "out"], [T.marker[0] + 0.32, 8, "inout"], [T.marker[1], 0, "lin"]]);
        gy.expression = "var T = " + num(T.marker[1]) + "; // лёгкое покачивание после приземления\nvalue + (time > T ? 2 * Math.sin((time - T) * 2.6) : 0);";
        var gs = gemScale;
        var gsk = [[T.marker[0], [gs * 0.35, gs * 0.35], "out"], [T.marker[0] + 0.17, [gs * 1.12, gs * 1.12], "inout"],
                   [T.marker[0] + 0.31, [gs, gs], "lin"]];
        if (out) {
            gsk.push([T.outMarker[0] + sh, [gs, gs], "inout"]);
            gsk.push([T.outMarker[0] + 0.07 + sh, [gs * 1.1, gs * 1.1], "in"]);
            gsk.push([T.outMarker[1] + sh, [0, 0]]);
        }
        animate(tr(gem).property("ADBE Scale"), gsk);
        animate(tr(gem).property("ADBE Opacity"), [[T.marker[0], 0, "lin"], [T.marker[0] + 0.1, 100]]);

        // ---- LABEL (text)
        var txt = comp.layers.addText(label);
        txt.name = "LABEL";
        txt.parent = ctrl;
        var tp = txt.property("ADBE Text Properties").property("ADBE Text Document");
        var td = tp.value;
        try { td.resetCharStyle(); td.resetParagraphStyle(); } catch (e5) { }
        td.text = label;
        try { td.font = opts.font; } catch (eF) { }
        td.fontSize = lay.font_size;
        td.applyFill = true;
        td.fillColor = [1, 1, 1];
        td.applyStroke = false;
        td.justification = ParagraphJustification.RIGHT_JUSTIFY;
        td.tracking = Math.round(lay.tracking / lay.font_size * 1000);
        tp.setValue(td);
        var HOLD = num(Math.min(3.0, dur / 2));
        var ex = lay.elbow[0], ey = lay.elbow[1];
        var lineEndExpr = "var w = L.sourceRectAtTime(" + HOLD + ", false).width;\n" +
            "var end = Math.max(" + num(ex + lay.text_pad_left) + " + w, " + num(lay.text_min_left) + " + w);\n";
        tr(txt).property("ADBE Position").expression =
            "var L = thisLayer;\n" + lineEndExpr + "[end, " + num(ey - lay.text_gap) + "];";
        setXY(tr(txt).property("ADBE Anchor Point"), [0, 0]);
        // clip: буквы выезжают из-под линии
        var tmask = txt.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        tmask.name = "Clip";
        txt.property("ADBE Mask Parade").property("Clip").property("ADBE Mask Shape")
            .setValue(rectShape(-4000, -400, 400, lay.text_gap - 2.5));
        // per-character slide-up via Expression Selector
        var capH = lay.font_size * 0.72;
        var anims = txt.property("ADBE Text Properties").property("ADBE Text Animators");
        var an = anims.addProperty("ADBE Text Animator");
        an.name = "SlideUp";
        var ap = anims.property("SlideUp").property("ADBE Text Animator Properties");
        ap.addProperty("ADBE Text Position 3D");
        try {
            anims.property("SlideUp").property("ADBE Text Animator Properties").property("ADBE Text Position 3D").setValue([0, capH + 14, 0]);
        } catch (e6) {
            anims.property("SlideUp").property("ADBE Text Animator Properties").property("ADBE Text Position 3D").setValue([0, capH + 14]);
        }
        anims.property("SlideUp").property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity");
        anims.property("SlideUp").property("ADBE Text Animator Properties").property("ADBE Text Opacity").setValue(0);
        var sels = anims.property("SlideUp").property("ADBE Text Selectors");
        for (var si = sels.numProperties; si >= 1; si--) {
            anims.property("SlideUp").property("ADBE Text Selectors").property(si).remove();
        }
        anims.property("SlideUp").property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
        anims.property("SlideUp").property("ADBE Text Selectors").property(1).property("ADBE Text Expressible Amount").expression =
            "var T0 = " + num(T.text[0]) + ", ST = " + num(T.text[1]) + ", D = " + num(T.text[2]) + ";\n" +
            "var O0 = " + num(T.outText[0] + sh) + ", OST = " + num(T.outText[1]) + ", OD = " + num(T.outText[2]) + ", OUT = " + (out ? "true" : "false") + ";\n" +
            "var i = textIndex - 1, n = textTotal;\n" +
            "function eo(x) { return 1 - Math.pow(1 - x, 3); }\n" +
            "function ei(x) { return x * x * x; }\n" +
            "var pi = eo(clamp((time - (T0 + i * ST)) / D, 0, 1));\n" +
            "var po = OUT ? ei(clamp((time - (O0 + (n - 1 - i) * OST)) / OD, 0, 1)) : 0;\n" +
            "var a = clamp(100 * (1 - pi) + 100 * po, 0, 100);\n" +
            "[a, a, a];";
        addDropShadow(txt, [0, 0, 0], 35, 180, 2, 5);

        // ---- LINE (leader)
        var line = addShapeLayer(comp, "LINE", ctrl);
        addGroup(line, "Leader");
        contentsOf(line, "Leader").addProperty("ADBE Vector Shape - Group");
        contentsOf(line, "Leader").property(1).property("ADBE Vector Shape").expression =
            "var L = thisComp.layer(\"LABEL\");\n" + lineEndExpr +
            "createPath([[" + num(lay.line_start[0]) + ", " + num(lay.line_start[1]) + "], [" + num(ex) + ", " + num(ey) + "], [end, " + num(ey) + "]], [], [], false);";
        var lineKeys = [[T.line[0], 0, "inout"], [T.line[1], 100, "lin"]];
        if (out) { lineKeys.push([T.outLine[0] + sh, 100, "inout"]); lineKeys.push([T.outLine[1] + sh, 0]); }
        addTrim(line, "Leader", lineKeys);
        addStroke(line, "Leader", "Stroke", hex(st.line[0]), st.line[1], 100);
        // линия под текстом
        line.moveAfter(txt);

        // ---- placement (зависит от длины надписи на выбранном языке)
        var w = 0;
        try { w = txt.sourceRectAtTime(Math.min(3.0, dur / 2), false).width; } catch (e7) { w = lay.line_end_estimate - ex - lay.text_pad_left; }
        var lineEnd = Math.max(ex + lay.text_pad_left + w, lay.text_min_left + w);
        var mx, my;
        if (opts.placement === "center") {
            mx = W / 2 - (b[0] + Math.max(b[2], lineEnd)) / 2;
            my = H / 2 - (b[1] + b[3]) / 2;
        } else {
            var right = Math.max(b[2] + 40, lineEnd);
            mx = Math.min(MARKER_DEFAULT[0], W - SAFE - right);
            mx = Math.max(mx, SAFE - b[0]);
            my = Math.min(MARKER_DEFAULT[1], H - 40 - b[3]);
            my = Math.max(my, 40 + capH - ey + lay.text_gap, 40 - b[1]);
        }
        setXY(tr(ctrl).property("ADBE Position"), [Math.round(mx), Math.round(my)]);

        // nulls on top, guides off in render
        plateGrp.moveToBeginning();
        ctrl.moveToBeginning();

        comp.comment = meta.ru + " / " + meta.kk + " — " + meta.source;
        return comp;
    }

    // ------------------------------------------------------------------ UI
    function main() {
        if (!app.project) { app.newProject(); }
        var scriptFile = new File($.fileName);
        var defDir = new Folder(scriptFile.parent.parent.fsName + "/output/cities");
        var idx = null;

        function loadIndex(folder) {
            var f = new File(folder.fsName + "/index.json");
            if (!f.exists) { return null; }
            return parseJSON(readText(f));
        }

        var dlg = new Window("dialog", SCRIPT + " — мини-карты городов Казахстана");
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];

        var gDir = dlg.add("group");
        gDir.add("statictext", undefined, "Папка cities:");
        var eDir = gDir.add("edittext", undefined, defDir.fsName);
        eDir.characters = 46;
        var bDir = gDir.add("button", undefined, "...");

        var list = dlg.add("listbox", undefined, [], { multiselect: true });
        list.preferredSize = [520, 300];

        var gSel = dlg.add("group");
        var bAll = gSel.add("button", undefined, "Выбрать все");
        var bNone = gSel.add("button", undefined, "Снять выбор");
        var bTop = gSel.add("button", undefined, "Топ-20 по населению");

        var pnl = dlg.add("panel", undefined, "Настройки");
        pnl.alignChildren = ["left", "top"];
        var g1 = pnl.add("group");
        g1.add("statictext", undefined, "Язык надписи:");
        var dLang = g1.add("dropdownlist", undefined, ["Русский", "Қазақша", "Latin"]);
        dLang.selection = 0;
        g1.add("statictext", undefined, "   Фон:");
        var dBg = g1.add("dropdownlist", undefined, ["Хромакей (зелёный)", "Прозрачный"]);
        dBg.selection = 0;
        var g2 = pnl.add("group");
        g2.add("statictext", undefined, "FPS:");
        var dFps = g2.add("dropdownlist", undefined, ["25", "30", "50", "60", "24"]);
        dFps.selection = 0;
        g2.add("statictext", undefined, "   Длительность, сек:");
        var eDur = g2.add("edittext", undefined, "6");
        eDur.characters = 4;
        g2.add("statictext", undefined, "   Положение:");
        var dPos = g2.add("dropdownlist", undefined, ["Справа снизу (как в референсе)", "По центру кадра"]);
        dPos.selection = 0;
        var g3 = pnl.add("group");
        g3.add("statictext", undefined, "Шрифт (PostScript):");
        var eFont = g3.add("edittext", undefined, "Montserrat-ExtraBold");
        eFont.characters = 22;
        g3.add("statictext", undefined, "  Префикс:");
        var ePrefix = g3.add("edittext", undefined, "KZ_");
        ePrefix.characters = 6;
        var cOut = pnl.add("checkbox", undefined, "Анимация ухода в конце (out)");
        cOut.value = true;
        var cAll = pnl.add("checkbox", undefined, "Собрать общую композицию KZ_ALL_CITIES (все города подряд)");
        cAll.value = true;
        var cRQ = pnl.add("checkbox", undefined, "Добавить в очередь рендера");
        cRQ.value = false;

        var gB = dlg.add("group");
        gB.alignment = ["right", "top"];
        gB.add("button", undefined, "Отмена", { name: "cancel" });
        var bOk = gB.add("button", undefined, "Создать", { name: "ok" });

        function fill() {
            list.removeAll();
            idx = loadIndex(new Folder(eDir.text));
            if (!idx) { list.add("item", "(не найден index.json — укажите папка output/cities)"); return; }
            for (var i = 0; i < idx.length; i++) {
                var it = list.add("item", idx[i].ru + "   (" + idx[i].slug + ", " + idx[i].population + ")");
                it.selected = true;
            }
        }
        bDir.onClick = function () {
            var f = Folder.selectDialog("Папка output/cities");
            if (f) { eDir.text = f.fsName; fill(); }
        };
        bAll.onClick = function () { for (var i = 0; i < list.items.length; i++) { list.items[i].selected = true; } };
        bNone.onClick = function () { list.selection = null; };
        bTop.onClick = function () { list.selection = null; for (var i = 0; i < Math.min(20, list.items.length); i++) { list.items[i].selected = true; } };
        fill();

        if (dlg.show() !== 1) { return; }
        if (!idx) { alert("Не найден index.json в папке:\n" + eDir.text); return; }

        var chosen = [];
        for (var i = 0; i < list.items.length; i++) { if (list.items[i].selected) { chosen.push(idx[i]); } }
        if (!chosen.length) { alert("Не выбрано ни одного города."); return; }

        var dur = parseFloat(eDur.text);
        if (!(dur > 2.5)) { dur = BASE_DURATION; }
        var opts = {
            lang: ["ru", "kk", "en"][dLang.selection.index],
            green: dBg.selection.index === 0,
            fps: parseFloat(dFps.selection.text),
            duration: dur,
            outAnim: cOut.value,
            font: eFont.text,
            prefix: ePrefix.text,
            placement: dPos.selection.index === 1 ? "center" : "corner"
        };

        var rqFolder = null;
        if (cRQ.value) { rqFolder = Folder.selectDialog("Куда рендерить видео?"); }

        app.beginUndoGroup(SCRIPT);
        var root = findOrCreateFolder("KZ City Maps", null);
        var folders = { comps: findOrCreateFolder("Comps", root), footage: findOrCreateFolder("Footage", root) };

        var pw = new Window("palette", SCRIPT);
        var pb = pw.add("progressbar", undefined, 0, chosen.length);
        pb.preferredSize = [420, 14];
        var ps = pw.add("statictext", undefined, "");
        ps.preferredSize = [420, 20];
        pw.show();

        var comps = [], errors = [];
        for (i = 0; i < chosen.length; i++) {
            ps.text = (i + 1) + " / " + chosen.length + "  " + chosen[i].ru;
            pb.value = i;
            pw.update();
            try {
                var comp = buildCity(new Folder(eDir.text + "/" + chosen[i].slug), opts, folders);
                comps.push(comp);
                if (rqFolder) {
                    var rqi = app.project.renderQueue.items.add(comp);
                    var om = rqi.outputModule(1);
                    if (!opts.green) {
                        try { om.applyTemplate("High Quality with Alpha"); } catch (e1) { try { om.applyTemplate("Lossless with Alpha"); } catch (e2) { } }
                    }
                    try {
                        var cur = om.file ? om.file.name : "";
                        var ext = cur.lastIndexOf(".") > 0 ? cur.substr(cur.lastIndexOf(".")) : ".mov";
                        om.file = new File(rqFolder.fsName + "/" + comp.name + ext);
                    } catch (e3) { }
                }
            } catch (err) {
                errors.push(chosen[i].ru + ": " + err.toString() + (err.line ? " (line " + err.line + ")" : ""));
            }
        }

        if (cAll.value && comps.length > 1) {
            var all = app.project.items.addComp(opts.prefix + "ALL_CITIES", comps[0].width, comps[0].height, 1,
                opts.duration * comps.length, opts.fps);
            all.parentFolder = root;
            for (i = comps.length - 1; i >= 0; i--) {
                var l = all.layers.add(comps[i]);
                l.startTime = i * opts.duration;
            }
        }
        pw.close();
        app.endUndoGroup();

        var msg = "Готово: создано композиций — " + comps.length + ".";
        if (errors.length) { msg += "\n\nОшибки (" + errors.length + "):\n" + errors.join("\n"); }
        alert(msg, SCRIPT);
        if (comps.length) { try { comps[0].openInViewer(); } catch (e9) { } }
    }

    try { main(); } catch (e) { alert(SCRIPT + ": " + e.toString() + (e.line ? " (line " + e.line + ")" : "")); }
})();
