// Web map editor (#1280). Flat editing only; every game rule (entrances,
// stronghold, connection, spawn analysis, file format) comes from the WASM
// bridge, which is the game's own maze3-map crate.
import { loadBridge } from "./bridge.js?v=69290bf5";
import * as store from "./store.js?v=69290bf5";
import { bounds, contains, constrain, line, shapeCells, capture, transfer, regionSelection, offsetCells, extendSelection } from "./drawing.js?v=69290bf5";
import { sightKey, sightPreview, sightLabel, roundSightLabel } from "./sight.js?v=69290bf5";
import { resizeMap, resizeOffset } from "./resize.js?v=69290bf5";
import { FULL, NAMES, TerrainLayer, category, heightOf, isRamp, kindOf, regions, thumbnail } from "./render.js?v=69290bf5";

const $ = (s, root = document) => root.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

const B = await loadBridge(await fetch(new URL("../map.wasm?v=69290bf5", import.meta.url)).then((r) => r.arrayBuffer()));
const C = B.config();
for (const [name, [r, g, b, a]] of Object.entries(C.colors)) {
  document.documentElement.style.setProperty(`--t-${name.replaceAll(".", "-").replaceAll("_", "-")}`, `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`);
}
const PLAN = C.plan;
const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const GAME_FOLDER = "%APPDATA%\\maze3\\saves\\map-editor\\maps";

// Palette order and keys follow the game editor (workbench.rs `palette`).
const TERRAIN = [
  { id: "low", name: "평지", code: 0 },
  { id: "high", name: "언덕", code: 1 << 3 },
  { id: "ramp", name: "입구" },
  { id: "ledge", name: "평평한 산", code: 1 },
  { id: "mountain", name: "험한 산", code: 2 },
  { id: "water", name: "물", code: 4 },
  { id: "lava", name: "용암", code: 5 },
  { id: "void", name: "심연", code: 3 },
  { id: "rock", name: "바위", code: 6 },
];
const MODES = [
  { id: "brush", name: "브러시", key: "B" },
  { id: "line", name: "직선", key: "L" },
  { id: "rect", name: "사각형", key: "R" },
  { id: "ellipse", name: "원·타원", key: "O" },
  { id: "select", name: "선택", key: "M" },
  { id: "fill", name: "채우기", key: "G" },
  { id: "picker", name: "스포이트", key: "I" },
];
const ROLES = [
  "통행 · 건설",
  "높은 땅 · 통행 · 건설",
  "높이 사이 통로",
  "통행 불가 · 포탑 자리",
  "통행 불가 · 건설 불가",
  "일반 경로 제외 · 밀리면 즉사 · 건설 불가",
  "일반 경로 제외 · 밀리면 즉사 · 건설 불가",
  "일반 경로 제외 · 밀리면 즉사 · 건설 불가",
  "통행 불가 · 파괴 가능 · 직접 포탑 받침 불가",
];
function tileName(code) {
  if (kindOf(code) === 0 && !isRamp(code) && heightOf(code) > 1) return "이전 초안의 땅";
  return FULL[category(code)];
}

const S = {
  doc: null,
  saved: null,
  dirty: false,
  tool: "low",
  mode: "brush",
  prevMode: "brush",
  brush: 1,
  filled: true,
  thickness: 1,
  shift: false,
  lastPaint: null,
  selection: null,
  floating: null,
  clipboard: null,
  selectKind: "box",
  offset: { amount: 1, outward: false },
  offsetPreview: false,
  offsetValid: true,
  thicknessValid: true,
  undo: [],
  redo: [],
  stroke: null,
  anchor: null,
  press: null,
  hover: null,
  hoverRamp: null,
  hoverBase: null,
  view: { s: 16, ox: 0, oy: 0 },
  marks: true,
  check: null,
  labels: [],
  revision: 0,
  analysis: { report: null, revision: -1, job: 0, running: false, error: "", round: 0, routes: true, sight: true, sightKey: null },
  pane: null,
  resize: { w: 32, h: 32, anchor: 4, mode: "extent", error: "" },
  message: "",
  keys: new Set(),
};

const layer = new TerrainLayer(PLAN);
const canvas = $("#view");
const ctx = canvas.getContext("2d");
const stage = $("#stage");

// ---------------------------------------------------------------- documents
const cloneDoc = (d) => ({ ...d, codes: d.codes.slice(), base: d.base ? [...d.base] : null, battle: d.battle ? { ...d.battle } : null });
const sameTerrain = (a, b) =>
  a.width === b.width && a.height === b.height && a.landscape === b.landscape &&
  String(a.base) === String(b.base) && a.codes.length === b.codes.length && a.codes.every((c, i) => c === b.codes[i]);
const sameBattle = (a, b) => JSON.stringify(a.battle ?? null) === JSON.stringify(b.battle ?? null);
const index = (x, y) => y * S.doc.width + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < S.doc.width && y < S.doc.height;

function blank(name, width, height, landscape) {
  return {
    id: crypto.randomUUID(), name, generation: 1, terrain_revision: 1, collection: "Custom", battle: null,
    width, height, landscape, codes: new Uint8Array(width * height), base: null,
  };
}

function open(doc, saved) {
  S.doc = cloneDoc(doc);
  S.saved = saved ? cloneDoc(saved) : null;
  S.undo = []; S.redo = [];
  S.stroke = null; S.anchor = null; S.selection = null; S.floating = null; S.lastPaint = null;
  S.analysis = { ...S.analysis, report: null, revision: -1, running: false, error: "", round: 0 };
  S.pane = null;
  layer.reset(S.doc);
  $("#app").hidden = false;
  fit();
  touch(false);
  updateDirty();
}

// ---------------------------------------------------------------- changes
let checkQueued = false, workTimer = 0;
function touch(changed = true, rebuildPane = true) {
  S.revision++;
  if (changed) {
    updateDirty();
    clearTimeout(workTimer);
    workTimer = setTimeout(saveWork, 800);
  }
  if (!checkQueued) {
    checkQueued = true;
    requestAnimationFrame(runCheck);
  }
  S.hoverRamp = null; S.hoverBase = null;
  refresh(rebuildPane);
  if (S.pane === "size" && rebuildPane) renderSize();
}
function updateDirty() {
  const d = S.doc, s = S.saved;
  S.dirty = !s || d.name !== s.name || !sameTerrain(d, s) || !sameBattle(d, s);
  $("#dirty").hidden = !S.dirty;
  $("#map-name").textContent = d.name;
}
function saveWork() {
  if (!S.doc) return;
  const ok = !S.dirty || store.saveWork({ doc: S.doc, savedId: S.saved?.id ?? null, at: Date.now() });
  $("#recovery").textContent = !S.dirty ? "" : ok ? "임시 보관됨" : "임시 보관 실패";
  $("#recovery").classList.toggle("bad", !ok);
}
function runCheck() {
  checkQueued = false;
  if (!S.doc) return;
  const old = layer.slopes, oldBad = layer.invalid;
  try {
    S.check = B.check(store.wire(S.doc));
  } catch (e) {
    S.check = { issues: [String(e.message)], summary: String(e.message), entries: [], disconnected: [], route: [], invalid: [], ramps: [] };
  }
  layer.setShapes(S.check.ramps, S.check.invalid);
  const repaint = new Set([...old.keys(), ...oldBad, ...layer.slopes.keys(), ...layer.invalid]);
  layer.paint(repaint);
  S.labels = regions(S.doc);
  const el = $("#check");
  el.textContent = S.check.summary;
  el.className = "check " + (S.check.issues.length ? "bad" : "ok");
  draw();
}

function pushEdit(edit) {
  if (!edit) return;
  S.undo.push(edit);
  if (S.undo.length > 400) S.undo.shift();
  S.redo = [];
  touch();
}
function tilesEdit(before) {
  const idx = [], a = [], b = [];
  for (const [i, old] of before) if (S.doc.codes[i] !== old) { idx.push(i); a.push(old); b.push(S.doc.codes[i]); }
  return idx.length ? { type: "tiles", idx, a, b } : null;
}
const snapshot = () => ({ width: S.doc.width, height: S.doc.height, landscape: S.doc.landscape, codes: S.doc.codes.slice(), base: S.doc.base ? [...S.doc.base] : null });
function apply(edit, forward) {
  if (edit.type === "tiles") {
    const v = forward ? edit.b : edit.a;
    edit.idx.forEach((i, k) => (S.doc.codes[i] = v[k]));
    layer.paint(edit.idx);
  } else if (edit.type === "base") {
    S.doc.base = forward ? edit.b : edit.a;
  } else {
    const snap = forward ? edit.b : edit.a;
    const resized = snap.width !== S.doc.width || snap.height !== S.doc.height;
    Object.assign(S.doc, { ...snap, codes: snap.codes.slice(), base: snap.base ? [...snap.base] : null });
    layer.reset(S.doc);
    if (resized) fit();
  }
}
function undo() {
  cancel();
  const e = S.undo.pop();
  if (!e) return say("되돌릴 작업이 없습니다.");
  apply(e, false); S.redo.push(e); touch();
}
function redo() {
  cancel();
  const e = S.redo.pop();
  if (!e) return say("다시 할 작업이 없습니다.");
  apply(e, true); S.undo.push(e); touch();
}

// ---------------------------------------------------------------- painting
const terrainTool = () => TERRAIN.find((t) => t.id === S.tool);
function footprint(x, y, size) {
  const r = Math.floor(size / 2), cells = [];
  for (let cy = Math.max(0, y - r); cy <= Math.min(S.doc.height - 1, y + Math.floor((size - 1) / 2)); cy++)
    for (let cx = Math.max(0, x - r); cx <= Math.min(S.doc.width - 1, x + Math.floor((size - 1) / 2)); cx++) cells.push([cx, cy]);
  return cells;
}
const shapeMode = () => ["line", "rect", "ellipse"].includes(S.mode);
function shapeEnd() {
  const end = S.hover ?? S.anchor;
  return S.shift ? constrain(S.anchor, end, S.mode !== "line" && !S.lineGesture) : end;
}
function gestureCells() {
  if (!S.anchor) return [];
  if (!S.filled && !S.thicknessValid && ["rect", "ellipse"].includes(S.mode)) return [];
  const end = shapeEnd();
  if (S.mode === "line" || S.lineGesture) {
    const cells = new Map();
    for (const p of line(S.anchor, end)) for (const c of footprint(...p, S.brush)) cells.set(String(c), c);
    return [...cells.values()];
  }
  return shapeCells(S.mode, S.anchor, end, S.filled, S.thickness).filter((p) => inside(...p));
}
function flood([sx, sy]) {
  const start = index(sx, sy), code = S.doc.codes[start], seen = new Set([start]), stack = [start], out = [];
  while (stack.length) {
    const i = stack.pop(), x = i % S.doc.width, y = (i / S.doc.width) | 0;
    out.push([x, y]);
    for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
      if (!inside(nx, ny)) continue;
      const j = index(nx, ny);
      if (!seen.has(j) && S.doc.codes[j] === code) { seen.add(j); stack.push(j); }
    }
  }
  return out;
}
/** Paint `cells` into `before` (one stroke/area = one undo), like Draft::paint. */
function paintCells(cells, before) {
  const t = terrainTool();
  let todo = cells.filter(([x, y]) => inside(x, y) && !before.has(index(x, y)));
  if (!todo.length) return;
  if (t.id === "ramp") {
    const ok = B.ramp(store.wire(S.doc), todo);
    if (!ok.length) say("입구 불가: 평지와 언덕에 이어져야 합니다.");
    todo = ok;
  }
  const changed = [];
  for (const [x, y] of todo) {
    const i = index(x, y), old = S.doc.codes[i];
    before.set(i, old);
    S.doc.codes[i] = t.id === "ramp" ? old | 128 : t.code;
    if (S.doc.codes[i] !== old) changed.push(i);
  }
  if (changed.length) {
    layer.paint(changed);
    S.message = "";
    S.revision++;
    if (!checkQueued) { checkQueued = true; requestAnimationFrame(runCheck); }
    draw();
  }
}
function cancel() {
  if (S.stroke) {
    for (const [i, old] of S.stroke.before) S.doc.codes[i] = old;
    layer.paint([...S.stroke.before.keys()]);
    S.stroke = null;
    touch(false);
  }
  S.anchor = null; S.press = null; S.lineGesture = false;
  S.selection = null; S.floating = null; S.offsetPreview = false;
  S.message = "";
  draw();
}
function copySelection() {
  if (!S.selection) return say("먼저 지형을 선택하세요.");
  S.clipboard = capture(S.doc, S.selection);
  say(`${S.selection.w} × ${S.selection.h} 지형 복사됨 · Ctrl+V 붙여넣기`);
  refresh();
}
function pasteSelection() {
  if (!S.clipboard) return say("복사한 지형이 없습니다.");
  if (S.clipboard.w > S.doc.width || S.clipboard.h > S.doc.height) return say("맵보다 큰 선택 영역은 붙여넣을 수 없습니다.");
  cancel();
  S.mode = "select"; if (S.tool === "base") S.tool = "low";
  const p = S.hover ?? [Math.floor(S.doc.width / 2), Math.floor(S.doc.height / 2)];
  S.floating = { payload: S.clipboard, to: { x: p[0], y: p[1] }, from: null, grab: [0, 0], paste: true };
  say("붙여넣을 곳 클릭 · Esc 취소"); refresh();
}
function dropSelection() {
  const f = S.floating;
  const codes = transfer(S.doc, f.payload, f.to, f.from);
  if (!codes) { say("맵 밖으로 선택 영역이 잘립니다. 안쪽에 놓으세요."); return false; }
  const before = new Map();
  codes.forEach((code, i) => { if (code !== S.doc.codes[i]) { before.set(i, S.doc.codes[i]); S.doc.codes[i] = code; } });
  layer.paint(before.keys());
  S.selection = { ...f.to, w: f.payload.w, h: f.payload.h, mask: f.payload.mask?.slice() };
  S.floating = null;
  pushEdit(tilesEdit(before));
  S.message = ""; refresh();
  return true;
}
let offsetCache = null;
function offsetPreviewCells() {
  if (!S.selection) return [];
  if (!offsetCache || offsetCache.selection !== S.selection || offsetCache.amount !== S.offset.amount || offsetCache.outward !== S.offset.outward)
    offsetCache = { selection: S.selection, ...S.offset, cells: offsetCells(S.doc, S.selection, S.offset.amount, S.offset.outward) };
  return offsetCache.cells;
}
function applyOffset() {
  if (!S.selection || S.floating || !S.offsetValid) return;
  const before = new Map();
  const cells = offsetPreviewCells();
  for (const [x, y] of cells) {
    const i = index(x, y);
    if (S.doc.codes[i] !== 1) { before.set(i, S.doc.codes[i]); S.doc.codes[i] = 1; }
  }
  layer.paint(before.keys());
  pushEdit(tilesEdit(before));
  if (S.offset.outward) S.selection = extendSelection(S.selection, cells);
  S.offsetPreview = false;
  say(`평평한 산 ${before.size}칸 적용됨 · Ctrl+Z 되돌리기`); refresh();
}
function placeBase([x, y]) {
  const reason = B.base(store.wire(S.doc), [x, y]);
  if (reason) return say(reason);
  const a = S.doc.base, b = [x, y];
  if (String(a) === String(b)) return;
  S.doc.base = b;
  pushEdit({ type: "base", a, b });
}
function removeBase() {
  if (!S.doc.base) return;
  const a = S.doc.base;
  S.doc.base = null;
  pushEdit({ type: "base", a, b: null });
}

// ---------------------------------------------------------------- view
function fit() {
  const r = stage.getBoundingClientRect();
  const s = Math.max(1, Math.min((r.width - 48) / S.doc.width, (r.height - 48) / S.doc.height));
  S.view = { s, ox: (r.width - S.doc.width * s) / 2, oy: (r.height - S.doc.height * s) / 2 };
  draw();
}
function zoomAt(mx, my, factor) {
  const v = S.view, s = Math.max(1, Math.min(96, v.s * factor));
  v.ox = mx - ((mx - v.ox) * s) / v.s;
  v.oy = my - ((my - v.oy) * s) / v.s;
  v.s = s;
  draw();
}
const cellAt = (mx, my) => [Math.floor((mx - S.view.ox) / S.view.s), Math.floor((my - S.view.oy) / S.view.s)];

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; paintView(); });
}
function paintView() {
  if (!S.doc) return;
  const dpr = devicePixelRatio, W = stage.clientWidth, H = stage.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const { s, ox, oy } = S.view, { width: w, height: hgt } = S.doc;
  const X = (x) => ox + x * s, Y = (y) => oy + y * s;
  const showSpawn = S.pane === "spawn" && S.analysis.report;

  if (showSpawn) {
    const b = C.profile_ingress ?? 0;
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fillRect(X(-b), Y(-b), (w + 2 * b) * s, (hgt + 2 * b) * s);
  }
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(X(0) - 1, Y(0) - 1, w * s + 2, hgt * s + 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer.canvas, X(0), Y(0), w * s, hgt * s);

  // Grid: always on in flat editing, faded out when cells get tiny.
  if (s >= 5) {
    ctx.strokeStyle = `rgba(0,0,0,${PLAN.grid_alpha * Math.min(1, (s - 5) / 6)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(-ox / s)), x1 = Math.min(w, Math.ceil((W - ox) / s));
    const y0 = Math.max(0, Math.floor(-oy / s)), y1 = Math.min(hgt, Math.ceil((H - oy) / s));
    for (let x = x0; x <= x1; x++) { ctx.moveTo(Math.round(X(x)) + 0.5, Y(y0)); ctx.lineTo(Math.round(X(x)) + 0.5, Y(y1)); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(X(x0), Math.round(Y(y)) + 0.5); ctx.lineTo(X(x1), Math.round(Y(y)) + 0.5); }
    ctx.stroke();
  }

  // Region names: one per connected area that is big enough to read.
  ctx.font = "500 12px 'Noto Sans KR', sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const r of S.labels) {
    if (r.size * s * s < 2400 || s < 6) continue;
    const tx = X(r.x + 0.5), ty = Y(r.y + 0.5);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const tw = ctx.measureText(NAMES[r.cat]).width + 10;
    ctx.fillRect(tx - tw / 2, ty - 9, tw, 18);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(NAMES[r.cat], tx, ty + 0.5);
  }

  if (S.pane === "size") drawResize(X, Y);
  if (showSpawn) { drawSight(X, Y); drawSpawn(X, Y); }
  if (S.marks && S.check) drawMarks(X, Y);
  drawHover(X, Y);
}

function dots(cells, color, X, Y, size) {
  const s = S.view.s, d = Math.max(2, s * size);
  ctx.fillStyle = color;
  for (const [x, y] of cells) ctx.fillRect(X(x + 0.5) - d / 2, Y(y + 0.5) - d / 2, d, d);
}
/** Edge cells as a strip just outside the map border, so the land stays readable. */
function edgeStrip(cells, color, X, Y) {
  const s = S.view.s, t = Math.max(3, Math.min(8, s * 0.35)), { width: w, height: hgt } = S.doc;
  ctx.fillStyle = color;
  for (const [x, y] of cells) {
    if (y === 0) ctx.fillRect(X(x) + 1, Y(0) - t - 1, s - 2, t);
    if (y === hgt - 1) ctx.fillRect(X(x) + 1, Y(hgt) + 1, s - 2, t);
    if (x === 0) ctx.fillRect(X(0) - t - 1, Y(y) + 1, t, s - 2);
    if (x === w - 1) ctx.fillRect(X(w) + 1, Y(y) + 1, t, s - 2);
  }
}
function drawMarks(X, Y) {
  const s = S.view.s;
  edgeStrip(S.check.entries, rgb(PLAN.entry), X, Y);
  edgeStrip(S.check.disconnected, rgb(PLAN.invalid), X, Y);
  if (S.pane !== "spawn") dots(S.check.route, rgb(PLAN.route), X, Y, 0.22);
  if (S.doc.base) {
    const [bx, by] = S.doc.base;
    ctx.strokeStyle = rgb(PLAN.base, 0.7);
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(X(bx - 2), Y(by - 2), 5 * s, 5 * s);
    ctx.setLineDash([]); ctx.lineWidth = 2.5;
    ctx.strokeStyle = rgb(PLAN.base);
    ctx.fillStyle = rgb(PLAN.base, 0.22);
    ctx.fillRect(X(bx - 1), Y(by - 1), 3 * s, 3 * s);
    ctx.strokeRect(X(bx - 1), Y(by - 1), 3 * s, 3 * s);
    ctx.fillStyle = rgb(PLAN.base);
    ctx.font = `700 ${Math.max(11, s * 1.6)}px 'Noto Sans KR', sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("H", X(bx + 0.5), Y(by + 0.55));
  }
}
function drawSpawn(X, Y) {
  const a = S.analysis, r = a.report.rounds[a.round];
  if (!r) return;
  const stale = a.revision !== S.revision, s = S.view.s;
  ctx.globalAlpha = stale ? 0.4 : 1;
  ctx.fillStyle = "rgba(245, 207, 90, 0.55)";
  const d = Math.max(2, s * 0.8);
  for (const [x, y] of r.candidates) ctx.fillRect(X(x) - d / 2, Y(y) - d / 2, d, d);
  if (a.routes && r.routes.length) {
    ctx.strokeStyle = rgb(PLAN.route);
    ctx.lineWidth = Math.max(2, Math.min(6, s * 0.28));
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    for (const path of r.routes) path.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();
    ctx.fillStyle = rgb(PLAN.route);
    for (const path of r.routes) arrow(path, X, Y);
  }
  ctx.globalAlpha = 1;
}
function drawSight(X, Y) {
  if (!S.analysis.sight) return;
  const preview = sightPreview(S.doc, S.analysis);
  if (!preview) return;
  const s = S.view.s, { width: w, height: h } = S.doc;
  const [bx, by] = preview.base, radius = preview.radius;
  ctx.save();
  ctx.beginPath(); ctx.rect(X(0), Y(0), w * s, h * s); ctx.clip();
  const accent = C.colors["text.accent"] ?? [0.68, 0.72, 1, 1];
  ctx.strokeStyle = `rgba(${accent.slice(0, 3).map((c) => c * 255).join(",")},1)`;
  ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  if (radius == null) ctx.strokeRect(X(0) + 1, Y(0) + 1, w * s - 2, h * s - 2);
  else {
    ctx.beginPath(); ctx.rect(X(0), Y(0), w * s, h * s);
    ctx.moveTo(X(bx + radius), Y(by)); ctx.arc(X(bx), Y(by), radius * s, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.44)"; ctx.fill("evenodd");
    ctx.beginPath(); ctx.arc(X(bx), Y(by), radius * s, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
/** One large arrow per route, a third of the way from its spawn, pointing at the base. */
function arrow(path, X, Y) {
  if (path.length < 2) return;
  const k = Math.min(path.length - 2, Math.max(0, Math.floor(path.length / 3)));
  const [x0, y0] = path[k], [x1, y1] = path[Math.min(path.length - 1, k + 2)];
  const ang = Math.atan2(Y(y1) - Y(y0), X(x1) - X(x0));
  const size = Math.max(9, Math.min(22, S.view.s * 1.1));
  ctx.save();
  ctx.translate(X(x0), Y(y0));
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(size, 0); ctx.lineTo(-size * 0.6, size * 0.7); ctx.lineTo(-size * 0.25, 0); ctx.lineTo(-size * 0.6, -size * 0.7);
  ctx.closePath();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1.5;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
function drawResize(X, Y) {
  const r = S.resize;
  if (r.mode !== "extent" || !valid(r.w) || !valid(r.h)) return;
  const [dx, dy] = resizeOffset(S.doc, r.w, r.h, r.anchor), s = S.view.s, { width: w, height: hgt } = S.doc;
  // New bounds in old coordinates.
  const nx0 = -dx, ny0 = -dy, nx1 = nx0 + r.w, ny1 = ny0 + r.h;
  ctx.fillStyle = "rgba(255, 75, 58, 0.45)";
  for (let y = 0; y < hgt; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const cut = x < w && (x < nx0 || x >= nx1 || y < ny0 || y >= ny1);
      if (cut && run < 0) run = x;
      if (!cut && run >= 0) { ctx.fillRect(X(run), Y(y), (x - run) * s, s); run = -1; }
    }
  }
  ctx.fillStyle = "rgba(90, 160, 255, 0.28)";
  ctx.fillRect(X(nx0), Y(ny0), r.w * s, r.h * s);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.strokeStyle = "rgba(120, 180, 255, 0.95)"; ctx.lineWidth = 2;
  ctx.strokeRect(X(nx0), Y(ny0), r.w * s, r.h * s);
  // Re-draw the kept old terrain on top so only added land reads blue.
  const kx0 = Math.max(0, nx0), ky0 = Math.max(0, ny0), kx1 = Math.min(w, nx1), ky1 = Math.min(hgt, ny1);
  if (kx1 > kx0 && ky1 > ky0) {
    const p = layer.px;
    ctx.drawImage(layer.canvas, kx0 * p, ky0 * p, (kx1 - kx0) * p, (ky1 - ky0) * p, X(kx0), Y(ky0), (kx1 - kx0) * s, (ky1 - ky0) * s);
  }
}
function drawHover(X, Y) {
  const s = S.view.s;
  if (S.mode === "select") {
    const f = S.floating;
    const r = f ? { ...f.to, w: f.payload.w, h: f.payload.h, mask: f.payload.mask } : S.anchor && S.hover ? bounds(S.anchor, S.hover) : S.selection;
    if (!r) return;
    const valid = !f || (r.x >= 0 && r.y >= 0 && r.x + r.w <= S.doc.width && r.y + r.h <= S.doc.height);
    if (f) {
      if (!f.image) {
        const ghost = new TerrainLayer(PLAN); ghost.reset({ width: r.w, height: r.h, codes: f.payload.codes });
        if (f.payload.mask) for (let i = 0; i < f.payload.mask.length; i++) if (!f.payload.mask[i]) ghost.ctx.clearRect((i % r.w) * ghost.px, Math.floor(i / r.w) * ghost.px, ghost.px, ghost.px);
        f.image = ghost.canvas;
      }
      if (f.from) {
        ctx.fillStyle = rgb(PLAN.categories[0]);
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (!f.payload.mask || f.payload.mask[y * r.w + x]) ctx.fillRect(X(f.from.x + x), Y(f.from.y + y), s, s);
      }
      ctx.globalAlpha = 0.8;
      ctx.drawImage(f.image, X(r.x), Y(r.y), r.w * s, r.h * s);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = valid ? "rgba(173,184,255,0.10)" : "rgba(255,75,58,0.35)";
    if (!r.mask) ctx.fillRect(X(r.x), Y(r.y), r.w * s, r.h * s);
    else for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) ctx.fillRect(X(r.x + i % r.w), Y(r.y + Math.floor(i / r.w)), s, s);
    ctx.strokeStyle = valid ? "#adb8ff" : "#ff5a72"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(X(r.x) + 1, Y(r.y) + 1, r.w * s - 2, r.h * s - 2); ctx.setLineDash([]);
    if (S.offsetPreview && S.selection && !f) {
      ctx.fillStyle = "rgba(255,200,100,0.65)";
      for (const [x, y] of offsetPreviewCells()) ctx.fillRect(X(x), Y(y), s, s);
    }
    return;
  }
  const outline = (cells, ok) => {
    for (const [x, y] of cells) {
      ctx.fillStyle = ok(x, y) ? "rgba(61, 255, 162, 0.28)" : "rgba(255, 75, 58, 0.4)";
      ctx.fillRect(X(x), Y(y), s, s);
    }
  };
  if (S.tool === "base" && S.hover) {
    const [x, y] = S.hover;
    if (S.hoverBase === null) S.hoverBase = { at: `${x},${y}`, reason: B.base(store.wire(S.doc), [x, y]) };
    const okBase = !S.hoverBase.reason;
    const cells = [];
    for (let cy = y - 2; cy <= y + 2; cy++) for (let cx = x - 2; cx <= x + 2; cx++) if (inside(cx, cy)) cells.push([cx, cy]);
    outline(cells, () => okBase);
    return;
  }
  let cells = null;
  if (S.anchor && S.hover) cells = gestureCells();
  else if (S.hover && S.mode === "brush" && !S.stroke) cells = footprint(S.hover[0], S.hover[1], S.brush);
  if (cells) {
    let ok = () => true;
    if (S.tool === "ramp") {
      const key = `${S.revision}:${S.mode}:${S.filled}:${S.thickness}:${S.brush}:${S.shift}:${S.anchor}:${S.hover}`;
      if (!S.hoverRamp || S.hoverRamp.key !== key) S.hoverRamp = { key, ok: new Set(B.ramp(store.wire(S.doc), cells).map(String)) };
      const set = S.hoverRamp.ok;
      ok = (x, y) => set.has(`${x},${y}`);
    }
    outline(cells, ok);
  } else if (S.hover && inside(...S.hover) && S.mode !== "brush") {
    ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 2;
    ctx.strokeRect(X(S.hover[0]), Y(S.hover[1]), s, s);
  }
}

// ---------------------------------------------------------------- status
function say(text) {
  S.message = text;
  status();
}
function status() {
  const el = $("#status");
  let text = S.message;
  if (!text && S.mode === "select") {
    const r = S.selection;
    text = S.floating ? "놓으면 덮어쓰기 · Esc 취소" : S.offsetPreview ? `금색 띠를 평평한 산으로 덮어쓰기 · ${S.offset.outward ? "바깥" : "안쪽"} ${S.offset.amount}칸 · 띠 적용 / Esc 취소` : r ? `${r.w} × ${r.h} 선택 · 드래그로 이동 · Ctrl+C / Ctrl+V · Esc 해제` : S.selectKind === "region" ? "같은 지형 덩어리 클릭 · 드래그로 이동" : "드래그로 지형 선택 · Ctrl+V 붙여넣기";
  }
  if (!text && S.anchor && S.hover) {
    const r = bounds(S.anchor, shapeEnd());
    text = `${r.w} × ${r.h} · 끝점 클릭 / 드래그 · Shift ${S.mode === "line" || S.lineGesture ? "방향 고정" : "정비율"} · Esc 취소`;
  } else if (!text && S.hover && S.doc && inside(...S.hover)) {
    const [x, y] = S.hover, code = S.doc.codes[index(x, y)];
    text = `${x}, ${y} · ${tileName(code)} · ${ROLES[category(code)]}`;
    if (S.tool === "base" && S.hoverBase?.reason) text += ` · ${S.hoverBase.reason}`;
  }
  el.textContent = text || "두 점 클릭 / 드래그 · 직선 L · 선택 M · Shift+클릭 직선 연결";
  el.classList.toggle("bad", !!S.message && /불가|없|않|실패|잘립|올바르지/.test(S.message));
}

// ---------------------------------------------------------------- input
stage.addEventListener("contextmenu", (e) => e.preventDefault());
let pan = null;
stage.addEventListener("pointerdown", (e) => {
  if (!S.doc) return;
  stage.setPointerCapture(e.pointerId);
  const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.button === 2 && (S.stroke || S.anchor || S.floating)) return cancel();
  if (e.button === 1 || e.button === 2 || (e.button === 0 && S.keys.has(" "))) {
    pan = { mx, my, ox: S.view.ox, oy: S.view.oy };
    stage.classList.add("pan");
    return;
  }
  if (e.button !== 0) return;
  const c = cellAt(mx, my);
  if (!inside(...c)) return;
  S.hover = c; S.shift = e.shiftKey;
  S.message = "";
  if (S.mode === "select") {
    if (S.floating?.paste) return dropSelection();
    S.offsetPreview = false;
    if (contains(S.selection, c)) {
      const r = S.selection;
      S.floating = { payload: capture(S.doc, r), from: { x: r.x, y: r.y }, to: { x: r.x, y: r.y }, grab: [c[0] - r.x, c[1] - r.y] };
    } else if (S.selectKind === "region") S.selection = regionSelection(S.doc, c);
    else { S.selection = null; S.anchor = c; S.press = c; S.dragged = false; }
    return refresh();
  }
  if (S.tool === "base") return placeBase(c);
  if (S.mode === "picker") {
    const code = S.doc.codes[index(...c)], cat = category(code);
    S.tool = TERRAIN[[0, 1, 2, 3, 4, 7, 5, 6, 8][cat]].id;
    S.mode = S.prevMode;
    refresh();
    return;
  }
  if (S.mode === "fill") {
    const before = new Map();
    paintCells(flood(c), before);
    return pushEdit(tilesEdit(before));
  }
  if (shapeMode() || (S.mode === "brush" && e.shiftKey)) {
    S.secondPoint = !!S.anchor;
    S.press = c; S.dragged = false;
    S.lineGesture = S.mode === "brush";
    if (S.lineGesture) { S.anchor = S.lastPaint ?? c; S.secondPoint = true; }
    if (!S.anchor) S.anchor = c;
    return draw();
  }
  S.stroke = { before: new Map(), last: c };
  paintCells(footprint(c[0], c[1], S.brush), S.stroke.before);
});
stage.addEventListener("pointermove", (e) => {
  if (!S.doc) return;
  const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (pan) {
    S.view.ox = pan.ox + mx - pan.mx; S.view.oy = pan.oy + my - pan.my;
    return draw();
  }
  const c = cellAt(mx, my);
  const changed = !S.hover || S.hover[0] !== c[0] || S.hover[1] !== c[1];
  S.shift = e.shiftKey;
  if (S.floating) {
    S.floating.to = { x: c[0] - S.floating.grab[0], y: c[1] - S.floating.grab[1] };
    status(); draw(); return;
  }
  if (!changed) { draw(); return; }
  const clamped = [Math.max(0, Math.min(S.doc.width - 1, c[0])), Math.max(0, Math.min(S.doc.height - 1, c[1]))];
  S.hover = inside(...c) || S.anchor || S.stroke ? clamped : null;
  S.hoverBase = S.tool === "base" && S.hover ? { reason: B.base(store.wire(S.doc), S.hover) } : null;
  if (S.press && (S.press[0] !== clamped[0] || S.press[1] !== clamped[1])) S.dragged = true;
  if (S.stroke && S.hover) {
    for (const p of line(S.stroke.last, S.hover)) paintCells(footprint(p[0], p[1], S.brush), S.stroke.before);
    S.stroke.last = S.hover;
  }
  if (!S.anchor) S.message = "";
  status();
  draw();
});
stage.addEventListener("pointerup", (e) => {
  if (pan && (e.button === 1 || e.button === 2 || e.button === 0)) {
    pan = null; stage.classList.remove("pan");
    return;
  }
  if (e.button !== 0) return;
  if (S.mode === "select") {
    if (S.floating && !S.floating.paste) {
      if (!dropSelection()) { S.floating = null; refresh(); }
    } else if (S.anchor && S.hover) {
      S.selection = S.dragged ? bounds(S.anchor, S.hover) : null; S.anchor = null; S.press = null; refresh();
    }
    return;
  }
  if (S.stroke) {
    const edit = tilesEdit(S.stroke.before);
    S.lastPaint = S.stroke.last;
    S.stroke = null;
    pushEdit(edit);
    if (!edit) touch(false);
  } else if ((shapeMode() || S.lineGesture) && S.anchor && S.press) {
    const end = shapeEnd();
    const second = S.dragged || S.secondPoint;
    S.press = null;
    if (second) {
      const before = new Map();
      paintCells(gestureCells(), before);
      S.lastPaint = end;
      S.anchor = null;
      S.lineGesture = false;
      pushEdit(tilesEdit(before));
    }
    draw();
  }
});
stage.addEventListener("pointerleave", () => {
  if (S.stroke || S.anchor || S.floating || pan) return;
  S.hover = null; status(); draw();
});
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

const typing = () => {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
};
window.addEventListener("keydown", (e) => {
  if ($("#modal-root").childElementCount) {
    if (e.key === "Escape") closeModal();
    return;
  }
  if (!S.doc || $("#app").hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(); return; }
  if (typing()) { if (e.key === "Escape") document.activeElement.blur(); return; }
  if (e.key === "Shift") { S.shift = true; draw(); }
  if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "v")) {
    e.preventDefault(); return k === "c" ? copySelection() : pasteSelection();
  }
  if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
    e.preventDefault();
    return e.shiftKey || k === "y" ? redo() : undo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") {
    if (S.offsetPreview) { S.offsetPreview = false; S.message = ""; refresh(); return; }
    if (S.stroke || S.anchor || S.selection || S.floating) { cancel(); refresh(); return; }
    if (S.pane) return setPane(null);
    return toLibrary();
  }
  if (e.key === " ") { S.keys.add(" "); e.preventDefault(); return; }
  if ("wasd".includes(k) && k.length === 1) { S.keys.add(k); startPanLoop(); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= 9) return pickTool(TERRAIN[n - 1].id);
  const mode = MODES.find((m) => m.key.toLowerCase() === k);
  if (mode) return pickMode(mode.id);
  if (k === "h") return pickTool("base");
  if (k === "f") return fit();
  if (k === "v") return toggleMarks();
});
window.addEventListener("keyup", (e) => { S.keys.delete(e.key === " " ? " " : e.key.toLowerCase()); if (e.key === "Shift") { S.shift = false; draw(); } });
window.addEventListener("blur", () => { S.keys.clear(); S.shift = false; pan = null; stage.classList.remove("pan"); if (S.stroke || S.press || (S.floating && !S.floating.paste)) { cancel(); refresh(); } });
stage.addEventListener("pointercancel", () => { pan = null; stage.classList.remove("pan"); cancel(); refresh(); });
let panLoop = 0;
function startPanLoop() {
  if (panLoop) return;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const v = 720 * dt;
    let moved = false;
    if (S.keys.has("w")) { S.view.oy += v; moved = true; }
    if (S.keys.has("s")) { S.view.oy -= v; moved = true; }
    if (S.keys.has("a")) { S.view.ox += v; moved = true; }
    if (S.keys.has("d")) { S.view.ox -= v; moved = true; }
    if (!moved) { panLoop = 0; return; }
    draw();
    panLoop = requestAnimationFrame(step);
  };
  panLoop = requestAnimationFrame(step);
}
new ResizeObserver(() => draw()).observe(stage);

// ---------------------------------------------------------------- chrome
function pickTool(id) {
  cancel();
  S.tool = id;
  if (id === "base" && S.mode === "select") S.mode = "brush";
  if (id !== "base" && S.mode === "picker") S.mode = S.prevMode;
  refresh();
}
function pickMode(id) {
  cancel();
  if (id === "picker" && S.mode !== "picker") S.prevMode = S.mode;
  S.mode = id;
  if (S.tool === "base") S.tool = "low";
  refresh();
}
function toggleMarks() {
  S.marks = !S.marks;
  refresh();
}
const modesEl = $("#modes"), terrainEl = $("#terrain");
for (const m of MODES) modesEl.append(h("button", { class: "btn", "data-mode": m.id, onclick: () => pickMode(m.id) }, m.name, h("kbd", {}, m.key)));
TERRAIN.forEach((t, i) => terrainEl.append(h("button", { class: "chip", "data-tool": t.id, onclick: () => pickTool(t.id), title: `${t.name} (${i + 1})` }, h("b", {}, t.name), h("small", {}, String(i + 1)))));
$("#base-tool").addEventListener("click", () => pickTool("base"));
const legend = $("#legend");
[...NAMES.map((n, i) => [PLAN.categories[i], n + (i === 3 ? " · 포탑 자리" : i === 4 ? " · 건설 불가" : "")]),
  [PLAN.base, "기지"], [PLAN.entry, "이어진 외곽"], [PLAN.invalid, "끊긴 외곽·입구"], [PLAN.route, "연결 경로"],
].forEach(([c, label]) => legend.append(h("i", { style: `background:${rgb(c)}` }), h("span", {}, label)));
const brushEl = $("#brush");
brushEl.max = C.max_size;
brushEl.addEventListener("change", () => {
  const n = Number(brushEl.value);
  const ok = Number.isInteger(n) && n >= 1 && n <= C.max_size;
  brushEl.parentElement.classList.toggle("bad", !ok);
  if (ok) S.brush = n; else say(`붓 크기는 1~${C.max_size} 정수입니다.`);
  draw();
});
brushEl.addEventListener("keydown", (e) => { if (e.key === "Enter") brushEl.blur(); });
$("#shape-solid").addEventListener("click", () => { S.filled = true; refresh(); });
$("#shape-outline").addEventListener("click", () => { S.filled = false; refresh(); });
for (const kind of ["box", "region"]) $("#select-" + kind).addEventListener("click", () => { cancel(); S.selectKind = kind; refresh(); });
for (const [id, outward] of [["in", false], ["out", true]]) $("#offset-" + id).addEventListener("click", () => { S.offset.outward = outward; S.message = ""; refresh(); });
$("#offset-amount").max = C.max_size;
$("#offset-amount").addEventListener("input", (e) => {
  const n = Number(e.target.value), valid = Number.isInteger(n) && n >= 1 && n <= C.max_size;
  S.offsetValid = valid;
  e.target.classList.toggle("bad", !valid);
  if (valid) { S.offset.amount = n; S.message = ""; } else say(`폭은 1~${C.max_size} 정수입니다.`);
  refresh();
});
$("#thickness").max = C.max_size;
$("#thickness").addEventListener("input", (e) => {
  const n = Number(e.target.value), valid = Number.isInteger(n) && n >= 1 && n <= C.max_size;
  S.thicknessValid = valid;
  e.target.classList.toggle("bad", !valid);
  if (valid) { S.thickness = n; draw(); } else say(`두께는 1~${C.max_size} 정수입니다.`);
});
document.addEventListener("click", (e) => {
  const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
  const pane = e.target.closest(".top [data-pane]")?.dataset.pane;
  if (pane) return setPane(S.pane === pane ? null : pane);
  if (!cmd || e.target.closest("#modal-root")) return;
  ({
    library: toLibrary, save, undo, redo, fit, marks: toggleMarks, skin: cycleSkin, "base-remove": removeBase,
    copy: copySelection, paste: pasteSelection, deselect: () => { cancel(); refresh(); },
    offset: () => { S.offsetPreview = true; S.message = ""; refresh(); }, "offset-apply": applyOffset,
  })[cmd]?.();
});

function refresh(rebuildPane = true) {
  if (!S.doc) return;
  for (const b of modesEl.children) b.classList.toggle("on", S.tool !== "base" && b.dataset.mode === S.mode);
  for (const b of terrainEl.children) b.classList.toggle("on", b.dataset.tool === S.tool);
  $("#base-tool").classList.toggle("on", S.tool === "base");
  $("#base-remove").hidden = !(S.tool === "base" && S.doc.base);
  $("#brush-field").hidden = !["brush", "line"].includes(S.mode) || S.tool === "base";
  $("#shape-options").hidden = !["rect", "ellipse"].includes(S.mode) || S.tool === "base";
  $("#selection-options").hidden = S.mode !== "select";
  terrainEl.hidden = S.mode === "select";
  $("#terrain-caption").hidden = S.mode === "select";
  $("#thickness-field").hidden = S.filled;
  $("#shape-solid").classList.toggle("on", S.filled);
  $("#shape-outline").classList.toggle("on", !S.filled);
  $("[data-cmd=copy]").disabled = !S.selection || !!S.floating;
  $("[data-cmd=paste]").disabled = !S.clipboard;
  $("#offset-options").hidden = !S.selection || !!S.floating;
  $("[data-cmd=offset-apply]").hidden = !S.offsetPreview;
  $("[data-cmd=offset-apply]").disabled = !S.offsetValid;
  $("[data-cmd=offset]").disabled = !S.offsetValid;
  $("#select-box").classList.toggle("on", S.selectKind === "box");
  $("#select-region").classList.toggle("on", S.selectKind === "region");
  $("#offset-in").classList.toggle("on", !S.offset.outward);
  $("#offset-out").classList.toggle("on", S.offset.outward);
  $("#marks-btn").classList.toggle("on", S.marks);
  for (const b of document.querySelectorAll(".top [data-pane]")) b.classList.toggle("on", b.dataset.pane === S.pane);
  $("#skin-name").textContent = C.themes.find((t) => t.landscape === S.doc.landscape)?.name ?? S.doc.landscape;
  if (S.pane === "spawn" && rebuildPane) renderSpawn();
  status();
  draw();
}

function cycleSkin() {
  const i = C.themes.findIndex((t) => t.landscape === S.doc.landscape);
  const a = snapshot();
  S.doc.landscape = C.themes[(i + 1) % C.themes.length].landscape;
  pushEdit({ type: "state", a, b: snapshot() });
}

// ---------------------------------------------------------------- panes
const paneEl = $("#pane");
const valid = (n) => Number.isInteger(n) && n >= C.min_size && n <= C.max_size;
function setPane(p) {
  cancel();
  S.pane = p;
  paneEl.hidden = !p;
  paneEl.replaceChildren();
  if (p === "size") {
    S.resize = { w: S.doc.width, h: S.doc.height, anchor: 4, mode: "extent", error: "" };
    renderSize();
  } else if (p === "spawn") renderSpawn();
  else if (p === "menu") renderMenu();
  refresh();
  requestAnimationFrame(() => draw());
}
/** `live` commits on every keystroke; otherwise on Enter or leaving the field. */
function numberInput(value, min, max, onset, { live = true, field = null } = {}) {
  const el = h("input", { class: "input", type: "number", min, max, value, inputmode: "numeric", "data-field": field });
  const commit = () => {
    const n = Number(el.value);
    const ok = Number.isInteger(n) && n >= Number(el.min) && n <= Number(el.max);
    el.classList.toggle("bad", !ok);
    onset(ok ? n : null);
  };
  el.addEventListener(live ? "input" : "change", commit);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); el.blur(); } });
  return el;
}
function renderSize() {
  const r = S.resize;
  const note = h("div", { class: "note" });
  const preview = h("button", { class: "btn primary", onclick: previewResize }, "미리보기");
  const showNote = () => {
    note.className = "note" + (r.error ? " bad" : "");
    note.textContent = r.error || (r.mode === "extent" ? "빨강은 잘리는 땅, 파랑은 새 평지" : "길·산·물의 배치와 폭을 함께 조절합니다. 기지는 위치만 바뀝니다.");
    preview.disabled = !valid(r.w) || !valid(r.h) || (r.w === S.doc.width && r.h === S.doc.height);
  };
  const anchors = h("div", { class: "anchors" });
  for (let i = 0; i < 9; i++) {
    anchors.append(h("button", { class: i === r.anchor ? "on" : "", title: "기준점", onclick: () => { r.anchor = i; r.error = ""; renderSize(); draw(); } }));
  }
  const set = (key) => (n) => { r[key] = n ?? NaN; r.error = n == null ? `각 변 ${C.min_size}~${C.max_size} 정수를 입력하세요.` : ""; showNote(); draw(); };
  fill(paneEl, 
    h("h2", {}, "크기", h("span", { class: "faint" }, `${S.doc.width} × ${S.doc.height}`)),
    h("div", { class: "grid2", "aria-label": "크기 변경 방식" }, [["extent", "여백·잘라내기"], ["scale", "전체 비례"]].map(([mode, label]) =>
      h("button", { class: "btn" + (r.mode === mode ? " on" : ""), "aria-pressed": String(r.mode === mode), onclick: () => { r.mode = mode; r.error = ""; renderSize(); draw(); } }, label))),
    h("div", { class: "metrics" },
      h("span", {}, "가로"), numberInput(r.w, C.min_size, C.max_size, set("w"), { field: "resize-w" }),
      h("span", {}, "세로"), numberInput(r.h, C.min_size, C.max_size, set("h"), { field: "resize-h" })),
    h("div", { class: "note" }, `각 변 ${C.min_size}~${C.max_size}칸`),
    r.mode === "extent" && h("div", { class: "caption" }, "기준점"),
    r.mode === "extent" && anchors,
    note,
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => setPane(null) }, "취소"),
      preview),
  );
  showNote();
}
function previewResize() {
  const r = S.resize;
  if (!valid(r.w) || !valid(r.h)) { r.error = `각 변 ${C.min_size}~${C.max_size} 정수를 입력하세요.`; return renderSize(); }
  const candidate = resizeMap(S.doc, r.w, r.h, r.mode, r.anchor);
  const clipped = candidate.base && candidate.base.some((v, axis) => v < 2 || v + 2 >= [r.w, r.h][axis]);
  // A crop can move the centre outside even the unsigned WASM coordinate
  // domain. Refuse that transform before passing it to the common checker.
  if (candidate.base?.some((v) => v < 0)) {
    r.error = "기지의 5×5 영역이 잘립니다. 크기나 기준점을 바꾸세요.";
    return renderSize();
  }
  let report;
  try { report = B.check(store.wire(candidate)); }
  catch (e) { r.error = String(e.message); return renderSize(); }
  const ratio = [r.w / S.doc.width, r.h / S.doc.height];
  const notes = [];
  if (clipped) notes.push("기지의 5×5 영역이 잘립니다. 크기나 기준점을 바꾸세요.");
  if (r.mode === "scale") {
    notes.push(`가로 ${ratio[0].toFixed(2)}배 · 세로 ${ratio[1].toFixed(2)}배`);
    if (ratio[0] !== ratio[1]) notes.push("가로·세로 배율이 달라 모양 비율도 바뀝니다.");
    notes.push("입구는 확대 후 다시 다듬어야 할 수 있습니다. 축소하면 좁은 길이나 작은 지형이 사라질 수 있습니다.");
  }
  S.keys.clear();
  const dialog = modal("resize-preview", "크기 변경 미리보기", h("div", { class: "body" },
    h("div", { class: "resize-compare" }, resizePicture(S.doc, S.check, "현재"), resizePicture(candidate, report, r.mode === "scale" ? "전체 비례" : "여백·잘라내기")),
    h("div", { class: "note" + (clipped ? " bad" : "") }, notes.join("\n")),
    h("div", { class: "check " + (report.issues.length ? "bad" : "ok") }, report.summary),
    h("div", { class: "note" }, "적용 전에는 원본이 바뀌지 않습니다. 지형 연결 검사는 라운드 적합성 판정과 별개입니다.")),
    h("footer", {}, h("button", { class: "btn", onclick: () => closeModal() }, "취소"),
      h("button", { class: "btn primary", disabled: clipped, onclick: () => { closeModal(); applyResize(candidate); } }, "적용")));
  dialog.querySelector("footer button").focus();
}
function resizePicture(doc, report, title) {
  const picture = new TerrainLayer(PLAN);
  picture.reset(doc);
  if (report) { picture.setShapes(report.ramps, report.invalid); picture.paintAll(); }
  if (doc.base) {
    const [x, y] = doc.base, p = picture.px, c = picture.ctx;
    c.strokeStyle = rgb(PLAN.base); c.lineWidth = Math.max(2, p / 4);
    c.strokeRect((x - 1) * p, (y - 1) * p, 3 * p, 3 * p);
    c.setLineDash([p / 2, p / 2]);
    c.strokeRect((x - 2) * p, (y - 2) * p, 5 * p, 5 * p);
  }
  picture.canvas.setAttribute("aria-label", `${title} ${doc.width} × ${doc.height} 지형`);
  return h("figure", {}, h("figcaption", {}, title, h("span", { class: "faint" }, `${doc.width} × ${doc.height}`)), h("div", { class: "resize-map" }, picture.canvas));
}
function applyResize(candidate) {
  const a = snapshot();
  const b = { width: candidate.width, height: candidate.height, landscape: candidate.landscape, codes: candidate.codes, base: candidate.base };
  const edit = { type: "state", a, b };
  apply(edit, true);
  S.pane = null; paneEl.hidden = true;
  pushEdit(edit);
}

function battle() {
  return S.doc.battle ?? { rounds: C.profile.rounds, full_sight_round: C.profile.full_sight_round };
}
function recalc() {
  // Read the pending fields too: a click can precede their change/blur event.
  const rounds = Number(paneEl.querySelector('[data-field="rounds"]').value);
  const full = Number(paneEl.querySelector('[data-field="full"]').value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 256 || !Number.isInteger(full) || full < 1 || full > rounds)
    return say("라운드는 1~256, 전체 시야 라운드는 최대 라운드 이하여야 합니다.");
  const current = battle();
  if (current.rounds !== rounds || current.full_sight_round !== full) {
    S.doc.battle = { rounds, full_sight_round: full };
    S.message = ""; touch(true, false);
  }
  const a = S.analysis, job = ++a.job;
  a.running = true; a.error = "";
  const revision = S.revision;
  const vision = sightKey(S.doc);
  worker.onmessage = ({ data }) => {
    if (data.job !== S.analysis.job) return;
    a.running = false;
    if (data.error) { a.error = data.error; a.report = null; }
    else { a.report = data.report; a.revision = revision; a.sightKey = vision; a.round = Math.min(a.round, data.report.rounds.length - 1); }
    renderSpawn(); draw();
  };
  worker.postMessage({ job, doc: store.wire(S.doc) });
  renderSpawn();
}
const worker = new Worker(new URL("./worker.js?v=69290bf5", import.meta.url), { type: "module" });
function renderSpawn() {
  if (S.pane !== "spawn") return;
  const a = S.analysis, bt = battle();
  const setBattle = (key) => (n) => {
    if (n == null) return say("라운드는 1~256, 전체 시야 라운드는 최대 라운드 이하여야 합니다.");
    const next = { ...battle(), [key]: n };
    if (key === "rounds") next.full_sight_round = Math.min(next.full_sight_round, n);
    if (next.full_sight_round > next.rounds) return say("라운드는 1~256, 전체 시야 라운드는 최대 라운드 이하여야 합니다.");
    S.doc.battle = next;
    S.message = "";
    // Keep the inputs and the clicked button mounted on change/blur.
    // Replacing the panel here would swallow the click on "다시 계산".
    touch(true, false);
    const rounds = paneEl.querySelector('[data-field="rounds"]');
    const full = paneEl.querySelector('[data-field="full"]');
    rounds.value = next.rounds; full.value = next.full_sight_round; full.max = next.rounds;
    const state = $("#analysis-state");
    state.hidden = false; state.className = "note stale";
    state.textContent = "라운드 설정 변경 · 다시 계산 후 시야 표시";
    if ($("#sight-range")) $("#sight-range").textContent = "재계산 필요";
  };
  const r = a.report?.rounds[a.round];
  const stale = a.report && a.revision !== S.revision;
  const vision = sightPreview(S.doc, a);
  const state = a.running ? h("div", { class: "note" }, "계산 중…")
    : a.error ? h("div", { class: "note bad" }, a.error)
    : !a.report ? h("div", { class: "note" }, "기지 배치 후 다시 계산을 누르면 라운드별 시야·스폰·경로를 표시합니다.")
    : stale ? h("div", { class: "note stale" }, vision ? "지형 변경 · 시야는 유지, 스폰·경로는 재계산 필요" : "기지·크기·라운드 변경 · 다시 계산 후 시야 표시") : null;
  const rows = a.report?.rounds.map((row, i) =>
    h("tr", { class: "pick" + (i === a.round ? " on" : ""), onclick: () => { a.round = i; renderSpawn(); draw(); } },
      h("td", {}, String(row.number)), h("td", {}, row.count.toLocaleString()), h("td", {}, row.candidates.length.toLocaleString()),
      h("td", {}, row.visible_places.toLocaleString()))) ?? [];
  const focused = document.activeElement?.dataset?.field;
  const roundsInput = numberInput(bt.rounds, 1, 256, setBattle("rounds"), { live: false, field: "rounds" });
  const fullInput = numberInput(bt.full_sight_round, 1, bt.rounds, setBattle("full_sight_round"), { live: false, field: "full" });
  roundsInput.addEventListener("input", () => {
    const n = Number(roundsInput.value);
    if (Number.isInteger(n) && n >= 1 && n <= 256) fullInput.max = n;
  });
  fill(paneEl, 
    h("h2", {}, "시야·적 진입"),
    h("div", { class: "metrics" },
      h("span", {}, "최대 라운드"), roundsInput,
      h("span", {}, "전체 시야 라운드"), fullInput),
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: recalc, disabled: a.running }, "다시 계산"),
      h("button", { class: "btn" + (a.sight ? " on" : ""), onclick: () => { a.sight = !a.sight; renderSpawn(); draw(); } }, a.sight ? "시야 켜짐" : "시야 꺼짐"),
      h("button", { class: "btn" + (a.routes ? " on" : ""), onclick: () => { a.routes = !a.routes; renderSpawn(); draw(); } }, a.routes ? "경로 켜짐" : "경로 꺼짐")),
    h("div", { id: "analysis-state", hidden: !state }, state),
    a.report && h("div", { class: "metrics sight-controls" }, h("span", {}, "미리볼 라운드"),
      h("select", { class: "input", "aria-label": "미리볼 라운드", onchange: (e) => { a.round = Number(e.target.value); renderSpawn(); draw(); } },
        a.report.rounds.map((row, i) => h("option", { value: i, selected: i === a.round }, roundSightLabel(row)))),
      h("span", {}, "시야 범위"), h("span", { id: "sight-range" }, vision ? sightLabel(vision.radius) : "재계산 필요")),
    r && h("div", { class: "metrics" },
      h("span", {}, "스폰 위치"), h("span", {}, `${r.candidates.length.toLocaleString()}곳`),
      h("span", {}, "구역 · 경로"), h("span", {}, `${r.regions} · ${r.routes.length}`),
      h("span", {}, "연결 땅"), h("span", {}, `${a.report.connected.toLocaleString()}칸`),
      h("span", {}, "전체 배치 추정"), h("span", {}, `${a.report.places.toLocaleString()}자리`)),
    a.report && h("table", { class: "rounds" },
      h("thead", {}, h("tr", {}, h("th", {}, "라운드"), h("th", {}, "예정 적"), h("th", {}, "생성 후보"), h("th", {}, "보이는 배치"))),
      h("tbody", {}, rows)),
    a.report && h("div", { class: "note" }, `${C.profile.id} r${C.profile.revision} · 정적 추정 · 성능 최대치 아님`),
  );
  if (focused) paneEl.querySelector(`[data-field="${focused}"]`)?.focus();
}
function renderMenu() {
  fill(paneEl, 
    h("h2", {}, "더보기"),
    h("div", { class: "menu" },
      h("button", { class: "btn", onclick: toLibrary }, "내 맵 목록"),
      h("button", { class: "btn", onclick: () => renameDialog(S.doc, (name) => { S.doc.name = name; touch(); }) }, "이름 변경"),
      h("button", { class: "btn", onclick: () => exportDoc() }, "게임 파일로 내보내기"),
      h("button", { class: "btn", onclick: () => importFile() }, "게임 파일 가져오기"),
      h("button", { class: "btn", onclick: howTo }, "게임에서 쓰는 법")),
  );
}

// ---------------------------------------------------------------- save / files
function save() {
  if (!S.doc) return false;
  cancel();
  const d = S.doc, prev = S.saved;
  if (prev && !S.dirty) { say("변경 없음"); return true; }
  const next = cloneDoc(d);
  if (prev) {
    next.generation = prev.generation + 1;
    next.terrain_revision = prev.terrain_revision + (sameTerrain(d, prev) ? 0 : 1);
  } else {
    next.generation = 1; next.terrain_revision = 1;
  }
  try {
    B.exportRon(store.wire(next));
    store.put(next);
  } catch (e) {
    say(`저장 실패: ${e.message}`);
    return false;
  }
  S.doc.generation = next.generation; S.doc.terrain_revision = next.terrain_revision;
  S.saved = cloneDoc(next);
  store.clearWork();
  $("#recovery").textContent = "";
  updateDirty();
  say(S.check?.issues.length ? "저장됨 · 미완성 맵(검사 실패)입니다." : "저장됨");
  return true;
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportDoc(doc) {
  if (!doc) {
    if (!save()) return;
    doc = S.saved;
  }
  try {
    const out = B.exportRon(store.wire(doc));
    download(out.file, out.ron);
    toast([h("span", {}, `${out.file} 저장됨. 게임 맵 폴더 `), h("code", {}, GAME_FOLDER), h("span", {}, " 에 넣으면 내 맵 목록에 나옵니다.")], GAME_FOLDER);
  } catch (e) {
    say(`내보내기 실패: ${e.message}`);
  }
}
function importFile() {
  const input = h("input", { type: "file", accept: ".ron" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > C.max_file_bytes) return alertDialog("가져오기 실패", "맵 파일이 너무 큽니다.");
    let doc;
    try {
      doc = store.unpack(B.importRon(await file.text()));
    } catch (e) {
      return alertDialog("가져오기 실패", e.message);
    }
    const existing = store.load(doc.id);
    const finish = (d) => {
      store.put(d);
      libraryDialog(d.id);
    };
    if (!existing) return finish(doc);
    choiceDialog("같은 맵이 있습니다", `“${existing.name}”이 이미 있습니다. 가져온 파일로 바꿀까요?`, [
      ["취소", null],
      ["사본으로", () => finish({ ...doc, id: crypto.randomUUID(), name: copyName(doc.name), generation: 1, terrain_revision: 1 })],
      ["바꾸기", () => finish(doc), "primary"],
    ]);
  });
  input.click();
}
const copyName = (name) => {
  const tail = " 사본";
  return (name.length + tail.length > C.max_name_chars ? name.slice(0, C.max_name_chars - tail.length) : name) + tail;
};
function howTo() {
  alertDialog("게임에서 쓰는 법",
    `1. 저장한 뒤 더보기 → 게임 파일로 내보내기 (파일 이름은 맵 ID.ron)\n2. 게임 PC의 맵 폴더에 넣습니다:\n   ${GAME_FOLDER}\n3. 게임 타이틀 → 맵 제작의 내 맵 목록에 나옵니다.\n\n반대로 게임에서 만든 맵은 같은 폴더의 .ron 파일을 가져오기로 엽니다.\n이름이나 내용은 바꿔도 되지만 파일 이름(ID)은 바꾸지 마세요.`);
}

// ---------------------------------------------------------------- dialogs
function modal(cls, title, body, footer) {
  const root = $("#modal-root");
  const dialog = h("div", { class: "dialog " + cls }, h("header", {}, title), body, footer);
  root.replaceChildren(h("div", { class: "scrim", onmousedown: (e) => { if (e.target === e.currentTarget && cls !== "library") closeModal(); } }, dialog));
  return dialog;
}
/** With no map open there is nothing behind a dialog: go back to the list. */
function closeModal(force = false) {
  if (!force && !S.doc) return libraryDialog();
  $("#modal-root").replaceChildren();
}
function alertDialog(title, text) {
  modal("", title, h("div", { class: "body" }, h("div", { class: "msg" }, text)),
    h("footer", {}, h("button", { class: "btn primary", onclick: closeModal }, "확인")));
}
function choiceDialog(title, text, choices) {
  modal("", title, h("div", { class: "body" }, h("div", { class: "msg" }, text)),
    h("footer", {}, choices.map(([label, run, kind]) =>
      h("button", { class: "btn " + (kind ?? ""), onclick: () => { closeModal(); run?.(); } }, label))));
}
function renameDialog(doc, done) {
  const input = h("input", { class: "input text", value: doc.name, maxlength: C.max_name_chars });
  const err = h("div", { class: "err" });
  const ok = () => {
    const name = input.value.trim();
    if (!name || [...name].length > C.max_name_chars) return (err.textContent = `맵 이름은 1~${C.max_name_chars}글자로 입력하세요.`);
    closeModal(); done(name);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  modal("", "이름 변경", h("div", { class: "body" }, h("div", { class: "form" }, h("span", {}, "이름"), input), err),
    h("footer", {}, h("button", { class: "btn", onclick: closeModal }, "취소"), h("button", { class: "btn primary", onclick: ok }, "확인")));
  input.select();
}
function newMapDialog(back) {
  const step = C.size_step;
  const state = { name: "새 맵", w: C.default_size, h: C.default_size, skin: C.themes[0].landscape };
  const err = h("div", { class: "err" });
  const create = h("button", { class: "btn primary" }, "만들기");
  const name = h("input", { class: "input text", value: state.name, maxlength: C.max_name_chars });
  const problem = () => {
    if (!state.name.trim() || [...state.name.trim()].length > C.max_name_chars) return `맵 이름은 1~${C.max_name_chars}글자로 입력하세요.`;
    if (!valid(state.w) || !valid(state.h)) return `가로·세로는 ${C.min_size}~${C.max_size} 정수입니다. ±는 ${step}칸씩.`;
    return "";
  };
  const update = () => { const p = problem(); err.textContent = p; create.disabled = !!p; };
  name.addEventListener("input", () => { state.name = name.value; update(); });
  const stepper = (key) => {
    const input = h("input", { class: "input", type: "number", min: C.min_size, max: C.max_size, value: state[key], inputmode: "numeric" });
    input.addEventListener("input", () => { state[key] = Number(input.value); input.classList.toggle("bad", !valid(state[key])); update(); });
    const bump = (d) => () => {
      const cur = valid(state[key]) ? state[key] : C.default_size;
      state[key] = Math.max(C.min_size, Math.min(C.max_size, cur + d));
      input.value = state[key]; input.classList.remove("bad"); update();
    };
    return h("div", { class: "stepper" }, h("button", { class: "btn", onclick: bump(-step), tabindex: "-1" }, "−"), input, h("button", { class: "btn", onclick: bump(step), tabindex: "-1" }, "+"));
  };
  const skin = h("select", { class: "input text" }, C.themes.map((t) => h("option", { value: t.landscape }, t.name)));
  skin.addEventListener("change", () => (state.skin = skin.value));
  const go = () => {
    if (problem()) return;
    closeModal(true);
    open(blank(state.name.trim(), state.w, state.h, state.skin), null);
  };
  create.addEventListener("click", go);
  const dialog = modal("", "새 맵",
    h("div", { class: "body" },
      h("div", { class: "form" }, h("span", {}, "이름"), name, h("span", {}, "가로"), stepper("w"), h("span", {}, "세로"), stepper("h"), h("span", {}, "외관"), skin),
      h("div", { class: "note" }, `각 변 ${C.min_size}~${C.max_size}칸 · ±는 ${step}칸씩`), err),
    h("footer", {}, h("button", { class: "btn", onclick: () => (back ? back() : closeModal()) }, "취소"), create));
  dialog.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") go(); });
  update();
  name.select();
}

function libraryDialog(selectId) {
  let maps = store.list();
  let selected = maps.find((m) => m.id === selectId) ?? maps.find((m) => m.id === S.doc?.id) ?? maps[0] ?? null;
  const rows = h("div", { class: "rows" });
  const preview = h("canvas");
  const meta = h("div", { class: "meta" });
  const acts = h("div", { class: "acts" });
  const editBtn = h("button", { class: "btn primary", onclick: () => selected && openSaved(selected) }, "편집");
  const skinName = (l) => C.themes.find((t) => t.landscape === l)?.name ?? l;
  const paint = () => {
    rows.replaceChildren(...(maps.length ? maps.map((m) =>
      h("div", { class: "item" + (m === selected ? " on" : ""), onclick: () => { selected = m; paint(); }, ondblclick: () => openSaved(m) },
        h("div", {}, m.name, h("small", {}, `${m.width} × ${m.height} · ${skinName(m.landscape)}`)),
        h("button", { class: "btn quiet", onclick: (e) => { e.stopPropagation(); deleteDialog(m); } }, "삭제")))
      : [h("div", { class: "empty" }, "아직 만든 맵이 없습니다.")]));
    editBtn.disabled = !selected;
    acts.replaceChildren();
    meta.replaceChildren();
    if (selected) {
      let summary = "";
      try { const r = B.check(store.wire(selected)); summary = r.issues.length ? r.issues[0] : r.summary; } catch (e) { summary = e.message; }
      meta.append(h("span", {}, `${selected.width} × ${selected.height} · ${skinName(selected.landscape)}`), h("span", {}, summary));
      acts.append(
        h("button", { class: "btn quiet", onclick: () => renameDialog(selected, (name) => {
          const d = { ...selected, name, generation: selected.generation + 1 };
          store.put(d);
          if (S.doc?.id === d.id) { S.saved = cloneDoc(d); S.doc.name = name; S.doc.generation = d.generation; updateDirty(); }
          libraryDialog(d.id);
        }) }, "이름 변경"),
        h("button", { class: "btn quiet", onclick: () => { const d = { ...selected, id: crypto.randomUUID(), name: copyName(selected.name), generation: 1, terrain_revision: 1 }; store.put(d); libraryDialog(d.id); } }, "복제"),
        h("button", { class: "btn quiet", onclick: () => exportDoc(selected) }, "내보내기"));
      requestAnimationFrame(() => thumbnail(preview, selected, PLAN));
    } else {
      preview.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    }
  };
  const deleteDialog = (m) => {
    const input = h("input", { class: "input text", placeholder: m.name });
    const del = h("button", { class: "btn primary", disabled: true }, "삭제");
    input.addEventListener("input", () => (del.disabled = input.value.trim() !== m.name));
    del.addEventListener("click", () => {
      store.remove(m.id);
      if (S.doc?.id === m.id) { S.saved = null; updateDirty(); }
      libraryDialog();
    });
    modal("", "맵 삭제", h("div", { class: "body" }, h("div", { class: "msg" }, `“${m.name}”을(를) 이 브라우저에서 지웁니다. 내보낸 파일은 남습니다.\n확인하려면 이름을 입력하세요.`), input),
      h("footer", {}, h("button", { class: "btn", onclick: () => libraryDialog(m.id) }, "취소"), del));
    input.focus();
  };
  const canClose = !!S.doc;
  modal("library", h("div", { style: "display:flex;justify-content:space-between;align-items:center" }, "맵 제작",
      canClose ? h("button", { class: "btn quiet", onclick: closeModal }, "닫기") : null),
    h("div", { class: "split" },
      h("div", { class: "list" },
        h("div", { class: "head" }, h("span", {}, "내 맵"), h("button", { class: maps.length ? "btn" : "btn primary", onclick: () => newMapDialog(() => libraryDialog(selected?.id)) }, "새 맵 만들기")),
        rows),
      h("div", { class: "preview" }, preview, meta, acts)),
    h("footer", {}, h("button", { class: "btn quiet", onclick: importFile }, "게임 파일 가져오기"), h("button", { class: "btn quiet", onclick: howTo }, "게임에서 쓰는 법"), h("div", { class: "spacer" }), editBtn));
  paint();
}
function openSaved(m) {
  closeModal(true);
  const saved = store.load(m.id) ?? m;
  open(saved, saved);
}
function toLibrary() {
  if (!S.doc || !S.dirty) return libraryDialog();
  choiceDialog("저장하지 않은 변경", `“${S.doc.name}”의 변경을 저장할까요?`, [
    ["취소", null],
    ["버리기", () => {
      store.clearWork();
      if (S.saved) open(S.saved, S.saved);
      else { S.doc = null; $("#app").hidden = true; }
      libraryDialog();
    }],
    ["저장", () => { if (save()) libraryDialog(); }, "primary"],
  ]);
}
function toast(content, copy) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast" }, h("div", {}, content),
    copy ? h("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(copy) }, "경로 복사") : null,
    h("button", { class: "btn quiet", onclick: () => el.remove() }, "닫기"));
  document.body.append(el);
  setTimeout(() => el.remove(), 15000);
}
window.addEventListener("beforeunload", () => { clearTimeout(workTimer); saveWork(); });

// ---------------------------------------------------------------- start
C.profile_ingress = C.profile.ingress_cells;
$("#boot").remove();
const work = store.loadWork();
if (work?.doc) {
  open(work.doc, work.savedId ? store.load(work.savedId) : null);
  say("최근 작업을 복구했습니다.");
} else {
  libraryDialog();
}
window.__editor = { S, B, C };
