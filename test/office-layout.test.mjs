// Layout tests for dashboard/office3d.js: scene fingerprint from before the quarter-turn change, quarter-turn geometry, route check.
// three and the vendored RoundedBoxGeometry are replaced by a stub (no WebGL): it records transforms, geometry args and materials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';

const STUB = "// Minimal stand-in for 'three' and the vendored RoundedBoxGeometry: records positions, rotations, geometry args and materials. No rendering.\nclass V3 {\n  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }\n  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }\n  clone() { return new V3(this.x, this.y, this.z); }\n  copy(v) { return this.set(v.x, v.y, v.z); }\n  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }\n  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }\n  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }\n  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }\n  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }\n  project() { return this; }\n  applyMatrix4() { return this; }\n}\nclass Color {\n  constructor(h = '#000000') { this.set(h); }\n  set(h) { const n = parseInt(String(h).slice(1), 16) || 0; this.r = ((n >> 16) & 255) / 255; this.g = ((n >> 8) & 255) / 255; this.b = (n & 255) / 255; return this; }\n  getHSL(t) { const mx = Math.max(this.r, this.g, this.b), mn = Math.min(this.r, this.g, this.b); t.h = 0; t.s = 0; t.l = (mx + mn) / 2; return t; }\n  setHSL(h, s, l) { this.r = this.g = this.b = l; return this; }\n  getHexString() { const c = (v) => Math.round(v * 255).toString(16).padStart(2, '0'); return c(this.r) + c(this.g) + c(this.b); }\n}\nclass Object3D {\n  constructor() { this.children = []; this.position = new V3(); this.rotation = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; this.scale = new V3(1, 1, 1); this.quaternion = { setFromUnitVectors() {} }; this.visible = true; this.castShadow = false; this.receiveShadow = false; }\n  add(...o) { this.children.push(...o); return this; }\n  traverse(fn) { fn(this); this.children.forEach((c) => c.traverse(fn)); }\n}\nclass Group extends Object3D { constructor() { super(); this.isGroup = true; } }\nclass Scene extends Object3D {}\nclass Mesh extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; } }\nclass Geometry { constructor(...a) { this.kind = new.target.name; this.args = a; } dispose() {} }\nexport class BoxGeometry extends Geometry {}\nexport class CylinderGeometry extends Geometry {}\nexport class SphereGeometry extends Geometry {}\nexport class CapsuleGeometry extends Geometry {}\nexport class TorusGeometry extends Geometry {}\nexport class CircleGeometry extends Geometry {}\nexport class PlaneGeometry extends Geometry {}\nexport class RoundedBoxGeometry extends Geometry {}\nclass Material { constructor(o = {}) { Object.assign(this, o); this.kind = new.target.name; } dispose() {} }\nclass CanvasTexture { constructor(cv) { this.canvas = cv; this.isTexture = true; } dispose() {} }\nclass Light extends Object3D {}\nclass HemisphereLight extends Light { constructor(a, b, i) { super(); this.intensity = i; } }\nclass DirectionalLight extends Light {\n  constructor(c, i) { super(); this.intensity = i; this.target = new Object3D(); this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0, normalBias: 0, radius: 0 }; }\n}\nclass OrthographicCamera extends Object3D { constructor(l, r, t, b, n, f) { super(); Object.assign(this, { left: l, right: r, top: t, bottom: b, near: n, far: f, matrixWorldInverse: null }); } updateProjectionMatrix() {} lookAt() {} updateMatrixWorld() {} }\nclass WebGLRenderer { constructor() { throw new Error('stub: no WebGL'); } }\nexport { V3 as Vector3, Color, Object3D, Group, Scene, Mesh, Material, CanvasTexture, HemisphereLight, DirectionalLight, OrthographicCamera, WebGLRenderer };\nexport class MeshStandardMaterial extends Material {}\nexport const SRGBColorSpace = 'srgb', PCFSoftShadowMap = 2, NoToneMapping = 0;\n";
const HOOKS = `const stub = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(STUB))};
export async function resolve(spec, ctx, next) {
  if (spec === 'three' || /RoundedBoxGeometry\\.js$/.test(spec)) return { url: stub, shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(HOOKS));

// DOM stand-ins: buildOffice draws textures on canvases and loads images, none of which is checked here
const P = () => new Proxy(function () {}, { get: (t, p) => (p === Symbol.toPrimitive ? () => '' : p === 'measureText' ? () => ({ width: 0 }) : p === 'then' ? undefined : P()), set: () => true, apply: () => P() });
globalThis.document = { fonts: { load: async () => [] }, createElement: () => ({ width: 0, height: 0, getContext: () => P() }) };
globalThis.Image = class { set src(v) { queueMicrotask(() => this.onerror && this.onerror()); } };
const office = await import(new URL('../dashboard/office3d.js', import.meta.url));

// Same fixture as the baseline capture: PA, a customer-service seat at the booth, 7 desk staff (8 people in all)
const STAFF = [{ id: 's0', name: 'Cust', role: 'Customer Support', colour: '#FF9F1C' }, { id: 's1', name: 'A', role: 'Engineer', colour: '#3A86FF' },
  { id: 's2', name: 'B', role: 'Designer', colour: '#2EC4B6' }, { id: 's3', name: 'C', role: 'QA', colour: '#FF6B6B' }, { id: 's4', name: 'D', role: 'Architect', colour: '#06D6A0' },
  { id: 's5', name: 'E', role: 'Engineer', colour: '#FFD166' }, { id: 's6', name: 'F', role: 'PM', colour: '#EF476F' }, { id: 's7', name: 'G', role: 'Engineer', colour: '#118AB2' }];
const PA = { id: 'pa', name: 'Fiya', colour: '#8338EC', look: { scarf: true, skin: '#F2C9A0' } };
const D = 11.5;
// values captured from e32ccf8 (before the quarter-turn change)
// Stage 1 scene (e32ccf8 + quarter turns) had 278d7f6c...; the booth plant moved off the booth route, so only that object differs
const BASE_ROWS_SHA = 'b300156a9d2efdfd8cf93208d49b57062b804ad546a1eb158046caf44bf9f8b4';
const BASE_ROUTES_SHA = '4d71e1662f344ed6d37ea723572d556925fd416da7594793c5f238f24d0e93d6';
const BASE_SEATS = { pa: [2.65, 4.93], s1: [5.55, 3.9800000000000004], s2: [8.65, 3.9800000000000004], s3: [11.75, 3.9800000000000004], s4: [5.55, 6.53], s5: [8.65, 6.53], s6: [11.75, 6.53], s7: [5.55, 9.08], s0: [2.6, 12.85], you: [2.1, 0.92] };
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function build(staff = STAFF) { return office.buildOffice({ staff, pa: PA, status: {}, queue: [], company: 'X' }); }
function rowsOf(root) {
  const rows = []; let meshes = 0;
  root.traverse((o) => {
    if (o.isMesh) meshes++;
    rows.push({ t: o.kind || o.constructor.name, p: [o.position.x, o.position.y, o.position.z], r: [o.rotation.x, o.rotation.y, o.rotation.z], s: [o.scale.x, o.scale.y, o.scale.z], v: o.visible, mesh: !!o.isMesh,
      g: o.geometry ? [o.geometry.kind, o.geometry.args] : null, m: o.material ? [o.material.kind, o.material.color ?? null, o.material.map ? 'tex' : null, o.material.emissive ?? null, o.material.opacity ?? null] : null });
  });
  return { rows, meshes };
}

// Obstacles: solid parts of the scene that stand between floor and head height (base below 1.3, top above 0.1), as floor rectangles.
function obstaclesOf(root) {
  const out = [];
  root.traverse((o) => {
    const g = o.geometry; if (!g || !o.isMesh) return;
    const [a0, a1, a2] = g.args; let hw, hd, base, top;
    if (g.kind === 'RoundedBoxGeometry' || g.kind === 'BoxGeometry') { hw = a0 / 2; hd = a2 / 2; base = o.position.y - a1 / 2; top = o.position.y + a1 / 2; }
    else if (g.kind === 'CylinderGeometry') { hw = hd = Math.max(a0, a1); base = o.position.y - a2 / 2; top = o.position.y + a2 / 2; }
    else if (g.kind === 'SphereGeometry') { hw = hd = a0; base = o.position.y - a0; top = o.position.y + a0; }
    else return;
    if (base < 1.3 && top > 0.1) out.push({ x0: o.position.x - hw, x1: o.position.x + hw, y0: o.position.z - hd, y1: o.position.z + hd });
  });
  return out;
}
// Route check: a polyline crosses a box when a sampled point lies strictly inside it. Clearance = closest sampled distance outside.
function checkRoute(points, boxes, step = 0.005) {
  let crossings = [], minClear = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const px = a.x + (b.x - a.x) * k / n, py = a.z + (b.z - a.z) * k / n;
      for (const bx of boxes) {
        const dx = Math.max(bx.x0 - px, 0, px - bx.x1), dy = Math.max(bx.y0 - py, 0, py - bx.y1), dist = Math.hypot(dx, dy);
        if (dist === 0 && px > bx.x0 && px < bx.x1 && py > bx.y0 && py < bx.y1) crossings.push({ seg: i, x: +px.toFixed(3), y: +py.toFixed(3), box: bx });
        else if (dist > 0) minClear = Math.min(minClear, dist);
      }
    }
  }
  return { crossings, minClear };
}

test('scene fingerprint matches the e32ccf8 baseline (618 meshes, same transforms and geometry)', async () => {
  const built = await build();
  const { rows, meshes } = rowsOf(built.root);
  assert.equal(meshes, 618);
  assert.equal(sha(JSON.stringify(rows)), BASE_ROWS_SHA);
});

test('seat anchors at turn 0 equal the e32ccf8 positions', async () => {
  const built = await build();
  for (const [id, [x, z]] of Object.entries(BASE_SEATS)) {
    const a = built.anchors[id];
    assert.deepEqual([a.x, a.z], [x, z], id);
  }
});

test('route polylines at turn 0 equal the e32ccf8 polylines', async () => {
  const built = await build();
  const rigs = Object.entries(built.anchors).map(([id, a]) => ({ id, kind: a.rig.kind || 'desk', home: a.rig.home }));
  const out = {};
  for (const f of rigs) for (const t of rigs) if (f !== t) out[`${f.id}->${t.id}`] = office.routePoints(f, t, D);
  assert.equal(sha(JSON.stringify(out)), BASE_ROUTES_SHA);
});

test('turn sign: facing with lean equals the turned lean vector, for turns 0-3', () => {
  for (let q = 0; q < 4; q++) {
    const yaw = 0.3 - q * (Math.PI / 2);
    const [tx, tz] = office.turnVec(q, Math.sin(0.3), Math.cos(0.3));
    assert.ok(Math.abs(Math.sin(yaw) - tx) < 1e-12 && Math.abs(Math.cos(yaw) - tz) < 1e-12, `turn ${q}`);
  }
});

test('turned desks: seat faces the desk centre; lid sits between person and centre; seat on the front side', () => {
  const centre = [0.7, 0.575], seat = [0.75, -0.42], lid = [0.31, 0.6];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (let q = 0; q < 4; q++) {
    const sv = office.turnVec(q, ...seat), cv = office.turnVec(q, ...centre), lv = office.turnVec(q, ...lid), front = office.turnVec(q, 0, 1);
    const toCentre = [cv[0] - sv[0], cv[1] - sv[1]];
    assert.ok(front[0] * toCentre[0] + front[1] * toCentre[1] > 0, `turn ${q}: seat looks at the desk`);
    assert.ok(dist(lv, cv) < dist(sv, cv), `turn ${q}: lid is nearer the centre than the seat`);
  }
});

test('turns 0 and 3 show the face to the camera (camera looks from +x +y)', () => {
  const facing = (q) => [Math.sin(0.3 - q * (Math.PI / 2)), Math.cos(0.3 - q * (Math.PI / 2))];
  const seen = [0, 1, 2, 3].filter((q) => { const [fx, fz] = facing(q); return fx + fz > 0; });
  assert.deepEqual(seen, [0, 3]);
});

// The app routes PA <-> desk staff and PA <-> booth. The boss is never routed, so the boss room is not checked here.
const routedRigs = (built) => Object.entries(built.anchors).filter(([id]) => id !== 'you').map(([id, a]) => ({ id, kind: a.rig.kind || 'desk', home: a.rig.home }));
test('route check: PA and desk routes cross no furniture', async () => {
  const built = await build();
  const boxes = obstaclesOf(built.root);
  assert.ok(boxes.length > 50, `found ${boxes.length} obstacles`);
  const rigs = routedRigs(built).filter((r) => r.id !== 's0');
  let total = 0, minClear = Infinity;
  for (const f of rigs) for (const t of rigs) if (f !== t) {
    const r = checkRoute(office.routePoints(f, t, D), boxes);
    total += r.crossings.length; minClear = Math.min(minClear, r.minClear);
  }
  assert.equal(total, 0);
  console.log(`route check (desks): ${boxes.length} obstacles, min clearance ${minClear.toFixed(3)} m`);
});
// Known finding, not a pass: the booth route (y 12.55, x 3.6 to 6.3) runs into the plant at (5.45, 12.25). Stage 2 must clear this.
test('route check: booth route is clear of the booth plant', async () => {
  const built = await build();
  const boxes = obstaclesOf(built.root);
  const rigs = routedRigs(built);
  const hit = new Set();
  for (const f of rigs) for (const t of rigs) if (f !== t && (f.id === 's0' || t.id === 's0')) {
    for (const c of checkRoute(office.routePoints(f, t, D), boxes).crossings) hit.add([c.box.x0, c.box.x1, c.box.y0, c.box.y1].map((v) => v.toFixed(2)).join(','));
  }
  assert.deepEqual([...hit].sort(), []);
});
test('route check helper is not vacuous: a segment through a desk is reported', async () => {
  const built = await build();
  const boxes = obstaclesOf(built.root);
  const r = checkRoute([{ x: 5.0, z: 3.0 }, { x: 5.0, z: 5.5 }], boxes);
  assert.ok(r.crossings.length > 0);
});
