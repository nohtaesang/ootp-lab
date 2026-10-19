// Cell geometry and terrain transfers; no game rules or persistent layers.
export function bounds(a, b) {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]) + 1, h: Math.abs(a[1] - b[1]) + 1 };
}
export const contains = (r, [x, y]) => !!(r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && (!r.mask || r.mask[(y - r.y) * r.w + x - r.x]));

export function constrain(a, b, square = false) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (square) {
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + (dx < 0 ? -n : n), a[1] + (dy < 0 ? -n : n)];
  }
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
  return [a[0] + Math.sign(Math.round(Math.cos(angle) * 10)) * n, a[1] + Math.sign(Math.round(Math.sin(angle) * 10)) * n];
}
export function shapeCorners(anchor, pointer, square = false, centered = false) {
  const end = square ? constrain(anchor, pointer, true) : pointer;
  const start = centered ? [2 * anchor[0] - end[0], 2 * anchor[1] - end[1]] : anchor;
  return [start, end];
}
export function line(a, b) {
  let [x, y] = a;
  const dx = Math.abs(b[0] - x), dy = -Math.abs(b[1] - y);
  const sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1;
  let error = dx + dy;
  const out = [];
  for (;;) {
    out.push([x, y]);
    if (x === b[0] && y === b[1]) return out;
    const e = 2 * error;
    if (e >= dy) { error += dy; x += sx; }
    if (e <= dx) { error += dx; y += sy; }
  }
}
export function shapeCells(mode, a, b, filled = true, thickness = 1) {
  const r = bounds(a, b), out = [];
  const t = Math.max(1, Math.trunc(thickness));
  const ellipse = (x, y, w, h) => w > 0 && h > 0 && ((x + 0.5 - r.w / 2) / (w / 2)) ** 2 + ((y + 0.5 - r.h / 2) / (h / 2)) ** 2 <= 1;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const outer = mode !== "ellipse" || ellipse(x, y, r.w, r.h);
    const inner = mode === "ellipse" ? ellipse(x, y, r.w - t * 2, r.h - t * 2) : x >= t && y >= t && x < r.w - t && y < r.h - t;
    if (outer && (filled || !inner)) out.push([r.x + x, r.y + y]);
  }
  return out;
}
export function capture(doc, r) {
  const codes = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) codes[y * r.w + x] = doc.codes[(r.y + y) * doc.width + r.x + x];
  return { w: r.w, h: r.h, codes, mask: r.mask?.slice() };
}
export function transfer(doc, payload, to, from = null) {
  if (to.x < 0 || to.y < 0 || to.x + payload.w > doc.width || to.y + payload.h > doc.height) return null;
  const codes = doc.codes.slice();
  if (from) for (let y = 0; y < payload.h; y++) for (let x = 0; x < payload.w; x++) if (!payload.mask || payload.mask[y * payload.w + x]) codes[(from.y + y) * doc.width + from.x + x] = 0;
  for (let y = 0; y < payload.h; y++) for (let x = 0; x < payload.w; x++) if (!payload.mask || payload.mask[y * payload.w + x]) codes[(to.y + y) * doc.width + to.x + x] = payload.codes[y * payload.w + x];
  return codes;
}

export function regionSelection(doc, start) {
  const { width: w, height: h, codes } = doc;
  const first = start[1] * w + start[0], value = codes[first];
  const seen = new Uint8Array(codes.length), queue = [first]; seen[first] = 1;
  let x0 = start[0], y0 = start[1], x1 = x0, y1 = y0;
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k], x = i % w, y = Math.floor(i / w);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!seen[n] && codes[n] === value) { seen[n] = 1; queue.push(n); }
    }
  }
  const r = bounds([x0, y0], [x1, y1]), mask = new Uint8Array(r.w * r.h);
  for (const i of queue) mask[(Math.floor(i / w) - r.y) * r.w + i % w - r.x] = 1;
  return { ...r, mask };
}

export function extendSelection(selection, cells) {
  if (!cells.length) return selection;
  let x = selection.x, y = selection.y, right = x + selection.w - 1, bottom = y + selection.h - 1;
  for (const [cx, cy] of cells) { x = Math.min(x, cx); y = Math.min(y, cy); right = Math.max(right, cx); bottom = Math.max(bottom, cy); }
  const r = bounds([x, y], [right, bottom]), mask = new Uint8Array(r.w * r.h);
  for (let cy = selection.y; cy < selection.y + selection.h; cy++) for (let cx = selection.x; cx < selection.x + selection.w; cx++) if (contains(selection, [cx, cy])) mask[(cy - y) * r.w + cx - x] = 1;
  for (const [cx, cy] of cells) mask[(cy - y) * r.w + cx - x] = 1;
  return { ...r, mask };
}

// Grid distance across cardinal neighbours, including holes and map edges.
export function offsetCells(doc, selection, thickness, outward) {
  const { width: w, height: h } = doc, selected = new Uint8Array(w * h);
  for (let y = 0; y < selection.h; y++) for (let x = 0; x < selection.w; x++) if (!selection.mask || selection.mask[y * selection.w + x]) selected[(selection.y + y) * w + selection.x + x] = 1;
  const seen = new Uint8Array(w * h), queue = [], out = [];
  for (let i = 0; i < selected.length; i++) {
    if (!selected[i]) continue;
    const x = i % w, y = Math.floor(i / w);
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !selected[i - 1] || !selected[i + 1] || !selected[i - w] || !selected[i + w];
    if (outward || edge) { seen[i] = 1; queue.push([i, outward ? 0 : 1]); }
  }
  for (let k = 0; k < queue.length; k++) {
    const [i, distance] = queue[k], x = i % w, y = Math.floor(i / w);
    if (distance > 0) out.push([x, y]);
    if (distance >= thickness) continue;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!seen[n] && !!selected[n] !== outward) { seen[n] = 1; queue.push([n, distance + 1]); }
    }
  }
  return out;
}
