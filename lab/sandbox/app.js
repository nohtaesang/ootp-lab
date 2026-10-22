// 상황 놀이터 실험실(#1873) — playfield.wasm 이 그린 시간표를 위에서 본 2D 로 재생한다. 프레임워크 없음.
// 판정은 전부 코어(wasm)가 한다. 이 파일은 그리기 · 재생 · 입력만.
'use strict';

const NAMES = ['투', '포', '1', '2', '3', '유', '좌', '중', '우'];
const POSNAME = ['투수', '포수', '1루수', '2루수', '3루수', '유격수', '좌익수', '중견수', '우익수'];
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
let SCENE = null;
// 판정 판(review.json · ?round=r2-1) — 판 안의 장면만 돈다 · 장면마다 지난번 판정과 메모 · 바뀐 선수 · 메모에 나온 선수
let ROUND = null;
let ITEM = null;
let WHO = [];
// 친구 화면은 판정에 필요한 것만 — ?dev 면 개발 도구(낙하점 X · 부품 번호 · 놓기 · 목록 · 배속)도 보인다
const DEV = new URLSearchParams(location.search).has('dev');

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
  error: tok('--danger-text', '#ff6b6b'),
};

// ── 좌표: 홈 원점 · +y 중견 · +x 1루 쪽 ─────────────────────
const VIEW = { x0: -100, x1: 100, y0: -22, y1: 132 };
// 그림용 치수(m · 모양만 · 판정과 무관): 내야 흙 원호 반지름(투수판 기준) · 안쪽 잔디 비율 · 마운드 · 홈 흙 · 바둑알 · 공
const LOOK = { landR: 4.0, bounceS: 1.5, catchS: 0.9, skin: 29, infieldGrass: 0.8, mound: 2.7, home: 4, bag: 0.6, token: 1.1, ball: 0.4, ballGrow: 0.04, groundZ: 0.3, trailStep: 0.05, trailN: 8, errorS: 1.2 };
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
  if (mark && DEV) {
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
    const ring = (color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(sx(x), sy(y), Math.max(7, LOOK.token * S.k) + w + 2, 0, Math.PI * 2); ctx.stroke(); };
    if (ITEM && ITEM.changed.includes(i + 1)) ring(C.chalk, 2);
    if (WHO.includes(i + 1)) ring(C.error, 3);
    if (showParts && plan) {
      ctx.fillStyle = C.text;
      ctx.font = `600 ${Math.max(10, Math.round(0.9 * S.k))}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(plan.roles[i].part, sx(x) + Math.max(9, 1.4 * S.k), sy(y) - Math.max(9, 1.4 * S.k));
    }
  });
  // 공: 실제 자리에 그린다(높이를 화면 위로 올리면 중견 쪽 뜬공이 담장을 넘었다 돌아오는 착시 — 친구 r1 4 · 5 · 6 · 9 경계).
  // 높이 = 떨어질 자리 원이 줄어드는 정도 + 공 크기 · 속도 = 지나온 꼬리의 길이(친구 답 「높이와 그림자 · 속도에 따른 꼬리」 · 그림자는 탑다운에서 공 밑이라 뺐다).
  // 땅에 붙어 굴러가면 꼬리가 땅 자국처럼 남는다(16 · 20 경계 「땅볼인지 알기 힘듦」).
  const tb = Math.min(t, TL.ball.length ? TL.ball[TL.ball.length - 1][0] : 0);
  const [bx, by, bz] = at(TL.ball, tb);
  // 뜬 공이 떨어질 자리 — 큰 반투명 원에서 공이 내려올수록 공 크기로 줄고, 잡거나 땅에 닿으면 사라진다
  // (사용자 2026-10-22 「큰 원으로 있다가 점점 낙하할 때 공의 크기로 작아져야」 · 친구 r2-2 22 「공이 왜 뚝 떨어짐?」 · 3 「바운드된 공 잡는 느낌」)
  // 잡힌 뜬공도 떨어질 자리가 있다(TL.land = 공 길이 처음 땅에 닿는 [t, x, y]) — 없던 옛 시간표는 공 자취에서 찾는다
  const first = TL.land ? [TL.land[0], TL.land[1], TL.land[2]] : TL.ball.find((q) => q[0] > 0.15 && q[3] <= 0.05);
  const caught = TL.events.find((e) => e.kind === 'catch');
  if (first && TL.launch >= 8) {
    const gone = Math.min(first[0], caught ? caught.t : Infinity);
    if (t < gone) {
      const big = Math.max(10, LOOK.landR * S.k);
      const small = Math.max(3, LOOK.ball * S.k);
      const left = Math.max(0, (first[0] - t) / first[0]);
      const rad = small + (big - small) * left;
      ctx.fillStyle = C.chalk;
      ctx.globalAlpha = 0.18 + 0.12 * (1 - left);
      ctx.beginPath();
      ctx.arc(sx(first[1]), sy(first[2]), rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  const rr = Math.max(3, (LOOK.ball + bz * LOOK.ballGrow) * S.k);
  // 완전 탑다운 — 공 점이 곧 땅 위 자리라 따로 미는 그림자는 그리지 않는다. 높이는 떨어질 자리 원(줄어드는 정도)과 공 크기로 본다
  // (사용자 2026-10-22 「그림자는 그라운드 어디에 투영되는지 알려고 쓰는 거 아니야? 너무 헷갈려」 — 비스듬한 그림자는 땅 위치가 아니라 높이 눈금이라 헷갈렸다)
  if (TL.ball.length && t < TL.ball[TL.ball.length - 1][0] + LOOK.trailStep) {
    const pts = [];
    for (let k = LOOK.trailN; k >= 0; k--) {
      const tt = tb - k * LOOK.trailStep;
      if (tt >= 0) pts.push(at(TL.ball, tt));
    }
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [cx, cy, cz] = pts[k];
      ctx.strokeStyle = C.chalk;
      ctx.globalAlpha = (k / pts.length) * (cz < LOOK.groundZ ? 0.6 : 0.55);
      ctx.lineWidth = Math.max(2, (cz < LOOK.groundZ ? 0.22 : 0.35) * S.k);
      ctx.beginPath();
      ctx.moveTo(sx(ax), sy(ay));
      ctx.lineTo(sx(cx), sy(cy));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(sx(bx), sy(by), rr, 0, Math.PI * 2);
  ctx.fillStyle = C.chalk;
  ctx.fill();
  // 포구 순간 — 잡은 사람 둘레에 퍼지는 고리(공중에서 잡음 · 친구 r2-2 4 「확실히 잡았다는 표현」)
  for (const e of TL.events) {
    if (e.kind !== 'catch' || e.fielder == null || t < e.t || t > e.t + LOOK.catchS) continue;
    const f = TL.fielders[e.fielder - 1];
    if (!f) continue;
    const [fx, fy] = at(f.pts, e.t);
    const k = (t - e.t) / LOOK.catchS;
    ctx.strokeStyle = C.chalk;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx(fx), sy(fy), Math.max(9, LOOK.token * S.k) * (1.3 + 1.2 * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // 내야 다이빙 — 그 선수 아래에 「다이빙」(엔진이 몸을 던져 닿았다고 한 순간만 · 사용자 2026-10-22)
  for (const e of TL.events) {
    if (e.kind !== 'dive' || t < e.t || t > e.t + LOOK.errorS || e.fielder == null) continue;
    const f = TL.fielders.find((x) => x.id === e.fielder);
    if (!f) continue;
    const [fx, fy] = at(f.pts, t);
    const head = Math.max(9, LOOK.token * S.k);
    ctx.fillStyle = C.chalk;
    ctx.font = `800 ${Math.max(12, Math.round(1.6 * S.k))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.strokeText('다이빙', sx(fx), sy(fy) + head + 2);
    ctx.fillText('다이빙', sx(fx), sy(fy) + head + 2);
  }
  // 실책 · 실투 — 그 선수 머리 위에 빨간 느낌표(잠깐 · 사용자 2026-10-22). 첫 실책은 기록된 사람(송구 실책이면 던진 사람), 그 뒤는 놓친 사람
  let firstMiss = true;
  for (const e of TL.events) {
    if (e.kind !== 'miss') continue;
    const who = firstMiss && TL.result.error ? TL.result.error.pos : e.fielder;
    firstMiss = false;
    if (t < e.t || t > e.t + LOOK.errorS || who == null) continue;
    const f = TL.fielders[who - 1];
    if (!f) continue;
    const [fx, fy] = at(f.pts, t);
    const head = Math.max(9, LOOK.token * S.k);
    ctx.fillStyle = C.error;
    ctx.font = `900 ${Math.max(22, Math.round(3.2 * S.k))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.strokeText('!', sx(fx), sy(fy) - head - 2);
    ctx.fillText('!', sx(fx), sy(fy) - head - 2);
  }
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
  if (SCENE) $('#title').textContent = t >= TL.end_t ? `${SCENE.rank}. ${SCENE.family} · ${VLABEL[SCENE.variant]}` : situation(SCENE);
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

// 친구 판정(#1873) — 「이 장면」: 괜찮다 / 애매하다(질문) / 어색하다를 누르는 순간 이 브라우저에 저장된다(다시 누르면 지움 · 한 줄은 쓰는 대로 저장).
// 저장 값 = 판정 · 한 줄 · 누른 순간의 재생 시각 · 장면 지문. 「전체 복사」가 모든 장면 판정을 글로 낸다(서버 없음 — 친구가 그 글을 보낸다).
// 엔진이 바뀌어 지문이 달라지면 그 장면에 「옛 장면」이 붙는다. 변형 단추 · 장면 목록에 판정 표시(✓ 괜찮다 · ? 애매하다 · ✗ 어색하다).
const VKEY = 'playfield-verdicts-v1';
let pick = null;
function loadV() { try { return JSON.parse(localStorage.getItem(VKEY) || '{}'); } catch { return {}; } }
function saveV(v) { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* 저장 못 해도 복사는 된다 */ } }
let VERD = loadV();
function sceneKey() { return placing || !TL ? null : `${ROUND ? ROUND.id + ':' : ''}${$('#scene').value}-${variant}`; }
const bare = (k) => k.replace(/^[^:]*:/, '');
const inRound = (k) => (ROUND ? k.startsWith(ROUND.id + ':') : !k.includes(':'));
function fingerprint() {
  // 사건 + 움직임(0.5m · 0.1초로 반올림) — 움직임만 바뀌어도 「옛 장면」이 된다
  if (!TL) return '';
  const q = (v, s) => Math.round(v / s);
  const body = JSON.stringify([TL.events, [...TL.fielders, ...TL.runners].map((k) => k.pts.map((p) => [q(p[0], 0.1), q(p[1], 0.5), q(p[2], 0.5)]))]);
  let h = 2166136261;
  for (const c of body) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}
const MARK = { ok: ' ✓', ask: ' ?', odd: ' ✗' };
const JLABEL = { ok: '괜찮다', ask: '애매하다(질문)', odd: '어색하다' };
const VLABEL = { normal: '보통', borderline: '경계', error: '실책' };
function refreshV() {
  const k = sceneKey();
  const v = k ? VERD[k] : null;
  pick = v ? v.j : null;
  $('#verdict').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.j === pick));
  if (document.activeElement !== $('#vnote')) $('#vnote').value = v ? v.note : '';
  $('#vnote').placeholder = pick === 'ask' ? '질문' : '누가 · 언제 · 무엇';
  $('#vstale').textContent = v && v.fp !== fingerprint() ? '옛 장면' : '';
  const pool = ROUND ? ROUND.items.map((it) => it.key) : SCENES.map((x) => `${x.rank}-${x.variant}`);
  $('#vcount').textContent = `${pool.filter((kk) => VERD[(ROUND ? ROUND.id + ':' : '') + kk]).length} / ${pool.length}`;
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
    else VERD[k] = { j: btn.dataset.j, note: $('#vnote').value.trim(), at: Number(t.toFixed(1)), fp: fingerprint(), who: [...WHO] };
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
      .filter(([k]) => inRound(k))
      .map(([k, v]) => [bare(k), v])
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([k, v]) => { const [rank, vv] = k.split('-'); const who = v.who && v.who.length ? ' · 누구 ' + v.who.map((p) => POSNAME[p - 1]).join('·') : ''; return `${rank} ${name(rank)} · ${vname[vv]} · ${JLABEL[v.j]} · ${v.at}초${who}${v.note ? ' · ' + v.note : ''} · ${v.fp}`; })
      .join('\n');
    const out = (ROUND ? `판 ${ROUND.id}\n` : '') + text;
    try { await navigator.clipboard.writeText(out); } catch { prompt('', out); return; }
    $('#vcopy').textContent = '복사됨';
    setTimeout(() => { $('#vcopy').textContent = '전체 복사'; }, 1500);
  });
}

// 이전 · 다음 순서 = 변형 먼저(보통 1~31 → 경계 1~31 → 실책 1~31) — 친구가 보통부터 훑게 한다.
const ORDER = ['normal', 'borderline', 'error'];
function sequence() {
  if (ROUND) return ROUND.items.map((it) => { const [rank, v] = it.key.split('-'); return SCENES.find((s) => String(s.rank) === rank && s.variant === v); }).filter(Boolean);
  return ORDER.flatMap((v) => SCENES.filter((s) => s.variant === v).sort((a, b) => a.rank - b.rank));
}
function step(d) {
  const seq = sequence();
  const i = seq.findIndex((s) => String(s.rank) === $('#scene').value && s.variant === variant);
  const n = seq[(i + d + seq.length) % seq.length];
  $('#scene').value = String(n.rank);
  variant = n.variant;
  $('#variant').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === variant));
  runScene();
}

// 재생 중 제목은 상황만(주자 · 아웃 · 변형) — 결과를 미리 말하지 않는다(8 경계 「설명과 다르다」 · 결과는 끝난 뒤 제목과 칩으로)
function situation(s) {
  const r = (s.input.runners || []).map((x) => x.base).sort();
  const on = r.length ? `주자 ${r.join('·')}루` : '주자 없음';
  return `${s.rank}. ${on} · ${s.input.outs || 0}아웃 · ${VLABEL[s.variant]}`;
}

function runScene() {
  const rank = Number($('#scene').value);
  const s = SCENES.find((x) => x.rank === rank && x.variant === variant);
  if (!s) return;
  const seq = sequence();
  $('#pos').textContent = `${ROUND ? ROUND.name + ' · ' : ''}${seq.indexOf(s) + 1} / ${seq.length}`;
  SCENE = s;
  ITEM = ROUND ? ROUND.items.find((it) => it.key === `${s.rank}-${s.variant}`) || null : null;
  const sv = VERD[`${ROUND ? ROUND.id + ':' : ''}${s.rank}-${s.variant}`];
  WHO = sv && sv.who ? [...sv.who] : [];
  $('#prevBox').classList.toggle('hide', !(ITEM && ITEM.prev));
  if (ITEM && ITEM.prev) $('#prevNote').textContent = `${JLABEL[ITEM.prev.j]}${ITEM.prev.note ? ' · ' + ITEM.prev.note : ''}`;
  const ch = ITEM ? ITEM.changed.map((p) => POSNAME[p - 1]) : [];
  $('#changed').textContent = ch.length ? `바뀐 선수 ${ch.join(' · ')}` : '';
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
    if (!placing) {
      // 선수 점을 누르면 「누구」 표시(다시 누르면 지움) — 판정과 함께 저장된다
      if (!TL) return;
      const rc = canvas.getBoundingClientRect();
      const px = (e.clientX - rc.left) * S.dpr, py = (e.clientY - rc.top) * S.dpr;
      const rad = Math.max(7, LOOK.token * S.k) * 1.6;
      let best = null;
      TL.fielders.forEach((f, i) => { const [x, y] = at(f.pts, t); const d = Math.hypot(sx(x) - px, sy(y) - py); if (d < rad && (!best || d < best.d)) best = { d, pos: i + 1 }; });
      if (!best) return;
      WHO = WHO.includes(best.pos) ? WHO.filter((p) => p !== best.pos) : [...WHO, best.pos].sort((a, b) => a - b);
      const k = sceneKey();
      if (k && VERD[k]) { VERD[k].who = [...WHO]; saveV(VERD); }
      return;
    }
    const r = canvas.getBoundingClientRect();
    const x = wx((e.clientX - r.left) * S.dpr);
    const y = wy((e.clientY - r.top) * S.dpr);
    mark = [x, y];
    const runners = [1, 2, 3].filter((b) => $(`#r${b}`).checked).map((base) => ({ base }));
    show({ ball: { ev: Number($('#ev').value), aim: { kind, x, y } }, runners, outs: Number($('#outs').value), seed: Number($('#seed').value) });
  });
  window.addEventListener('resize', draw);
  // 친구 화면은 장면 · 이전/다음 · 판정 · 재생바 · 전체 복사뿐이다. 변형 단추 · 목록 · 배속 · 부품 번호 · 놓기는 주소 끝에 ?dev 를 붙이면 보인다.
  if (new URLSearchParams(location.search).has('dev')) document.querySelectorAll('#tools, .dev').forEach((x) => x.classList.remove('hide'));
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select')) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
    else if (['1', '2', '3'].includes(e.key)) $('#verdict').querySelectorAll('button')[Number(e.key) - 1].click();
  });
  try {
    const id = new URLSearchParams(location.search).get('round');
    if (id) {
      const rv = await (await fetch('review.json')).json();
      ROUND = rv.rounds.find((x) => x.id === id) || null;
      if (ROUND && ROUND.items.length) { const [rank, v] = ROUND.items[0].key.split('-'); $('#scene').value = rank; variant = v; }
    }
  } catch { ROUND = null; }
  verdicts();
  runScene();
  requestAnimationFrame((now) => { last = now; tick(now); });
}

boot().catch((e) => console.error(e));
