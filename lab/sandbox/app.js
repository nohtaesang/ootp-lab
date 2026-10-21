// 상황 놀이터 실험실(#1873) — playfield.wasm 이 그린 시간표를 위에서 본 2D 로 재생한다. 프레임워크 없음.
// 판정은 전부 코어(wasm)가 한다. 이 파일은 그리기 · 재생 · 입력만.
'use strict';

const NAMES = ['투', '포', '1', '2', '3', '유', '좌', '중', '우'];
const RUNNER = ['타', '1', '2', '3'];
const $ = (s) => document.querySelector(s);
const canvas = $('#field');
const ctx = canvas.getContext('2d');

let wasm = null;
let FIELD = null;
let SCENES = [];
let TL = null;
let mark = null;
let t = 0;
let playing = false;
let rate = 1;
let last = 0;
let variant = 'normal';
let placing = false;
let showParts = false;
let kind = 'ground';

// ── wasm 맨 ABI(app-wasm 과 같다) ──────────────────────────
function call(fn, input) {
  const ex = wasm.exports;
  let out;
  if (input !== undefined) {
    const bytes = new TextEncoder().encode(input);
    const p = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
    out = ex[fn](p, bytes.length);
  } else {
    out = ex[fn]();
  }
  const len = new DataView(ex.memory.buffer).getUint32(out, true);
  const text = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, out + 4, len));
  ex.dealloc(out, 4 + len);
  return JSON.parse(text);
}

// ── 색(토큰이 없으면 기본값) ──────────────────────────────
const css = getComputedStyle(document.documentElement);
const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const C = {
  bg: tok('--bg-canvas', '#1d1d1f'),
  grass: tok('--ground-grass', '#2f5d3a'),
  mow: tok('--ground-mow', '#2a5233'),
  dirt: tok('--ground-dirt', '#8a6a4a'),
  wall: tok('--ground-wall', '#3a3a3c'),
  chalk: tok('--ground-chalk', '#f2f2f2'),
  text: tok('--text-normal', '#f5f5f5'),
  fielder: tok('--primary', '#5b5bd6'),
  runner: tok('--attention-solid', '#e0a030'),
  on: tok('--primary-on', '#ffffff'),
};

// ── 좌표: 홈 원점 · +y 중견 · +x 1루 쪽 ─────────────────────
const VIEW = { x0: -100, x1: 100, y0: -22, y1: 132 };
// 그림용 치수(m · 모양만 · 판정과 무관): 내야 흙 원호 반지름(투수판 기준) · 안쪽 잔디 비율 · 마운드 · 홈 흙 · 바둑알 · 공
const LOOK = { skin: 29, infieldGrass: 0.8, mound: 2.7, home: 4, bag: 0.6, token: 1.1, ball: 0.4, ballGrow: 0.04, lift: 0.5 };
let S = { k: 1, ox: 0, oy: 0, dpr: 1 };
function fit() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  const k = Math.min(canvas.width / (VIEW.x1 - VIEW.x0), canvas.height / (VIEW.y1 - VIEW.y0));
  S = { k, dpr, ox: (canvas.width - k * (VIEW.x1 - VIEW.x0)) / 2, oy: (canvas.height - k * (VIEW.y1 - VIEW.y0)) / 2 };
}
const sx = (x) => S.ox + (x - VIEW.x0) * S.k;
const sy = (y) => S.oy + (VIEW.y1 - y) * S.k;
const wx = (px) => (px - S.ox) / S.k + VIEW.x0;
const wy = (py) => VIEW.y1 - (py - S.oy) / S.k;

function poly(pts, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
  if (close) ctx.closePath();
}
function circle(x, y, r) {
  ctx.beginPath();
  ctx.arc(sx(x), sy(y), r, 0, Math.PI * 2);
}

function drawField() {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const f = FIELD;
  const fence = f.fence;
  const lf = fence[0];
  const rf = fence[fence.length - 1];
  // 파울 지역 · 페어 지역
  const room = f.foul_room;
  const n = (v) => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
  const ul = n(lf), ur = n(rf);
  const pl = [-ul[1], ul[0]], pr = [ur[1], -ur[0]];
  poly([[lf[0] + pl[0] * room, lf[1] + pl[1] * room], [pl[0] * room - ul[0] * room, -f.back_room], [pr[0] * room - ur[0] * room, -f.back_room], [rf[0] + pr[0] * room, rf[1] + pr[1] * room], ...fence.slice().reverse()]);
  ctx.fillStyle = C.mow;
  ctx.fill();
  poly([[0, 0], ...fence]);
  ctx.fillStyle = C.grass;
  ctx.fill();
  // 내야 흙(투수판에서 반지름 29 m 원호 · 페어 안) · 안쪽 잔디
  ctx.save();
  poly([[0, 0], ...fence]);
  ctx.clip();
  const [mx, my] = f.mound;
  circle(mx, my, LOOK.skin * S.k);
  ctx.fillStyle = C.dirt;
  ctx.fill();
  ctx.restore();
  const b = f.bags;
  const cy = b[2][1] / 2;
  poly(b.map(([x, y]) => [x * LOOK.infieldGrass, cy + (y - cy) * LOOK.infieldGrass]));
  ctx.fillStyle = C.grass;
  ctx.fill();
  circle(mx, my, LOOK.mound * S.k);
  ctx.fillStyle = C.dirt;
  ctx.fill();
  circle(0, 0, LOOK.home * S.k);
  ctx.fill();
  // 담장 · 파울라인
  poly(fence, false);
  ctx.strokeStyle = C.wall;
  ctx.lineWidth = Math.max(3, 1.2 * S.k);
  ctx.stroke();
  ctx.strokeStyle = C.chalk;
  ctx.lineWidth = Math.max(1, 0.15 * S.k);
  poly([lf, [0, 0], rf], false);
  ctx.stroke();
  // 루
  const s = Math.max(4, LOOK.bag * S.k);
  ctx.fillStyle = C.chalk;
  for (const [x, y] of b) {
    ctx.save();
    ctx.translate(sx(x), sy(y));
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }
}

// ── 시간표 읽기 ─────────────────────────────────────────
function at(pts, tt) {
  if (!pts.length) return [0, 0, 0];
  if (tt <= pts[0][0]) return pts[0].slice(1);
  let lo = 0, hi = pts.length - 1;
  if (tt >= pts[hi][0]) return pts[hi].slice(1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= tt) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const k = (tt - a[0]) / Math.max(1e-9, b[0] - a[0]);
  return a.slice(1).map((v, i) => v + (b[i + 1] - v) * k);
}

function token(x, y, fill, label, alpha) {
  const r = Math.max(7, LOOK.token * S.k);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(sx(x), sy(y), r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = C.text;
  ctx.stroke();
  ctx.fillStyle = C.on;
  ctx.font = `600 ${Math.round(r * 1.05)}px ${css.getPropertyValue('--font-sans') || 'sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, sx(x), sy(y) + r * 0.05);
  ctx.globalAlpha = 1;
}

function draw() {
  fit();
  if (!FIELD) return;
  drawField();
  if (mark) {
    const r = Math.max(6, 1.2 * S.k);
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx(mark[0]) - r, sy(mark[1]) - r); ctx.lineTo(sx(mark[0]) + r, sy(mark[1]) + r);
    ctx.moveTo(sx(mark[0]) + r, sy(mark[1]) - r); ctx.lineTo(sx(mark[0]) - r, sy(mark[1]) + r);
    ctx.stroke();
  }
  if (!TL) return;
  const outAt = {};
  for (const e of TL.events) if (e.kind === 'out' && e.runner != null) outAt[e.runner] = e.t;
  for (const r of TL.runners) {
    const [x, y] = at(r.pts, t);
    const out = outAt[r.id] != null && t >= outAt[r.id];
    token(x, y, C.runner, RUNNER[r.id], out ? 0.35 : 1);
  }
  let plan = null;
  for (const p of TL.plans) if (p.t <= t) plan = p;
  TL.fielders.forEach((f, i) => {
    const [x, y] = at(f.pts, t);
    token(x, y, C.fielder, NAMES[i], 1);
    if (showParts && plan) {
      ctx.fillStyle = C.text;
      ctx.font = `600 ${Math.max(10, Math.round(0.9 * S.k))}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(plan.roles[i].part, sx(x) + Math.max(9, 1.4 * S.k), sy(y) - Math.max(9, 1.4 * S.k));
    }
  });
  // 공: 그림자(땅) + 높이만큼 떠 있는 공
  const [bx, by, bz] = at(TL.ball, Math.min(t, TL.ball.length ? TL.ball[TL.ball.length - 1][0] : 0));
  const rr = Math.max(3, (LOOK.ball + bz * LOOK.ballGrow) * S.k);
  ctx.globalAlpha = Math.max(0.15, 0.45 - bz * 0.01);
  ctx.beginPath();
  ctx.ellipse(sx(bx), sy(by), Math.max(3, 0.45 * S.k), Math.max(2, 0.3 * S.k), 0, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(sx(bx), sy(by) - bz * S.k * LOOK.lift, rr, 0, Math.PI * 2);
  ctx.fillStyle = C.chalk;
  ctx.fill();
  // 결과는 플레이가 끝난 뒤에만
  const box = $('#result');
  if (t >= TL.end_t) {
    const r = TL.result;
    const chips = [r.label, r.code].filter(Boolean);
    if (r.runs > 0) chips.push(`${r.runs}점`);
    box.innerHTML = chips.map((c) => `<span>${c}</span>`).join('');
    box.classList.remove('hide');
  } else {
    box.classList.add('hide');
  }
  $('#clock').textContent = t.toFixed(1);
  $('#scrub').value = String(Math.round((t / TL.duration) * 1000));
}

function tick(now) {
  if (playing && TL) {
    t = Math.min(TL.duration, t + ((now - last) / 1000) * rate);
    if (t >= TL.duration) setPlaying(false);
  }
  last = now;
  draw();
  requestAnimationFrame(tick);
}

function setPlaying(on) {
  playing = on;
  $('#play').textContent = on ? '❚❚' : '▶';
}

function show(input) {
  const res = call('run', JSON.stringify(input));
  if (res.error) {
    console.error(res.error);
    return;
  }
  TL = res;
  t = 0;
  setPlaying(true);
  refreshV();
}

// 친구 판정(#1873) — 「이 장면」: 괜찮다 / 이상하다를 누르는 순간 이 브라우저에 저장된다(다시 누르면 지움 · 한 줄은 쓰는 대로 저장).
// 저장 값 = 판정 · 한 줄 · 누른 순간의 재생 시각 · 장면 지문. 「전체 복사」가 모든 장면 판정을 글로 낸다(서버 없음 — 친구가 그 글을 보낸다).
// 엔진이 바뀌어 지문이 달라지면 그 장면에 「옛 장면」이 붙는다. 변형 단추 · 장면 목록에 판정 표시(✓ 괜찮다 · ✗ 이상하다).
const VKEY = 'playfield-verdicts-v1';
let pick = null;
function loadV() { try { return JSON.parse(localStorage.getItem(VKEY) || '{}'); } catch { return {}; } }
function saveV(v) { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* 저장 못 해도 복사는 된다 */ } }
let VERD = loadV();
function sceneKey() { return placing || !TL ? null : `${$('#scene').value}-${variant}`; }
function fingerprint() {
  let h = 2166136261;
  for (const c of JSON.stringify(TL ? TL.events || TL : '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}
const MARK = { ok: ' ✓', odd: ' ✗' };
const VLABEL = { normal: '보통', borderline: '경계', error: '실책' };
function refreshV() {
  const k = sceneKey();
  const v = k ? VERD[k] : null;
  pick = v ? v.j : null;
  $('#verdict').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.j === pick));
  if (document.activeElement !== $('#vnote')) $('#vnote').value = v ? v.note : '';
  $('#vstale').textContent = v && v.fp !== fingerprint() ? '옛 장면' : '';
  $('#vcount').textContent = `${Object.keys(VERD).length} / ${SCENES.length}`;
  $('#verdictBox').classList.toggle('hide', !k);
  const rank = $('#scene').value;
  $('#variant').querySelectorAll('button').forEach((b) => { const w = VERD[`${rank}-${b.dataset.v}`]; b.textContent = VLABEL[b.dataset.v] + (w ? MARK[w.j] : ''); });
  for (const o of $('#scene').options) {
    const n = Object.keys(VLABEL).filter((vv) => VERD[`${o.value}-${vv}`]).length;
    const base = o.dataset.name || (o.dataset.name = o.textContent);
    o.textContent = n ? `${base} · ${n}/3` : base;
  }
}
function verdicts() {
  $('#verdict').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const k = sceneKey();
    if (!btn || !k) return;
    if (VERD[k] && VERD[k].j === btn.dataset.j) delete VERD[k];
    else VERD[k] = { j: btn.dataset.j, note: $('#vnote').value.trim(), at: Number(t.toFixed(1)), fp: fingerprint() };
    saveV(VERD);
    refreshV();
  });
  $('#vnote').addEventListener('input', () => {
    const k = sceneKey();
    if (!k || !VERD[k]) return;
    VERD[k].note = $('#vnote').value.trim();
    saveV(VERD);
  });
  $('#vcopy').addEventListener('click', async () => {
    const name = (rank) => (SCENES.find((s) => String(s.rank) === rank) || {}).family || '';
    const vname = { normal: '보통', borderline: '경계', error: '실책' };
    const text = Object.entries(VERD)
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([k, v]) => { const [rank, vv] = k.split('-'); return `${rank} ${name(rank)} · ${vname[vv]} · ${v.j === 'ok' ? '괜찮다' : '이상하다'} · ${v.at}초${v.note ? ' · ' + v.note : ''} · ${v.fp}`; })
      .join('\n');
    try { await navigator.clipboard.writeText(text); } catch { prompt('', text); return; }
    $('#vcopy').textContent = '복사됨';
    setTimeout(() => { $('#vcopy').textContent = '전체 복사'; }, 1500);
  });
}

function runScene() {
  const rank = Number($('#scene').value);
  const s = SCENES.find((x) => x.rank === rank && x.variant === variant);
  if (!s) return;
  const b = s.input.ball;
  mark = b.aim ? [b.aim.x, b.aim.y] : null;
  show(s.input);
}

function seg(id, attr, onPick) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
    onPick(btn.dataset[attr]);
  });
}

async function boot() {
  const bytes = await (await fetch('playfield.wasm')).arrayBuffer();
  wasm = (await WebAssembly.instantiate(bytes, {})).instance;
  FIELD = call('field');
  SCENES = call('scenes');
  const sel = $('#scene');
  for (const s of SCENES.filter((x) => x.variant === 'normal')) {
    const o = document.createElement('option');
    o.value = String(s.rank);
    o.textContent = `${s.rank} ${s.family}`;
    sel.append(o);
  }
  sel.addEventListener('change', runScene);
  seg('#variant', 'v', (v) => { variant = v; runScene(); });
  seg('#rate', 'r', (r) => { rate = Number(r); });
  seg('#kind', 'k', (k) => { kind = k; });
  $('#play').addEventListener('click', () => {
    if (!TL) return;
    if (t >= TL.duration) t = 0;
    setPlaying(!playing);
  });
  $('#scrub').addEventListener('input', (e) => {
    if (!TL) return;
    setPlaying(false);
    t = (Number(e.target.value) / 1000) * TL.duration;
  });
  $('#parts').addEventListener('click', (e) => {
    showParts = !showParts;
    e.target.classList.toggle('on', showParts);
  });
  $('#place').addEventListener('click', (e) => {
    placing = !placing;
    e.target.classList.toggle('on', placing);
    $('#placeBox').classList.toggle('hide', !placing);
    $('#stage').classList.toggle('placing', placing);
    refreshV();
  });
  canvas.addEventListener('click', (e) => {
    if (!placing) return;
    const r = canvas.getBoundingClientRect();
    const x = wx((e.clientX - r.left) * S.dpr);
    const y = wy((e.clientY - r.top) * S.dpr);
    mark = [x, y];
    const runners = [1, 2, 3].filter((b) => $(`#r${b}`).checked).map((base) => ({ base }));
    show({ ball: { ev: Number($('#ev').value), aim: { kind, x, y } }, runners, outs: Number($('#outs').value), seed: Number($('#seed').value) });
  });
  window.addEventListener('resize', draw);
  verdicts();
  runScene();
  requestAnimationFrame((now) => { last = now; tick(now); });
}

boot().catch((e) => console.error(e));
