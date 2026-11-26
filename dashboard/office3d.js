// The live 3D office (Three.js), built from the office's own people:
// the boss in a glass room, the PA just outside it, customer-service staff at the
// booth outside, everyone else at desks (up to 8) in a tidy grid. One WebGL renderer is kept
// for the page's whole life; status and the customer queue update the live scene in place.
// Floor coords: x (right-down), y (left-down), z (up)  ->  Three: X = x, Y = z, Z = y.
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

const W = 14, D = 11.5;
const BOSS = { colour: '#8338EC', skin: '#EBBE93', hair: '#3A2A22' };
// desk slots in the team area: a grid of 3 per row, filled row by row. Row 1 starts below the boss
// room's glass (the walking lane runs behind each row). The last row has 2: the meeting table is there.
const COLS = [4.8, 7.9, 11.0], ROWS = [4.4, 6.95, 9.5];
// slot = [x, y, turn]. turn is a quarter turn (0..3) of the whole desk about its slot point: 0 is the layout as drawn.
const SLOTS = ROWS.flatMap((y) => COLS.map((x) => [x, y, 0])).slice(0, 8);
// quarter turns in floor coords, [a, b, c, d]: (dx, dy) -> (a*dx + b*dy, c*dx + d*dy). Turn 1 is (dx, dy) -> (-dy, dx).
const TURN = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
export function turnVec(q, dx, dy) { const [a, b, c, d] = TURN[q & 3]; return [a * dx + b * dy, c * dx + d * dy]; }
// lowest corner of a rotated box (corner lx,ly, size w x d, in desk-relative floor coords)
function minCorner(q, lx, ly, w, d) {
  const pts = [[lx, ly], [lx + w, ly], [lx, ly + d], [lx + w, ly + d]].map(([px, py]) => turnVec(q, px, py));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
}
// Where a person stands, walks and sits for a desk turned by r.home.turn. Pure, so the route check can run in node.
export const AISLE = 4.2;
export function walkPoints(r, D) {
  const FRONT = D - 0.4;
  if (r.kind === 'booth') return { side: { x: 3.35, z: r.home.z }, spot: { x: 3.6, z: D + 1.05 }, visit: { x: 3.75, z: D + 1.1 }, approach: [], lane: [{ x: 6.3, z: D + 1.05 }, { x: 6.3, z: FRONT }, { x: AISLE, z: FRONT }] };
  const at = (dx, dy) => { const [ux, uy] = turnVec(r.home.turn || 0, dx, dy); return { x: r.home.x + ux, z: r.home.z + uy }; };
  const spot = at(-0.75, -0.6), visit = at(0.85, -0.1);
  return { side: at(-0.75, 0), spot, visit, approach: [{ x: visit.x, z: spot.z }], lane: [{ x: AISLE, z: spot.z }] };
}
export function routePoints(from, to, D) {
  const f = walkPoints(from, D), t = walkPoints(to, D);
  const pts = [f.side, f.spot, ...f.lane, ...[...t.lane].reverse(), ...t.approach, t.visit];
  return pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.z - pts[i - 1].z) > 0.05);
}
const CS_ROLE = /customer|service|support|reception|front ?desk|help ?desk/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : d);

// Who sits where. Exported so the page can match tags to people.
export function seatPlan(staff) {
  const cs = staff.find((s) => CS_ROLE.test(s.role || ''));
  const rest = staff.filter((s) => s !== cs);
  return { cs: cs || null, desks: rest.slice(0, SLOTS.length).map((s, i) => ({ ...s, slot: SLOTS[i] })) };
}
const STATUS = {
  working: { cls: 'working', icon: 'laptop', label: 'Working' },
  sleeping: { cls: 'sleeping', icon: 'zzz', label: 'Sleeping' },
  waiting: { cls: 'waiting', icon: 'raised_hand', label: 'Waiting for OK' },
};
let EMO_BASE = 'assets/emoji/';
export const setEmojiBase = b => { EMO_BASE = b; };
const EMO = n => `${EMO_BASE}${n}.png`;

function shadeHex(hex, f) {
  const c = new THREE.Color(hex); const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + f))); return '#' + c.getHexString();
}
// white badge text needs >= 4.5:1: darken the role colour until its relative luminance is low enough
function badgeBg(col) {
  const L = (h) => { const c = new THREE.Color(h); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
  let f = -0.18, out = shadeHex(col, f);
  while (L(out) > 0.183 && f > -0.6) out = shadeHex(col, (f -= 0.04));
  return out;
}
const loadImg = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });

// Builds the office into a Group (no camera, no renderer). Used by the images and the video.
export async function buildOffice(opt = {}) {
  const status = opt.status || {};
  const st = (id) => (status[id] && status[id].status) || 'sleeping';
  const plan = seatPlan(opt.staff || []);
  const pa = opt.pa || { name: 'Manager', colour: '#8338EC', look: { scarf: true, skin: '#F2C9A0' } };
  await document.fonts.load('700 40px Fredoka'); await document.fonts.load('900 20px Nunito');
  const emoji = {};
  for (const n of ['office_building', 'crown']) emoji[n] = await loadImg(EMO(n));

  const scene = new THREE.Group();
  const mats = new Map(), geos = new Map();
  // same shape, same geometry: people and furniture share their buffers (less GPU memory)
  const G = (Cls, ...a) => { const k = Cls.name + a.join(','); if (!geos.has(k)) geos.set(k, new Cls(...a)); return geos.get(k); };
  const mat = (c, o = {}) => {
    const key = c + JSON.stringify(o);
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color: c, roughness: o.r ?? 0.82, metalness: o.m ?? 0, flatShading: !!o.flat, emissive: o.em || '#000', emissiveIntensity: o.ei ?? 0 }));
    return mats.get(key);
  };
  const add = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; scene.add(m); return m; };
  // rounded box in floor coords: corner (x,y,z), size (w,d,h)
  const B = (x, y, z, w, d, h, c, r = 0.06, o = {}) => {
    const rr = Math.max(0.001, Math.min(r, w / 2 - 0.001, d / 2 - 0.001, h / 2 - 0.001));
    const m = new THREE.Mesh(G(RoundedBoxGeometry, w, h, d, 3, rr), typeof c === 'string' ? mat(c, o) : c);
    m.position.set(x + w / 2, z + h / 2, y + d / 2); return add(m, o.cast !== false);
  };
  const CYL = (x, y, z, rt, rb, h, c, seg = 32, o = {}) => {
    const m = new THREE.Mesh(G(THREE.CylinderGeometry, rt, rb, h, seg), typeof c === 'string' ? mat(c, o) : c);
    m.position.set(x, z + h / 2, y); return add(m, o.cast !== false);
  };
  const SPH = (x, y, z, r, c, o = {}) => {
    const m = new THREE.Mesh(G(THREE.SphereGeometry, r, o.seg || 24, o.seg ? Math.round(o.seg * 0.7) : 18), typeof c === 'string' ? mat(c, o) : c);
    m.position.set(x, z, y); return add(m, o.cast !== false);
  };
  const canvasTex = (w, h, draw) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    if (opt.freeCanvas) t.onUpdate = () => { t.onUpdate = null; cv.width = cv.height = 1; }; // the GPU has it now
    return t;
  };
  const texMat = (t, o = {}) => new THREE.MeshStandardMaterial({ map: t, roughness: o.r ?? 0.85, transparent: !!o.transparent });
  // plane on back-right wall (y = const, facing +Z)
  const planeZ = (x1, x2, z1, z2, yoff, material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), material);
    m.position.set((x1 + x2) / 2, (z1 + z2) / 2, yoff); m.receiveShadow = true; scene.add(m); return m;
  };
  // plane on back-left wall (x = const, facing +X); y1 > y2 so text reads left to right
  const planeX = (y1, y2, z1, z2, xoff, material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(y1 - y2), z2 - z1), material);
    m.rotation.y = Math.PI / 2; m.position.set(xoff, (z1 + z2) / 2, (y1 + y2) / 2); m.receiveShadow = true; scene.add(m); return m;
  };
  // flat plane on the floor
  const planeF = (x1, x2, y1, y2, h, material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, y2 - y1), material);
    m.rotation.x = -Math.PI / 2; m.position.set((x1 + x2) / 2, h, (y1 + y2) / 2); m.receiveShadow = true; scene.add(m); return m;
  };

  // ---------------- floor, pavement, walls ----------------
  const plankTex = canvasTex(1400, 1150, (g, w, h) => {
    g.fillStyle = '#F6D7A3'; g.fillRect(0, 0, w, h);
    const tones = ['#F7DAA8', '#F3D29B', '#F8DEAF', '#F1CE95'];
    for (let i = 0; i < 14; i++) for (let j = 0; j < 5; j++) {
      const off = (i % 2) * 115;
      g.fillStyle = tones[(i * 3 + j) % 4]; g.fillRect(i * 100 + 2, j * 230 - off + 2, 96, 226);
    }
    for (let i = 0; i < 14; i++) for (let j = 0; j < 6; j++) {
      const off = (i % 2) * 115; g.fillStyle = tones[(i + j * 2) % 4]; g.fillRect(i * 100 + 2, j * 230 - off + 2, 96, 226);
    }
    g.strokeStyle = 'rgba(190,140,80,.35)'; g.lineWidth = 3;
    for (let i = 0; i <= 14; i++) { g.beginPath(); g.moveTo(i * 100, 0); g.lineTo(i * 100, h); g.stroke(); }
  });
  const floorGeo = new THREE.BoxGeometry(W, 0.35, D);
  const floorSide = mat('#D99E5C');
  const floor = new THREE.Mesh(floorGeo, [mat('#C8894A'), floorSide, texMat(plankTex), floorSide, mat('#D99E5C'), floorSide]);
  floor.position.set(W / 2, -0.175, D / 2); add(floor, false);

  const paveTex = canvasTex(1140, 450, (g, w, h) => {
    g.fillStyle = '#E4EAF4'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#C9D3E3'; g.lineWidth = 4;
    for (let i = 0; i <= 12; i++) { g.beginPath(); g.moveTo(i * 100, 0); g.lineTo(i * 100, h); g.stroke(); }
    for (let j = 0; j <= 4; j++) { g.beginPath(); g.moveTo(0, j * 100 + 10); g.lineTo(w, j * 100 + 10); g.stroke(); }
  });
  // outside: pavement in front of the office (gap = it is not part of the office)
  const pave = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.3, 4.5), [mat('#B7C3D6'), mat('#B7C3D6'), texMat(paveTex), mat('#B7C3D6'), mat('#C9D3E3'), mat('#B7C3D6')]);
  pave.position.set(-0.4 + 5.7, -0.15, D + 0.3 + 2.25); add(pave, false);

  // rug
  const rugTex = canvasTex(770, 680, (g, w, h) => {
    g.fillStyle = '#B9E4F5'; g.beginPath(); g.roundRect(0, 0, w, h, 40); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 8; g.setLineDash([26, 18]); g.beginPath(); g.roundRect(36, 36, w - 72, h - 72, 26); g.stroke();
  });
  const rugM = texMat(rugTex, { transparent: true }); planeF(4.4, 12.9, 2.6, 10.85, 0.012, rugM);
  // welcome mat
  const matTex = canvasTex(600, 180, (g, w, h) => {
    g.fillStyle = '#FF6B6B'; g.beginPath(); g.roundRect(0, 0, w, h, 26); g.fill();
    g.fillStyle = '#fff'; g.font = '700 82px Fredoka'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WELCOME', w / 2, h / 2 + 4);
  });
  planeF(1.2, 4.2, D - 0.95, D - 0.05, 0.014, texMat(matTex, { transparent: true }));

  // walls
  B(-0.35, -0.35, -0.35, 0.35, D + 0.35, 4.65, '#FFF4E6', 0.03, { em: '#FFE9CF', ei: 0.35 });
  B(0, -0.35, -0.35, W, 0.35, 4.65, '#FFE2BC', 0.03);
  B(-0.42, -0.42, 4.28, 0.5, D + 0.47, 0.1, '#FFFFFF', 0.03);
  B(-0.42, -0.42, 4.28, W + 0.47, 0.5, 0.1, '#FFFFFF', 0.03);
  B(0, 0, 0, W, 0.07, 0.26, '#E7B47A', 0.02);
  B(0, 0, 0, 0.07, D, 0.26, '#EDC08C', 0.02);

  // window with city view (back-right wall)
  const cityTex = canvasTex(720, 460, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#7CC6FF'); gr.addColorStop(1, '#CDEBFF');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#FFD84D'; g.beginPath(); g.arc(590, 90, 46, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.9)'; [[120, 90, 38], [165, 80, 46], [210, 92, 34]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); });
    const bl = [[20, 240], [100, 330], [175, 200], [240, 360], [320, 250], [395, 300], [470, 210], [545, 280], [620, 230]];
    bl.forEach(([x, bh], i) => {
      g.fillStyle = i % 2 ? '#5BA8E0' : '#4C93CF'; g.fillRect(x, h - bh, 70, bh);
      g.fillStyle = 'rgba(255,255,255,.55)';
      for (let r = h - bh + 16; r < h - 10; r += 30) for (let c = x + 10; c < x + 60; c += 20) g.fillRect(c, r, 10, 14);
    });
  });
  B(0.5, 0.0, 1.2, 3.8, 0.12, 2.5, '#FFFFFF', 0.04);
  planeZ(0.65, 4.15, 1.35, 3.55, 0.125, texMat(cityTex, { r: 0.4 }));
  B(2.36, 0.05, 1.35, 0.08, 0.12, 2.2, '#FFFFFF', 0.02);
  B(0.4, 0.0, 1.12, 4.0, 0.3, 0.1, '#FFFFFF', 0.03); // sill

  // whiteboard (kanban)
  const wbTex = canvasTex(920, 400, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.font = '900 24px Nunito'; g.fillStyle = '#1F2544'; g.textAlign = 'center'; g.textBaseline = 'middle';
    ['BACKLOG', 'IN PROGRESS', 'REVIEW', 'DONE'].forEach((t, i) => g.fillText(t, 82 + i * 165, 40));
    g.strokeStyle = '#D5DAE8'; g.lineWidth = 4; g.beginPath();
    [165, 330, 495, 660].forEach((x) => { g.moveTo(x, 20); g.lineTo(x, h - 20); }); g.stroke();
    // sticky notes: colour and column (0-3) and row (0-1)
    const notes = [['#FFE066', 0, 0], ['#FF9AA2', 0, 1], ['#FFE066', 1, 0], ['#C7CEEA', 2, 0], ['#B5EAD7', 3, 0], ['#B5EAD7', 3, 1], ['#B5EAD7', 2, 1]];
    notes.forEach(([c, col, row], i) => { const x = col * 165 + 22, y = 80 + row * 140; g.save(); g.translate(x + 60, y + 40); g.rotate(((i % 3) - 1) * 0.06); g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(-56, -48, 120, 90); g.fillStyle = c; g.fillRect(-60, -52, 120, 90); g.fillStyle = 'rgba(31,37,68,.35)'; g.fillRect(-42, -22, 80, 8); g.fillRect(-42, -4, 56, 8); g.restore(); });
    // architecture strip: web -> API -> DB and queue
    const box = (x, y, bw, t, c) => { g.fillStyle = c; g.beginPath(); g.roundRect(x, y, bw, 46, 12); g.fill(); g.fillStyle = '#fff'; g.font = '900 26px Nunito'; g.fillText(t, x + bw / 2, y + 24); };
    g.strokeStyle = '#1F2544'; g.lineWidth = 4; g.beginPath();
    g.moveTo(795, 116); g.lineTo(795, 160); g.moveTo(760, 206); g.lineTo(735, 250); g.moveTo(830, 206); g.lineTo(860, 250); g.stroke();
    box(705, 70, 180, 'Web', '#3A86FF'); box(705, 160, 180, 'API', '#8338EC');
    box(680, 250, 110, 'DB', '#2EC4B6'); box(805, 250, 110, 'Queue', '#FF9F1C');
  });
  B(4.9, 0.0, 1.4, 4.8, 0.1, 2.2, '#B8C0D6', 0.04);
  planeZ(5.0, 9.6, 1.5, 3.5, 0.105, texMat(wbTex, { r: 0.5 }));
  B(5.2, 0.0, 1.32, 4.2, 0.22, 0.06, '#9AA3BC', 0.02);

  // CI/CD board in the back-wall gap (x 9.8-10.9). Its lamp shows what the office is doing (see setStatus).
  const ciTex = canvasTex(380, 400, (g, w, h) => {
    g.fillStyle = '#1F2544'; g.fillRect(0, 0, w, h); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#B5EAD7'; g.font = '700 58px Fredoka'; g.fillText('main ✓', w / 2, 110);
    g.fillStyle = '#fff'; g.font = '700 38px Nunito'; g.fillText('build passing', w / 2, 180);
    ['Build', 'Test', 'Deploy'].forEach((t, i) => {
      const y = 270 + i * 50; g.fillStyle = '#06D6A0'; g.beginPath(); g.arc(90, y, 12, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = '700 30px Nunito'; g.textAlign = 'left'; g.fillText(t, 118, y); g.textAlign = 'center';
    });
  });
  B(9.8, 0.0, 1.3, 1.1, 0.08, 1.15, '#1F2544', 0.03);
  planeZ(9.9, 10.8, 1.4, 2.35, 0.09, texMat(ciTex, { r: 0.4 }));
  const lampMat = new THREE.MeshStandardMaterial({ color: '#22C55E', emissive: '#22C55E', emissiveIntensity: 0.8, roughness: 0.4 });
  B(10.5, 0.08, 1.31, 0.1, 0.03, 0.08, lampMat, 0.015, { cast: false });

  // company sign (back-left wall)
  const signTex = canvasTex(1300, 210, (g, w, h) => {
    g.fillStyle = '#8338EC'; g.beginPath(); g.roundRect(0, 0, w, h, 40); g.fill();
    if (emoji.office_building) g.drawImage(emoji.office_building, 40, 35, 140, 140);
    const name = String(opt.company || 'My Company').toUpperCase();
    let size = 104; g.font = `700 ${size}px Fredoka`;
    while (size > 40 && g.measureText(name).width > w - 245) { size -= 4; g.font = `700 ${size}px Fredoka`; }
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(name, 205, h / 2 + 6, w - 245);
  });
  B(0, 2.35, 2.5, 0.08, 6.6, 1.15, '#6A23C9', 0.03);
  planeX(8.9, 2.4, 2.55, 3.6, 0.085, texMat(signTex, { transparent: true, r: 0.5 }));

  // clock
  const clockTex = canvasTex(256, 256, (g) => {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(128, 128, 120, 0, 7); g.fill();
    g.strokeStyle = '#1F2544'; g.lineWidth = 14; g.stroke();
    g.fillStyle = '#1F2544'; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; g.beginPath(); g.arc(128 + Math.sin(a) * 92, 128 - Math.cos(a) * 92, 7, 0, 7); g.fill(); }
    g.lineCap = 'round'; g.lineWidth = 12; g.beginPath(); g.moveTo(128, 128); g.lineTo(128, 60); g.stroke(); g.beginPath(); g.moveTo(128, 128); g.lineTo(180, 128); g.stroke();
  });
  planeX(10.65, 9.75, 2.45, 3.35, 0.02, texMat(clockTex, { transparent: true }));

  // bookshelf on back-left wall
  B(0.0, 3.9, 0, 0.12, 2.3, 1.75, '#C98B4F', 0.02);            // back panel
  B(0.0, 3.9, 0, 0.75, 0.1, 1.75, '#C98B4F', 0.02);             // side
  B(0.0, 6.1, 0, 0.75, 0.1, 1.75, '#C98B4F', 0.02);             // side
  B(0.0, 3.9, 1.7, 0.78, 2.3, 0.08, '#B87A40', 0.02);           // top
  [0.0, 0.56, 1.1].forEach(z => B(0.05, 4.0, z + 0.02, 0.68, 2.1, 0.06, '#E8B57E', 0.02));
  const bookC = ['#FF6B6B', '#3A86FF', '#FFD166', '#2EC4B6', '#8338EC', '#FF9F1C', '#06D6A0'];
  [0.12, 0.66, 1.2].forEach((z, row) => { let y = 4.08; for (let k = 0; k < 9 && y < 5.9; k++) { const t = 0.14 + ((k + row) % 3) * 0.04, hh = 0.32 + ((k * 7 + row) % 4) * 0.04; B(0.12, y, z + 0.06, 0.45, t, hh, bookC[(k + row * 2) % bookC.length], 0.015); y += t + 0.03; } });
  // water cooler
  B(0.2, 7.2, 0, 0.6, 0.6, 0.95, '#E8EEF7', 0.06);
  CYL(0.5, 7.5, 0.95, 0.24, 0.26, 0.6, new THREE.MeshStandardMaterial({ color: '#8FD3FF', transparent: true, opacity: 0.75, roughness: 0.2 }));
  // server rack on the back-left wall (x 0.05-0.75, y 8.1-9.6); two LED colours, shared materials
  B(0.05, 8.1, 0, 0.7, 1.5, 1.5, '#1F2544', 0.03);
  const leds = [0, 1].map((i) => new THREE.MeshStandardMaterial({ color: i ? '#FFB020' : '#2EE6A6', emissive: i ? '#FFB020' : '#2EE6A6', emissiveIntensity: 1, roughness: 0.4 }));
  for (let row = 0; row < 2; row++) for (let k = 0; k < 6; k++) B(0.74, 8.2 + k * 0.22, 0.55 + row * 0.4, 0.02, 0.07, 0.07, leds[(k + row) % 2], 0.008, { cast: false });

  const baseCount = scene.children.length;
  // stickers for the laptop lids: one canvas and one material, shared by every laptop
  const stickerMat = texMat(canvasTex(256, 160, (g) => {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const tag = (x, y, c, t, f) => { g.fillStyle = c; g.beginPath(); g.roundRect(x, y, 120, 50, 14); g.fill(); g.fillStyle = '#1F2544'; g.font = f; g.fillText(t, x + 60, y + 26); };
    tag(8, 8, '#FFE066', '</>', '900 34px Nunito'); tag(130, 8, '#FF9AA2', 'LGTM', '900 30px Nunito'); tag(70, 90, '#B5EAD7', 'ship it', '900 30px Nunito');
  }), { transparent: true });
  // ---------------- furniture helpers ----------------
  function plant(x, y, big = 1) {
    CYL(x, y, 0, 0.3 * big, 0.24 * big, 0.5 * big, '#E07A5F');
    CYL(x, y, 0.5 * big - 0.04, 0.27 * big, 0.27 * big, 0.04, '#6B4226');
    const greens = ['#3FA34D', '#56C26A', '#6ED37F', '#8BE29A'];
    [[0, 0.55, 0, 0.36], [-0.2, 0.75, 0.12, 0.28], [0.2, 0.85, -0.08, 0.3], [0.03, 1.08, 0.04, 0.24], [0.15, 0.62, 0.22, 0.22]].forEach(([dx, dz, dy, r], i) =>
      SPH(x + dx * big, y + dy * big, (dz + 0.1) * big, r * big, greens[i % 4], { flat: true, seg: 6 }));
  }
  // a frame: desk-relative floor coords turned by quarter turn q about (x, y). Turn 0 is the drawn layout, same numbers.
  const fr = (x, y, q = 0) => ({
    q, yaw: -q * (Math.PI / 2), // three.js rotation.y for this turn
    at: (dx, dy) => { const [ux, uy] = turnVec(q, dx, dy); return [x + ux, y + uy]; },
    dir: (dx, dy) => turnVec(q, dx, dy),
    box: (lx, ly, z, w, d, h, c, r, o) => { const [mx, my] = minCorner(q, lx, ly, w, d), s = q & 1; return B(x + mx, y + my, z, s ? d : w, s ? w : d, h, c, r, o); },
  });
  // a rotated object keeps its yaw; turn 0 leaves the rotation untouched
  const yawTo = (m, f) => { if (f.q) { m.rotation.order = 'YXZ'; m.rotation.y = f.yaw; } };
  function chair(x, y, c = '#4A4F66', q = 0) {
    CYL(x, y, 0, 0.3, 0.3, 0.05, '#2E3248', 16);
    CYL(x, y, 0.05, 0.05, 0.05, 0.36, '#2E3248', 12);
    const f = fr(x, y, q);
    f.box(-0.36, -0.34, 0.4, 0.72, 0.68, 0.12, c, 0.05);
    f.box(-0.36, -0.46, 0.45, 0.72, 0.14, 0.95, c, 0.06);
  }
  function laptop(f, lx, ly, z, lidCol = '#B8BFD1') {
    f.box(lx, ly, z, 0.78, 0.5, 0.04, '#D5DAE6', 0.015);
    const [px, py] = f.at(lx, ly); // back-left corner of the base, in world
    const on = (dx, dy) => { const [ux, uy] = f.dir(dx, dy); return [px + ux, py + uy]; };
    const lid = new THREE.Mesh(G(RoundedBoxGeometry, 0.78, 0.5, 0.035, 2, 0.012), mat(lidCol, { r: 0.4, m: 0.3 }));
    const [lx1, lz1] = on(0.39, 0.52); lid.position.set(lx1, z + 0.27, lz1); lid.rotation.x = 0.18; yawTo(lid, f); add(lid);
    const logo = new THREE.Mesh(G(THREE.CircleGeometry, 0.05, 20), mat('#FFFFFF', { em: '#FFFFFF', ei: 0.6 }));
    const [gx, gz] = on(0.39, 0.545); logo.position.set(gx, z + 0.3, gz); logo.rotation.x = 0.18; yawTo(logo, f); scene.add(logo);
    const sticker = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.1375), stickerMat);
    const [sx, sz] = on(0.6, 0.531); sticker.position.set(sx, z + 0.22, sz); sticker.rotation.x = 0.18; yawTo(sticker, f); scene.add(sticker);
  }
  function mug(x, y, z, c) { CYL(x, y, z, 0.09, 0.08, 0.2, c, 20); }
  // a desk is 2 m wide (x - 0.3 to x + 1.7); the person sits at x + 0.75. q turns the whole desk about (x, y).
  function desk(x, y, col, q = 0) {
    const f = fr(x, y, q);
    f.box(-0.3, 0, 0.78, 2.0, 1.15, 0.08, '#FFFFFF', 0.03);
    f.box(-0.25, 0.05, 0, 0.1, 1.05, 0.78, '#D9DDE8', 0.02);
    f.box(1.55, 0.05, 0, 0.1, 1.05, 0.78, '#D9DDE8', 0.02);
    f.box(-0.2, 0.95, 0.12, 1.8, 0.08, 0.62, col, 0.03);
    // laptop to the left of the seat, so the camera can see the typing hand on the right
    laptop(f, -0.08, 0.08, 0.86);
    const [mx, my] = f.at(1.5, 0.66); mug(mx, my, 0.86, '#FFFFFF');
    f.box(0.9, 0.4, 0.86, 0.5, 0.38, 0.05, '#FFE08A', 0.01);
    f.box(0.95, 0.42, 0.91, 0.46, 0.34, 0.03, '#FFFFFF', 0.01);
    const [cx, cy] = f.at(0.75, -0.45); chair(cx, cy, '#4A4F66', q);
  }

  // ---------------- people ----------------
  const anchors = {};
  function limb(a, b, r, c) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), len = va.distanceTo(vb);
    const m = new THREE.Mesh(G(THREE.CapsuleGeometry, r, len, 6, 12), mat(c));
    m.position.copy(va.clone().add(vb).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    m.castShadow = true; return m;
  }
  const blush = new THREE.MeshStandardMaterial({ color: '#FF8FA3', transparent: true, opacity: 0.55, roughness: 1 });
  // A person is a small rig: root (floor) > body (rises when standing) > hips, shoulders, head.
  // Poses and movement are driven later by the animation loop in renderOffice.
  function person(x, y, o) {
    const g = new THREE.Group();
    const body = new THREE.Group(); g.add(body);
    const SEAT = 0.5;
    const pants = o.pants || '#3B4266', sleeve = o.sleeve || o.shirt;
    const add2 = (parent, geo, c, px, py, pz) => { const m = new THREE.Mesh(geo, typeof c === 'string' ? mat(c) : c); m.position.set(px, py, pz); m.castShadow = true; parent.add(m); return m; };
    const hips = [-0.13, 0.13].map((dx) => {
      const hip = new THREE.Group(); hip.position.set(dx, SEAT - 0.02, 0.05); body.add(hip);
      add2(hip, G(THREE.CapsuleGeometry, 0.105, 0.36, 6, 12), pants, 0, -0.25, 0);
      add2(hip, G(THREE.SphereGeometry, 0.11, 12, 8), '#2B2233', 0, -0.5, 0.05);
      return hip;
    });
    const torso = add2(body, G(RoundedBoxGeometry, 0.62, 0.72, 0.42, 3, 0.16), o.shirt, 0, SEAT + 0.36, 0);
    const arms = [-1, 1].map((side) => {
      const sh = new THREE.Group(); sh.position.set(0.31 * side, SEAT + 0.6, 0.02); body.add(sh);
      add2(sh, G(THREE.CapsuleGeometry, 0.085, 0.34, 6, 12), sleeve, 0, -0.22, 0);
      add2(sh, G(THREE.SphereGeometry, 0.078, 12, 8), o.skin, 0, -0.45, 0);
      return sh;
    });
    const head = new THREE.Group(); head.position.set(0, SEAT + 0.72 + 0.36, 0); body.add(head);
    const hp = (geo, c, px, py, pz) => add2(head, geo, c, px, py, pz);
    if (o.tud) {
      hp(G(THREE.SphereGeometry, 0.4, 32, 24), o.tud, 0, 0.04, -0.04);
      const drape = hp(G(THREE.SphereGeometry, 0.44, 32, 24), o.tud, 0, -0.3, -0.02); drape.scale.set(1.12, 0.7, 1.0);
      hp(G(THREE.SphereGeometry, 0.32, 32, 24), o.skin, 0, -0.01, 0.12);
      const band = hp(G(THREE.TorusGeometry, 0.3, 0.035, 10, 40), shadeHex(o.tud, -0.12), 0, 0.0, 0.28); band.scale.set(0.95, 1.1, 1);
    } else {
      hp(G(THREE.SphereGeometry, 0.36, 32, 24), o.skin, 0, 0, 0);
      const hair = hp(G(THREE.SphereGeometry, 0.375, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), o.hair || '#2B2233', 0, 0.02, -0.03); hair.rotation.x = -0.25;
      hp(G(THREE.SphereGeometry, 0.08, 12, 8), o.skin, -0.35, -0.02, 0); hp(G(THREE.SphereGeometry, 0.08, 12, 8), o.skin, 0.35, -0.02, 0);
    }
    const fz = o.tud ? 0.42 : 0.345, ey = o.tud ? 0.0 : 0.02;
    const open = new THREE.Group(), shut = new THREE.Group(); head.add(open); head.add(shut);
    [-0.12, 0.12].forEach((ex) => {
      const e = add2(open, G(THREE.SphereGeometry, 0.05, 16, 12), '#2B2233', ex, ey, fz - 0.03); e.scale.set(1, 1.2, 0.6);
      add2(open, G(THREE.SphereGeometry, 0.016, 8, 6), '#FFFFFF', ex + 0.015, ey + 0.025, fz - 0.003);
      const c = add2(shut, G(THREE.TorusGeometry, 0.045, 0.014, 6, 16, Math.PI), '#2B2233', ex, ey, fz - 0.02); c.rotation.z = Math.PI;
    });
    shut.visible = false;
    const mouth = hp(G(THREE.TorusGeometry, 0.06, 0.014, 6, 16, Math.PI), '#B23A48', 0, ey - 0.12, fz - 0.035); mouth.rotation.z = Math.PI;
    [-0.18, 0.18].forEach((ex) => { const b = hp(G(THREE.SphereGeometry, 0.05, 12, 8), blush, ex, ey - 0.08, fz - 0.06); b.scale.set(1, 0.6, 0.4); });
    g.position.set(x, 0, y); g.rotation.y = o.rot ?? 0.35;
    scene.add(g);
    g.traverse((m) => { if (m.isMesh) m.receiveShadow = true; });
    const rig = { root: g, body, torso, hips, arms, head, open, shut, seated: !!o.seated, home: { x, z: y, rot: o.rot ?? 0.35, turn: o.turn || 0 } };
    const v = new THREE.Vector3(x, SEAT + 0.72 + 0.36 + 0.5, y);
    v.rig = rig; v.group = g; v.head = head;
    return v;
  }
  // q: quarter turn of the desk (see SLOTS); the person faces the desk's front, plus the same 0.3 rad lean
  function staff(p, x, y, s, q = 0) {
    const col = hex(p.colour, '#8D93A5'), look = p.look || {};
    return person(x, y, {
      seated: true, skin: hex(look.skin, '#E8B98A'), tud: look.scarf ? col : null, hair: hex(look.hair, '#2B2233'),
      shirt: look.scarf ? shadeHex(col, -0.14) : col, rot: 0.3 - q * (Math.PI / 2), turn: q,
    });
  }

  // ---------------- boss room (glass partition, own carpet) ----------------
  const bossRugTex = canvasTex(490, 340, (g, w, h) => {
    g.fillStyle = '#E9DDFF'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#C7B1F5'; g.lineWidth = 10; g.strokeRect(14, 14, w - 28, h - 28);
  });
  planeF(0.1, 4.5, 0.1, 3.3, 0.013, texMat(bossRugTex));
  const glass = new THREE.MeshStandardMaterial({ color: '#D8ECFF', transparent: true, opacity: 0.32, roughness: 0.1, metalness: 0.1, depthWrite: false });
  const frame = '#B9A3EE', GH = 1.35;
  const glassWall = (x, y, w, d) => { // one framed glass panel run along x (d small) or y (w small)
    B(x, y, 0.02, w, d, GH, glass, 0.01, { cast: false });
    B(x, y, GH, w, d, 0.06, frame, 0.02);       // top rail
    B(x, y, 0, w, d, 0.06, frame, 0.02);        // bottom rail
  };
  const post = (x, y) => B(x - 0.05, y - 0.05, 0, 0.1, 0.1, GH + 0.06, frame, 0.03);
  glassWall(0.1, 3.3, 2.6, 0.06);               // front, left of the door
  glassWall(4.5, 0.1, 0.06, 3.26);              // side, facing the team
  glassWall(3.7, 3.3, 0.8, 0.06);               // front, right of the door
  [[0.1, 3.33], [2.7, 3.33], [3.7, 3.33], [4.53, 3.33], [4.53, 0.1], [4.53, 1.7]].forEach(([x, y]) => post(x, y));
  const doorTex = canvasTex(360, 90, (g, w, h) => { g.fillStyle = '#7C3AED'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '700 54px Fredoka'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BOSS ROOM', w / 2, h / 2 + 3); });
  planeX(2.45, 0.75, 0.95, 1.3, 4.565, texMat(doorTex));  // sign on the glass, facing the team

  // ---------------- boss corner ----------------
  B(1.0, 1.3, 0.78, 2.6, 1.25, 0.1, '#F4ECFF', 0.03);
  B(1.05, 1.35, 0, 2.5, 1.15, 0.78, '#8338EC', 0.05);
  const bossTex = canvasTex(400, 120, (g, w, h) => { g.fillStyle = '#fff'; g.font = '700 84px Fredoka'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BOSS', w / 2, h / 2 + 4); });
  planeZ(1.7, 2.9, 0.2, 0.56, 2.505, texMat(bossTex, { transparent: true }));
  B(1.25, 1.5, 0.88, 0.75, 0.55, 0.12, '#FFB703', 0.03);
  B(1.32, 1.55, 0.98, 0.62, 0.45, 0.1, '#FFFFFF', 0.01);
  laptop(fr(0, 0), 1.55, 1.45, 0.88, '#9F7AEA');
  mug(3.3, 2.2, 0.88, '#FFD166');
  chair(2.1, 0.92, '#3D2A6B');
  const youA = person(2.1, 0.92, { seated: true, shirt: BOSS.colour, skin: BOSS.skin, hair: BOSS.hair, rot: 0.3 });
  plant(0.6, 2.75, 0.9);

  // ---------------- pantry ----------------
  B(11.0, 0.12, 0, 2.6, 0.9, 0.95, '#2EC4B6', 0.05);
  B(10.95, 0.07, 0.95, 2.7, 1.0, 0.08, '#F4FFFD', 0.03);
  B(11.0, 0.0, 2.3, 2.6, 0.5, 0.85, '#7FDDD3', 0.05);
  B(13.0, 1.2, 0, 0.9, 0.9, 2.15, '#EEF2F8', 0.08);
  B(13.86, 1.4, 1.1, 0.06, 0.08, 0.5, '#9AA3BC', 0.02);
  B(11.25, 0.25, 1.03, 0.55, 0.45, 0.65, '#3B4266', 0.06);
  CYL(11.52, 0.6, 1.03, 0.08, 0.07, 0.15, '#FFFFFF', 16);
  mug(12.3, 0.55, 1.03, '#FF6B6B'); mug(12.62, 0.5, 1.03, '#FFB703'); mug(12.95, 0.6, 1.03, '#3A86FF');
  plant(9.7, 0.7, 0.8);
  // QA bug board on the fridge door (front faces +x; the handle is at z 1.1-1.6, so the board sits above it)
  const qaTex = canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#FFE066'; g.fillRect(20, 24, 110, 110);
    g.fillStyle = '#1F2544'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 40px Nunito'; g.fillText('0', 75, 62); g.font = '700 20px Nunito'; g.fillText('P1 bugs', 75, 100);
    [['#FF6B6B', 170, 40], ['#3A86FF', 205, 80], ['#2EC4B6', 175, 120]].forEach(([c, x, y]) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, 14, 0, 7); g.fill(); });
  });
  planeX(1.9, 1.3, 1.6, 1.975, 13.93, texMat(qaTex));

  // ---------------- meeting corner ----------------
  CYL(12.3, 9.7, 0, 0.25, 0.4, 0.06, '#D9DDE8');
  CYL(12.3, 9.7, 0.06, 0.08, 0.08, 0.66, '#D9DDE8', 16);
  CYL(12.3, 9.7, 0.72, 1.0, 1.0, 0.08, '#FFF3DE');
  B(11.95, 8.0, 0, 0.7, 0.62, 0.45, '#FF9F1C', 0.12);
  B(10.25, 9.4, 0, 0.62, 0.7, 0.45, '#3A86FF', 0.12);
  B(13.2, 10.65, 0, 0.62, 0.62, 0.45, '#FF6B6B', 0.12);
  B(11.9, 9.4, 0.8, 0.5, 0.36, 0.04, '#FFFFFF', 0.01);
  mug(12.7, 10.0, 0.8, '#2EC4B6');
  plant(13.4, 3.4, 0.9); plant(13.4, 7.3, 1.0); plant(0.7, 10.25, 1.1);
  // printer
  B(12.95, 5.4, 0, 0.8, 0.7, 0.65, '#E8EEF7', 0.05);
  B(13.05, 5.5, 0.65, 0.6, 0.5, 0.14, '#C9D1E3', 0.04);
  B(13.1, 5.7, 0.79, 0.45, 0.32, 0.02, '#FFFFFF', 0.005);

  // ---------------- pairing corner (front-left floor, off the customer route) ----------------
  B(0.9, 7.8, 0, 0.22, 2.0, 0.85, '#8338EC', 0.06);                    // sofa back
  B(1.12, 7.8, 0, 0.9, 2.0, 0.4, '#8338EC', 0.06);                     // sofa base
  [7.82, 8.86].forEach((y) => B(1.14, y, 0.4, 0.86, 0.96, 0.12, '#A77BF2', 0.05, { cast: false })); // two seat cushions
  CYL(2.55, 8.7, 0, 0.32, 0.32, 0.36, '#FFF3DE', 32, { cast: false });  // low table
  [[3.35, 7.9, '#2EC4B6'], [3.35, 9.5, '#FF9F1C']].forEach(([x, y, c]) => { // bean bags: squashed spheres
    const bag = new THREE.Mesh(G(THREE.SphereGeometry, 0.42, 24, 16), mat(c)); bag.scale.y = 0.55;
    bag.position.set(x, 0.23, y); add(bag, false);
  });
  // design wall above the sofa, on the back-left wall (x = 0; the wall face is at X 0, the plane sits 2 cm out)
  const designTex = canvasTex(880, 320, (g, w, h) => {
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1F2544'; g.lineWidth = 6;
    [40, 330, 620].forEach((x) => { g.strokeRect(x, 30, 220, 160); g.beginPath(); g.moveTo(x, 30); g.lineTo(x + 220, 190); g.moveTo(x + 220, 30); g.lineTo(x, 190); g.stroke(); });
    ['#8338EC', '#FF6B6B', '#FFD166', '#2EC4B6', '#3A86FF'].forEach((c, i) => { g.fillStyle = c; g.fillRect(40 + i * 164, 225, 140, 64); });
  });
  planeX(10.4, 8.2, 1.6, 2.4, 0.02, texMat(designTex));

  // ---------------- customer service booth (outside the office) ----------------
  const CY = D + 1.35; // Aina's seat
  const boothTex = canvasTex(540, 230, (g, w, h) => { g.fillStyle = '#FFF0EE'; g.fillRect(0, 0, w, h); g.strokeStyle = '#FFC9C2'; g.lineWidth = 8; g.strokeRect(10, 10, w - 20, h - 20); });
  planeF(0.4, 5.8, D + 0.45, D + 2.75, 0.004, texMat(boothTex));
  B(0.4, D + 0.42, 0, 5.4, 0.12, 1.2, '#FFFFFF', 0.03);               // low back panel
  B(0.36, D + 0.38, 1.2, 5.48, 0.2, 0.07, '#FF6B6B', 0.02);           // red cap
  const anchorsCs = plan.cs ? { [plan.cs.id]: staff(plan.cs, 2.6, CY, st(plan.cs.id)) } : {};
  if (plan.cs) anchorsCs[plan.cs.id].rig.kind = 'booth';
  chair(2.6, CY + 0.02);
  B(0.9, CY + 0.55, 0, 4.4, 0.9, 1.05, '#FF6B6B', 0.06);
  B(0.85, CY + 0.5, 1.05, 4.5, 1.0, 0.08, '#FFF5F2', 0.03);
  const csTex = canvasTex(1100, 140, (g, w, h) => {
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 92; g.font = `700 ${size}px Fredoka`;
    while (size > 40 && g.measureText('SUPPORT · ISSUE TRIAGE').width > w - 60) { size -= 4; g.font = `700 ${size}px Fredoka`; }
    g.fillText('SUPPORT · ISSUE TRIAGE', w / 2, h / 2 + 6);
  });
  planeZ(1.2, 5.0, 0.42, 0.86, CY + 1.455, texMat(csTex, { transparent: true }));
  laptop(fr(0, 0), 1.6, CY + 0.6, 1.13);
  SPH(4.6, CY + 1.15, 1.13, 0.1, '#FFC53D', { m: 0.6, r: 0.3 }); CYL(4.6, CY + 1.15, 1.13, 0.13, 0.13, 0.02, '#C98B4F', 16);
  plant(5.45, D + 0.75, 0.9);

  // ---------------- team desks ----------------
  // the PA (manager) sits just outside the boss room, between the boss and the team
  desk(1.9, 5.35, hex(pa.colour, '#8338EC'));
  anchors.pa = staff(pa, 1.9 + 0.75, 5.35 - 0.42, st('pa'));
  plan.desks.forEach((s, i) => {
    const [x, y, q = 0] = s.slot; desk(x, y, hex(s.colour, '#8D93A5'), q);
    const f = fr(x, y, q);
    const [sx, sy] = f.at(0.75, -0.42);
    anchors[s.id] = staff(s, sx, sy, st(s.id), q);
    // desk toy: a rubber duck (no shadows, it is small)
    const [dx, dy] = f.at(1.48, 0.3);
    SPH(dx, dy, 0.96, 0.11, '#FFD93D', { cast: false, seg: 12 });
    const [ex, ey] = f.dir(0.07, 0);
    SPH(dx + ex, dy + ey, 1.09, 0.075, '#FFD93D', { cast: false, seg: 12 });
    fr(dx, dy, q).box(0.12, -0.025, 1.06, 0.07, 0.05, 0.035, '#FF9F1C', 0.012, { cast: false });
  });

  // ---------------- customers queue outside ----------------
  // queue to the right of the counter, first in line at the counter end
  const LOOKS = [[6.2, D + 2.4, '#FFD166', '#06D6A0', '#F1C27D', '#2B2233'],
                 [8.1, D + 2.0, '#C77DFF', '#118AB2', '#E0AC69', '#5A3825'],
                 [10.0, D + 1.6, '#4CC9F0', '#EF476F', '#FAD6B3', '#111111']];
  const CQ = LOOKS.map((l, i) => { const q = (opt.queue || [])[i]; return [...l, q ? q.text : '', q && q.ticket ? `#${q.ticket}` : '']; });
  const custA = CQ.map(([x, y, shirt, pants, skin, hair], i) => person(x, y, { shirt, pants, skin, hair, rot: i === 0 ? -0.5 : -0.1 }));
  custA.forEach((a, i) => { a.group.visible = i < (opt.queue || []).length; });

  // ---------------- lights ----------------
  const lights = [new THREE.HemisphereLight('#FFFFFF', '#F3D2A8', 1.55)];
  const sun = new THREE.DirectionalLight('#FFF6E8', 2.1);
  sun.position.set(W / 2 + 3, 16, D / 2 + 9); sun.target.position.set(W / 2, 0, D / 2); lights.push(sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(opt.shadowSize || 4096, opt.shadowSize || 4096);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
  lights.push(sun);
  const fill = new THREE.DirectionalLight('#DDEBFF', 0.5); fill.position.set(W + 10, 8, -4); lights.push(fill);
  return { root: scene, lights, baseCount, anchors: { ...anchors, ...anchorsCs, you: youA }, custA, CQ, W, D, lamp: lampMat, leds };
}

// Renders the office into a container and keeps it alive: people type, look around,
// stand up now and then, and walk over when work is handed out or reported back.
// One renderer (one WebGL context) for the page's whole life: a rebuild swaps the scene, it does not
// open a second context (that doubled GPU memory for a moment, every time).
let R = null, running = null;
function renderer3d(onRestore) {
  if (R) return R;
  R = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap; R.shadowMap.autoUpdate = false;
  R.outputColorSpace = THREE.SRGBColorSpace; R.toneMapping = THREE.NoToneMapping;
  R.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
  R.domElement.addEventListener('webglcontextrestored', () => { if (onRestore) onRestore(); });
  return R;
}

// Returns { width, height, setStatus(status), setQueue(queue, count), setPixelRatio(r), delegate(staffId), report(staffId), dispose() }.
export async function renderOffice(container, opt = {}) {
  const built = await buildOffice({ shadowSize: 2048, freeCanvas: true, ...opt });
  if (running) running(); // stop the old scene's loop before this one takes the renderer
  const scene = new THREE.Scene(); scene.add(built.root); built.lights.forEach((l) => scene.add(l));
  const anchors = built.anchors, youA = anchors.you, custA = built.custA, CQ = built.CQ;
  const people = [{ id: 'pa', ...(opt.pa || {}), mgr: true }, ...(opt.staff || [])];

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const target = new THREE.Vector3(W / 2 - 0.5, 1.0, (D + 3) / 2);
  cam.position.copy(target).add(new THREE.Vector3(30, 30, 30)); cam.lookAt(target); cam.updateMatrixWorld();
  // fit
  const pts = [];
  for (const X of [-0.45, W]) for (const Y of [-0.45, 4.7]) for (const Z of [-0.45, D + 4.8]) pts.push(new THREE.Vector3(X, Y, Z));
  pts.push(new THREE.Vector3(-0.4, -0.45, D + 4.8), new THREE.Vector3(W, -0.4, D));
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
  pts.forEach(p => { const v = p.clone().applyMatrix4(cam.matrixWorldInverse); mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x); mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y); });
  const pad = opt.padFrac ?? 0.02, ex = mxx - mnx, ey = mxy - mny;
  cam.left = mnx - ex * pad; cam.right = mxx + ex * pad; cam.bottom = mny - ey * pad; cam.top = mxy + ey * (pad + (opt.topExtra ?? 0.04));
  cam.updateProjectionMatrix();
  const cw = opt.width || container.clientWidth;
  const ch = opt.height || Math.round(cw * (cam.top - cam.bottom) / (cam.right - cam.left));
  if (opt.height) { // keep aspect by widening the view
    const want = (cam.right - cam.left) * ch / cw, cy = (cam.top + cam.bottom) / 2;
    if (want > cam.top - cam.bottom) { cam.top = cy + want / 2; cam.bottom = cy - want / 2; }
    else { const wx = (cam.top - cam.bottom) * cw / ch, cx = (cam.left + cam.right) / 2; cam.left = cx - wx / 2; cam.right = cx + wx / 2; }
    cam.updateProjectionMatrix();
  }

  const renderer = renderer3d(opt.onRestore);
  renderer.setPixelRatio(opt.dpr || window.devicePixelRatio || 1);
  renderer.setSize(cw, ch);
  container.style.position = 'relative'; container.style.width = cw + 'px'; container.style.height = ch + 'px';
  container.appendChild(renderer.domElement);

  // ---------------- name tags (HTML, follow the heads) ----------------
  const toPx = (v) => { const p = v.clone().project(cam); return [(p.x + 1) / 2 * cw, (1 - p.y) / 2 * ch]; };
  const ov = document.createElement('div'); ov.className = 'ov'; container.appendChild(ov);
  const put = (html, [x, y], cls = '') => { const d = document.createElement('div'); d.className = 'tag ' + cls; d.style.left = x + 'px'; d.style.top = y + 'px'; d.innerHTML = html; ov.appendChild(d); return d; };
  const tags = new Map(); // id -> element
  for (const p of people) {
    const a = anchors[p.id]; if (!a) continue;
    const d = put('', toPx(a)); d.dataset.id = p.id; tags.set(p.id, d);
  }
  const bossTag = put(`<div class="pill boss"><img src="${EMO('crown')}">You (Boss)</div>`, toPx(youA));
  const tickets = custA.map((a, i) => { a.rig.tag = put('', toPx(a)); return put('', toPx(new THREE.Vector3(CQ[i][0], 1.0, CQ[i][1] + 0.25)), 'mid'); });
  const qsTag = put('', toPx(new THREE.Vector3(8.4, -0.1, D + 3.9)), 'mid');
  let queueKey = null;
  function setQueue(queue = [], count = queue.length) {
    const key = JSON.stringify([queue.slice(0, 3), count]); if (key === queueKey) return; queueKey = key;
    custA.forEach((a, i) => {
      const q = queue[i], t = q ? q.text || '' : '';
      a.group.visible = !!q; a.rig.tag.style.display = q ? '' : 'none'; tickets[i].style.display = q && q.ticket ? '' : 'none';
      if (q) { a.rig.tag.innerHTML = `<div class="bub">${esc(t.length > 34 ? t.slice(0, 32) + '...' : t)}</div>`; tickets[i].innerHTML = q.ticket ? `<div class="tk">#${esc(q.ticket)}</div>` : ''; }
    });
    qsTag.innerHTML = `<div class="qs"><img src="${EMO('ticket')}">${count ? `Issue queue: ${count}` : 'No open issues'}</div>`;
    dirty = true;
  }
  youA.rig.tag = bossTag;

  // ---------------- rigs, routes ----------------
  const rigs = new Map();
  for (const p of people) { const a = anchors[p.id]; if (a) { a.rig.id = p.id; a.rig.tag = tags.get(p.id); a.rig.kind = a.rig.kind || (p.id === 'pa' ? 'pa' : 'desk'); rigs.set(p.id, a.rig); } }
  const all = [...rigs.values(), youA.rig, ...custA.map((a) => a.rig)];
  youA.rig.kind = 'boss'; custA.forEach((a, i) => { a.rig.kind = 'customer'; a.rig.wave = i === 2; });
  // step-out, lane and visitor points: walkPoints / routePoints (module scope, pure)
  const side = (r) => walkPoints(r, D).side;
  const route = (from, to) => routePoints(from, to, D);
  const back = (r, path) => path.slice(0, -1).reverse(); // ends at the side of their own chair

  // ---------------- poses ----------------
  const lerp = (a, b, k) => a + (b - a) * k;
  const angLerp = (a, b, k) => a + (((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * k;
  for (const r of all) {
    Object.assign(r, { mood: r.kind === 'customer' ? 'idle' : 'sleeping', stand: r.kind === 'customer' ? 1 : 0, act: 'rest', queue: [], step: null,
      headY: 0, headYT: 0, nextLook: Math.random() * 3, nextBlink: 2 + Math.random() * 3, blink: 0, nextStand: 25 + Math.random() * 30, t: Math.random() * 10, phase: 0, lookAt: null,
      armL: { x: 0, z: -0.12 }, armR: { x: 0, z: 0.12 } });
    if (r.kind === 'customer') { r.root.position.y = 0; }
  }
  const busy = () => all.some((r) => r.step || r.queue.length || (r.mood === 'working' && r.kind !== 'customer'));

  function drawTag(r) {
    const p = r.person, d = r.tag; if (!p || !d) return;
    const x = r.status || {}, s = x.status || 'sleeping';
    const S = r.note ? STATUS.working : (STATUS[s] || STATUS.sleeping);
    const txt = r.note || (s === 'working' && x.task) || S.label;
    const col = hex(p.colour, '#8D93A5');
    // badge after the name: Manager (dark, with a star) or the staff's role (in their colour)
    const badge = p.mgr ? `<span class="mgr"><img src="${EMO('star')}">Manager</span>`
      : p.role ? `<span class="mgr role" style="background:${badgeBg(col)}">${esc(p.role.length > 22 ? p.role.slice(0, 20) + '...' : p.role)}</span>` : '';
    const html = `<div class="nm${p.mgr ? ' hasmgr' : badge ? ' hasrole' : ''}" style="color:${shadeHex(col, -0.18)};border-color:${col}">${esc(p.name)}${badge}</div><div class="pill ${S.cls}"><img src="${EMO(r.note ? 'laptop' : S.icon)}"><span class="mq"><span>${esc(txt.length > 90 ? txt.slice(0, 88) + '...' : txt)}</span></span></div>`;
    if (html !== r.tagHtml) { d.innerHTML = html; r.tagHtml = html; d.title = txt; }
  }
  function setStatus(status) {
    for (const p of people) {
      const r = rigs.get(p.id); if (!r) continue;
      r.person = p; r.status = status[p.id] || {}; r.mood = r.status.status || 'sleeping';
      drawTag(r);
    }
    youA.rig.mood = 'working';
    // CI lamp: amber while someone works, blue while someone waits for OK, else green
    const vals = Object.values(status).map((x) => x && x.status);
    const lampCol = vals.includes('working') ? '#F59E0B' : vals.includes('waiting') ? '#3B82F6' : '#22C55E';
    built.lamp.color.set(lampCol); built.lamp.emissive.set(lampCol);
    dirty = true;
  }

  // action queues: each step runs until done
  const walkSteps = (path) => path.map((q) => ({ type: 'walk', to: q }));
  function visitPerson(r, target, talkFor, note, waitFor) {
    const path = route(r, target);
    r.queue.push(...(waitFor ? [{ type: 'waitIdle', who: waitFor }] : []), { type: 'note', text: note }, { type: 'stand' }, ...walkSteps(path),
      { type: 'face', target }, { type: 'talk', time: talkFor, target }, { type: 'note', text: 'Back to desk' },
      ...walkSteps(back(r, path)), { type: 'walk', to: { x: r.home.x, z: r.home.z } }, { type: 'turn', rot: r.home.rot }, { type: 'sit' }, { type: 'note', text: null });
  }
  function stretch(r) {
    r.queue.push({ type: 'stand' }, { type: 'walk', to: side(r) }, { type: 'turn', rot: r.home.rot }, { type: 'pose', act: 'stretch', time: 1.4 }, { type: 'pose', act: 'idle', time: 1.5 + Math.random() * 2 },
      { type: 'walk', to: { x: r.home.x, z: r.home.z } }, { type: 'turn', rot: r.home.rot }, { type: 'sit' });
  }
  const nameOf = (id) => ((people.find((p) => p.id === id) || {}).name || '');
  const delegate = (id) => { const pa = rigs.get('pa'), t = rigs.get(id); if (pa && t && t !== pa && pa.queue.length < 40) visitPerson(pa, t, 2.6, `Going to ${nameOf(id)}`); };
  // a report waits until the PA is back at her desk, so they do not cross paths
  const report = (id) => { const pa = rigs.get('pa'), r = rigs.get(id); if (pa && r && r !== pa && r.queue.length < 12) visitPerson(r, pa, 2.2, `Reporting to ${nameOf('pa')}`, pa); };

  const SPEED = 3.2;
  const idle = (r) => !r.step && !r.queue.length;
  function runStep(r, dt) {
    const st = r.step;
    st.t = (st.t || 0) + dt;
    if (st.type === 'stand') { r.stand = Math.min(1, r.stand + dt * 3); r.act = 'idle'; return r.stand >= 1; }
    if (st.type === 'sit') { r.stand = Math.max(0, r.stand - dt * 3); return r.stand <= 0; }
    if (st.type === 'walk') {
      const p = r.root.position, dx = st.to.x - p.x, dz = st.to.z - p.z, dist = Math.hypot(dx, dz);
      r.act = 'walk';
      if (dist < 0.03) { p.x = st.to.x; p.z = st.to.z; return true; }
      r.root.rotation.y = angLerp(r.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 10));
      const k = Math.min(dist, SPEED * dt); p.x += dx / dist * k; p.z += dz / dist * k; r.phase += dt * 13;
      return false;
    }
    if (st.type === 'face' || st.type === 'turn') {
      const p = r.root.position, want = st.type === 'turn' ? st.rot : Math.atan2(st.target.root.position.x - p.x, st.target.root.position.z - p.z);
      r.root.rotation.y = angLerp(r.root.rotation.y, want, Math.min(1, dt * 8)); r.act = 'idle';
      return st.t > 0.35;
    }
    if (st.type === 'talk') { r.act = 'talk'; st.target.lookAt = r; if (st.t > st.time) { st.target.lookAt = null; return true; } return false; }
    if (st.type === 'pose') { r.act = st.act; return st.t > st.time; }
    if (st.type === 'note') { r.note = st.text; drawTag(r); return true; }
    if (st.type === 'waitIdle') { r.act = r.mood === 'sleeping' ? 'rest' : 'type'; return idle(st.who) && st.who.stand === 0; }
    return true;
  }

  const wp = new THREE.Vector3();
  // server LEDs blink; with reduced motion they hold still
  const calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let ledT = 0;
  function tick(dt) {
    ledT += dt; const s = Math.sin(ledT * 6);
    built.leds[0].emissiveIntensity = calm.matches ? 0.7 : s > 0.2 ? 1.2 : 0.25;
    built.leds[1].emissiveIntensity = calm.matches ? 0.7 : s < -0.2 ? 1.2 : 0.25;
    for (const r of all) {
      r.t += dt;
      if (!r.step && r.queue.length) r.step = r.queue.shift();
      if (r.step && runStep(r, dt)) r.step = null;
      const moving = !!r.step || r.queue.length > 0;
      // random life while working: look around, sometimes stand up and stretch
      if (!moving && r.kind !== 'customer') {
        r.act = r.mood === 'working' ? 'type' : r.mood === 'waiting' ? 'raise' : 'rest';
        if (r.mood === 'working' && r.kind !== 'boss' && (r.nextStand -= dt) < 0) { r.nextStand = 25 + Math.random() * 35; stretch(r); }
        else if (r.mood === 'working' && (r.nextGesture = (r.nextGesture ?? 3 + Math.random() * 5) - dt) < 0) {
          r.nextGesture = 5 + Math.random() * 5;
          const g = ['think', 'point', 'stretch'][Math.floor(Math.random() * 3)];
          r.queue.push({ type: 'pose', act: g, time: g === 'stretch' ? 1.1 : 1.6 + Math.random() });
        }
      }
      if (r.kind === 'customer' && !moving) r.act = r.wave ? 'raise' : 'idle';
      if ((r.nextLook -= dt) < 0) { r.nextLook = 1.2 + Math.random() * 3; r.headYT = r.mood === 'sleeping' && r.kind !== 'customer' ? 0 : (Math.random() - 0.5) * 1.3; }
      if ((r.nextBlink -= dt) < 0) { r.nextBlink = 2.5 + Math.random() * 3; r.blink = 0.13; }
      r.blink = Math.max(0, r.blink - dt);
      pose(r, dt);
    }
  }

  function pose(r, dt) {
    const k = Math.min(1, dt * 14), sleeping = r.mood === 'sleeping' && r.kind !== 'customer' && !r.step && !r.queue.length;
    // body height and legs: sitting (legs forward) to standing (legs down), swinging when walking
    r.body.position.y = 0.12 * r.stand;
    const swing = r.act === 'walk' ? Math.sin(r.phase) * 0.7 : 0;
    r.hips[0].rotation.x = lerp(-Math.PI / 2, 0, r.stand) + swing;
    r.hips[1].rotation.x = lerp(-Math.PI / 2, 0, r.stand) - swing;
    r.hips.forEach((h) => { h.scale.y = lerp(0.85, 1, r.stand); });
    // arms
    const T = r.t;
    let L = { x: 0, z: -0.12 }, R = { x: 0, z: 0.12 };
    if (r.act === 'type') { // clear, alternating strokes on the keyboard
      L = { x: -1.35 + Math.sin(T * 8) * 0.32, z: 0.28 + Math.sin(T * 4) * 0.12 };
      R = { x: -1.35 + Math.sin(T * 8 + Math.PI) * 0.32, z: -0.28 - Math.sin(T * 4 + 1) * 0.12 };
    }
    else if (r.act === 'think') { L = { x: -1.1, z: 0.3 }; R = { x: -2.35 + Math.sin(T * 3) * 0.08, z: -0.45 }; } // hand to chin
    else if (r.act === 'point') { L = { x: -1.1, z: 0.3 }; R = { x: -1.55 + Math.sin(T * 6) * 0.12, z: -0.05 }; } // at the screen
    else if (r.act === 'rest') { L = { x: -1.3, z: 0.4 }; R = { x: -1.3, z: -0.4 }; }
    else if (r.act === 'walk') { L = { x: -swing * 1.15, z: -0.12 }; R = { x: swing * 1.15, z: 0.12 }; }
    else if (r.act === 'talk') { L = { x: -0.7 + Math.sin(T * 4 + 1) * 0.3, z: -0.2 }; R = { x: -1.05 + Math.sin(T * 5) * 0.45, z: -0.25 + Math.sin(T * 2.5) * 0.15 }; }
    else if (r.act === 'raise') { R = { x: 0, z: 2.65 + Math.sin(T * 6) * 0.15 }; }
    else if (r.act === 'stretch') { L = { x: 0, z: -2.7 }; R = { x: 0, z: 2.7 }; }
    r.armL.x = lerp(r.armL.x, L.x, k); r.armL.z = lerp(r.armL.z, L.z, k);
    r.armR.x = lerp(r.armR.x, R.x, k); r.armR.z = lerp(r.armR.z, R.z, k);
    r.arms[0].rotation.set(r.armL.x, 0, r.armL.z); r.arms[1].rotation.set(r.armR.x, 0, r.armR.z);
    // head: look around, at a visitor, or nod off
    let hy = r.headYT;
    if (r.lookAt) {
      const p = r.root.position, q = r.lookAt.root.position;
      hy = Math.max(-1.2, Math.min(1.2, (((Math.atan2(q.x - p.x, q.z - p.z) - r.root.rotation.y + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI));
    }
    r.headY = lerp(r.headY, sleeping ? 0 : hy, Math.min(1, dt * 3));
    r.head.rotation.y = r.headY;
    r.head.rotation.x = lerp(r.head.rotation.x, sleeping ? 0.28 + Math.sin(T * 1.6) * 0.03 : (r.act === 'type' ? 0.12 : 0), Math.min(1, dt * 3));
    r.torso.scale.y = sleeping ? 1 + Math.sin(T * 1.6) * 0.015 : 1; // breathing
    const closed = sleeping || r.blink > 0;
    r.open.visible = !closed; r.shut.visible = closed;
  }

  function placeTags() {
    for (const r of all) {
      if (!r.tag) continue;
      r.head.getWorldPosition(wp); wp.y += 0.5;
      const [x, y] = toPx(wp);
      r.tag.style.left = `${x.toFixed(1)}px`; r.tag.style.top = `${y.toFixed(1)}px`;
    }
  }

  // ---------------- loop: smooth while anyone moves, slow when all is quiet ----------------
  // Shadows are redrawn only when someone walks or stands up, and once a second otherwise.
  let alive = true, last = performance.now(), acc = 0, shadowAge = 0, dirty = true;
  const moving = () => all.some((r) => r.step && r.step.type !== 'pose' && r.step.type !== 'waitIdle');
  function draw(dt) {
    shadowAge += dt;
    if (dirty || shadowAge > 1 || moving()) { renderer.shadowMap.needsUpdate = true; shadowAge = 0; dirty = false; }
    renderer.render(scene, cam);
    placeTags();
  }
  function frame(now) {
    if (!alive) return;
    requestAnimationFrame(frame);
    const dt = Math.min(1, (now - last) / 1000); last = now; // real time, even when frames are slow
    if (document.hidden || !container.isConnected || container.offsetParent === null) return;
    acc += dt;
    if (acc < (busy() ? 1 / 30 : 1 / 8)) return;
    for (let left = acc; left > 0; left -= 0.05) tick(Math.min(0.05, left)); // small steps keep turns and walks smooth
    draw(acc); acc = 0;
  }
  setStatus(opt.status || {});
  setQueue(opt.queue || [], opt.queueCount ?? (opt.queue || []).length);
  tick(0.5); draw(0);
  requestAnimationFrame(frame);
  const stop = () => { alive = false; };
  running = stop;

  // sharper or lighter as the page zooms: the drawing buffer follows the size it is shown at
  const setPixelRatio = (r) => { if (!alive || Math.abs(renderer.getPixelRatio() - r) < 0.01) return; renderer.setPixelRatio(r); dirty = true; draw(0); };
  // free this scene's GPU memory; the renderer stays for the next scene
  const dispose = () => {
    alive = false; if (running === stop) running = null;
    scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); }); });
    renderer.renderLists.dispose();
    if (renderer.domElement.parentNode === container) container.innerHTML = '';
  };
  return { width: cw, height: ch, dispose, setStatus, setQueue, setPixelRatio, delegate, report };
}
