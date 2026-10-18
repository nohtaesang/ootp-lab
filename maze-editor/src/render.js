// The flat role-colour view, drawn the way the game editor's readable plan is
// (screens/map_editor/plan.rs): one colour per category, a light/dark inner
// edge where the category changes, shaded slopes with tread lines, a red X on
// broken entrances. Presentation only; every rule comes from the WASM bridge.

export const NAMES = ["평지", "언덕", "입구", "평산", "험산", "심연", "물", "용암", "바위"];
export const FULL = ["평지", "언덕", "언덕입구", "평평한 산", "울퉁불퉁한 산", "심연", "물", "용암", "부서지는 바위"];

export const kindOf = (code) => code & 7;
export const heightOf = (code) => (code >> 3) & 15;
export const isRamp = (code) => (code & 128) !== 0;

/** Category index shared with plan.rs `category`. */
export function category(code) {
  switch (kindOf(code)) {
    case 0: return isRamp(code) ? 2 : heightOf(code) === 0 ? 0 : 1;
    case 1: return 3;
    case 2: return 4;
    case 3: return 5;
    case 4: return 6;
    case 5: return 7;
    default: return 8;
  }
}

/** pixel_terrain::EntrancePatch::height — two planar triangles. */
export function slopeHeight([a, b, c, d], u, v) {
  if (Math.abs(a - c) >= Math.abs(b - d)) {
    return v <= u ? a + (b - a) * u + (c - b) * v : a + (c - d) * u + (d - a) * v;
  }
  return u + v <= 1 ? a + (b - a) * u + (d - a) * v : c + (d - c) * (1 - u) + (b - c) * (1 - v);
}

const scale = (rgb, g) => [Math.min(255, rgb[0] * g), Math.min(255, rgb[1] * g), Math.min(255, rgb[2] * g)];

export class TerrainLayer {
  constructor(plan) {
    this.plan = plan;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.slopes = new Map();
    this.invalid = new Set();
  }
  /** Rebuild for a new size; px per cell keeps the bitmap at most 2048 wide. */
  reset(doc) {
    this.doc = doc;
    this.px = Math.max(4, Math.min(16, Math.floor(2048 / Math.max(doc.width, doc.height))));
    this.canvas.width = doc.width * this.px;
    this.canvas.height = doc.height * this.px;
    this.image = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.paintAll();
  }
  setShapes(ramps, invalid) {
    this.slopes = new Map(ramps.map(([x, y, corners]) => [y * this.doc.width + x, corners]));
    this.invalid = new Set(invalid.map(([x, y]) => y * this.doc.width + x));
  }
  paintAll() {
    for (let i = 0; i < this.doc.codes.length; i++) this.cell(i);
    this.ctx.putImageData(this.image, 0, 0);
  }
  /** Repaint cells and their neighbours (edges depend on them). */
  paint(indices) {
    const { width, height } = this.doc;
    const todo = new Set();
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (const i of indices) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        todo.add(ny * width + nx);
        x0 = Math.min(x0, nx); y0 = Math.min(y0, ny); x1 = Math.max(x1, nx); y1 = Math.max(y1, ny);
      }
    }
    if (x1 < 0) return;
    for (const i of todo) this.cell(i);
    const p = this.px;
    this.ctx.putImageData(this.image, 0, 0, x0 * p, y0 * p, (x1 - x0 + 1) * p, (y1 - y0 + 1) * p);
  }
  cell(i) {
    const { width, height, codes } = this.doc;
    const { categories, invalid } = this.plan;
    const P = this.px, data = this.image.data, rowLen = this.canvas.width;
    const x = i % width, y = (i / width) | 0;
    const code = codes[i], cat = category(code);
    const around = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx < 0 || ny < 0 || nx >= width || ny >= height ? -1 : category(codes[ny * width + nx]);
    });
    const slope = isRamp(code) ? this.slopes.get(i) : undefined;
    const broken = this.invalid.has(i);
    const base = categories[cat];
    for (let py = 0; py < P; py++) {
      for (let px = 0; px < P; px++) {
        let rgb = base;
        let h = 0;
        if (slope) {
          h = slopeHeight(slope, px / (P - 1), py / (P - 1));
          rgb = scale(rgb, 0.8 + 0.3 * h);
        }
        const dist = [py, P - 1 - px, P - 1 - py, px];
        for (let side = 0; side < 4; side++) {
          if (dist[side] === 0 && around[side] !== cat) rgb = scale(rgb, side === 0 || side === 3 ? 1.18 : 0.68);
        }
        if (slope && Math.round(h * (P - 1)) % 4 === 2 && px > 1 && px < P - 2 && py > 1 && py < P - 2) rgb = scale(rgb, 0.82);
        if (broken && (px === py || px + py === P - 1)) rgb = invalid;
        const o = ((y * P + py) * rowLen + x * P + px) * 4;
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
      }
    }
  }
}

/** One label per cardinally connected category region, on a member cell. */
export function regions(doc) {
  const { width, height, codes } = doc;
  const seen = new Uint8Array(codes.length);
  const out = [];
  const stack = [];
  for (let start = 0; start < codes.length; start++) {
    if (seen[start]) continue;
    const cat = category(codes[start]);
    const members = [];
    seen[start] = 1;
    stack.push(start);
    let sx = 0, sy = 0;
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % width, y = (i / width) | 0;
      sx += x; sy += y;
      for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!seen[j] && category(codes[j]) === cat) { seen[j] = 1; stack.push(j); }
      }
    }
    const cx = sx / members.length, cy = sy / members.length;
    let best = members[0], bestD = Infinity;
    for (const i of members) {
      const d = (i % width - cx) ** 2 + (((i / width) | 0) - cy) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    out.push({ cat, size: members.length, x: best % width, y: (best / width) | 0 });
  }
  return out;
}

/** A small whole-map picture for the library list. */
export function thumbnail(canvas, doc, plan) {
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio;
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const s = Math.min(w / doc.width, h / doc.height) * 0.94;
  const ox = (w - doc.width * s) / 2, oy = (h - doc.height * s) / 2;
  const img = ctx.createImageData(doc.width, doc.height);
  for (let i = 0; i < doc.codes.length; i++) {
    const rgb = plan.categories[category(doc.codes[i])];
    img.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  const tmp = document.createElement("canvas");
  tmp.width = doc.width; tmp.height = doc.height;
  tmp.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, ox, oy, doc.width * s, doc.height * s);
  if (doc.base) {
    const [bx, by] = doc.base;
    ctx.strokeStyle = `rgb(${plan.base})`;
    ctx.lineWidth = Math.max(1.5, s * 0.25);
    ctx.strokeRect(ox + (bx - 1) * s, oy + (by - 1) * s, 3 * s, 3 * s);
  }
}
