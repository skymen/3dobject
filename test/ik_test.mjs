// Headless tests of the worker sampler code (v1 src/c3runtime/gltfWorker.js, or v2 with WORKER=...):
// IK on the UTRS skeleton (end on target, bone lengths, bend side, restore, reach, end alignment, weight, pole)
// and the crossfade from a blend-weight pose (jump mix -> fall). Needs three (any node_modules with it: THREE=...).
//   node test/ik_test.mjs [glb]     WORKER=path/to/gltfWorker.js THREE=path/to/three.module.js
import fs from "node:fs";
const W = fs.readFileSync(process.env.WORKER || new URL("../src/c3runtime/gltfWorker.js", import.meta.url), "utf8");
const lib = new Function(W.slice(W.indexOf("const TRS_STRIDE = 10"), W.indexOf("let graph = null")) + `
return { IK_STRIDE, prepareAnimation, initTRS, createSamplerState, sampleAnimation, applyIK, ikRestore, ikWorld, applyJiggle }`)();
const glbPath = process.argv[2] || "/Users/ossama/Documents/Under The Red Sky/files/glb/utrsChar_stubs.glb";
const buf = fs.readFileSync(glbPath);
const jl = buf.readUInt32LE(12), g = JSON.parse(buf.subarray(20, 20 + jl).toString()), bin = 20 + jl + 8;
const acc = (i) => { const A = g.accessors[i], v = g.bufferViews[A.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type] * A.count, off = bin + (v.byteOffset || 0) + (A.byteOffset || 0);
  return { data: new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4)), min: A.min, max: A.max }; };
const nodes = g.nodes.map((n) => ({ ...n })), idxOf = new Map(nodes.map((n, i) => [n, i]));
const parentIdx = new Int32Array(nodes.length).fill(-1);
g.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentIdx[c] = i)));
const anims = g.animations.map((an) => lib.prepareAnimation({ name: an.name, channels: an.channels.map((c) => { const s = an.samplers[c.sampler]; return { target: { node: nodes[c.target.node], path: c.target.path }, sampler: { input: acc(s.input), output: { data: acc(s.output).data } } }; }) }, idxOf));
const ai = (n) => anims.findIndex((a) => a.name === n);
const ni = (n) => g.nodes.findIndex((x) => x.name === n);
const pose = (clip, t) => { const trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes); const st = lib.createSamplerState(anims); const i = ai(clip); lib.sampleAnimation(st, anims[i], i, t, 0, 0, true, trs); return trs; };
const world = (trs, i) => { const p = new Float64Array(3), r = new Float64Array(4), s = new Float64Array(3); lib.ikWorld(trs, parentIdx, i, p, r, s); return { p, r, s }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rot = (q, v) => { const [x, y, z] = v, [qx, qy, qz, qw] = q; const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x); return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx]; };
let fails = 0; const check = (ok, m) => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + m); };
const chain = (u, l, e, target, o = {}) => new Float32Array([ni(u), ni(l), ni(e), ...target, ...(o.pole || [NaN, NaN, NaN]), o.weight ?? 1, ...(o.axis || [0, 0, 0]), ...(o.dir || [0, 0, 0]), o.ew ?? 0, ...(o.axis2 || [0, 0, 0]), ...(o.dir2 || [0, 0, 0]), ...(o.hinge || [0, 0, 0]), ...[0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, NaN].slice(0, lib.IK_STRIDE - 26)]); // (+ follow fields, >= 3.0.64: none)

for (const clip of ["utrs_idle_120", "utrs_run_60"]) {
  const trs = pose(clip, 0.3);
  const ank = world(trs, ni("footA.L")).p, knee0 = world(trs, ni("legB1.L")).p, hip = world(trs, ni("legA1.L")).p;
  const L = dist(hip, knee0) + dist(knee0, ank);
  const target = [ank[0] + (hip[0] - ank[0]) * 0.12 + L * 0.05, ank[1] + (hip[1] - ank[1]) * 0.12 + L * 0.04, ank[2] + (hip[2] - ank[2]) * 0.12];
  const info = new Float32Array(4), saved = new Map();
  lib.applyIK(trs, parentIdx, chain("legA1.L", "legB1.L", "footA.L", target), 0, 1, saved, info);
  const got = world(trs, ni("footA.L")).p, knee1 = world(trs, ni("legB1.L")).p;
  check(dist(got, target) < L * 0.002, `${clip}: ankle on target`);
  check(Math.abs(dist(hip, knee1) - dist(hip, knee0)) < L * 1e-3 && Math.abs(dist(knee1, got) - dist(knee0, ank)) < L * 1e-3, `${clip}: bone lengths kept`);
  const side = (k) => { const ax = [ank[0] - hip[0], ank[1] - hip[1], ank[2] - hip[2]], kv = [k[0] - hip[0], k[1] - hip[1], k[2] - hip[2]], t = (kv[0] * ax[0] + kv[1] * ax[1] + kv[2] * ax[2]) / (ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2); return [kv[0] - ax[0] * t, kv[1] - ax[1] * t, kv[2] - ax[2] * t]; };
  const s0 = side(knee0), s1 = side(knee1);
  check(s0[0] * s1[0] + s0[1] * s1[1] + s0[2] * s1[2] > 0, `${clip}: knee bends the same way`);
  check(Math.abs(info[0] - ank[0]) + Math.abs(info[1] - ank[1]) < 1e-3, `${clip}: info has the animated ankle`);
  lib.ikRestore(trs, saved);
  check(dist(world(trs, ni("footA.L")).p, ank) < 1e-4, `${clip}: restore puts the animated pose back`);
}
{
  const trs = pose("utrs_idle_120", 0.3), hip = world(trs, ni("legA1.L")).p;
  lib.applyIK(trs, parentIdx, chain("legA1.L", "legB1.L", "footA.L", [hip[0], hip[1] - 1000, hip[2]]), 0, 1, null, null);
  const a = world(trs, ni("footA.L")).p;
  check(a.every(Number.isFinite) && a[1] < hip[1], "out of reach: straight toward the target, finite");
}
{
  const trs = pose("utrs_idle_120", 0.3), e = world(trs, ni("footA.L"));
  const axis = rot([-e.r[0], -e.r[1], -e.r[2], e.r[3]], [0, 0, 1]), n = [Math.sin(0.4), 0, Math.cos(0.4)];
  lib.applyIK(trs, parentIdx, chain("legA1.L", "legB1.L", "footA.L", e.p, { axis, dir: n, ew: 1 }), 0, 1, null, null);
  const e2 = world(trs, ni("footA.L")), up = rot(e2.r, axis);
  check(Math.acos(Math.min(1, up[0] * n[0] + up[1] * n[1] + up[2] * n[2])) < 0.01, "end alignment: sole onto the slope normal");
}
{
  const t0 = pose("utrs_idle_120", 0.3), ank = world(t0, ni("footA.L")).p, target = [ank[0], ank[1] + 20, ank[2] + 10];
  lib.applyIK(t0, parentIdx, chain("legA1.L", "legB1.L", "footA.L", target, { weight: 0.5 }), 0, 1, null, null);
  const h = world(t0, ni("footA.L")).p;
  check(dist(h, ank) > 3 && dist(h, target) > 3, "weight 0.5: in between");
}
{
  const trs = pose("utrs_idle_120", 0.3), sh = world(trs, ni("armA1.L")).p;
  const target = [sh[0] + 20, sh[1] - 15, sh[2] - 30], pole = [sh[0], sh[1] + 100, sh[2]];
  lib.applyIK(trs, parentIdx, chain("armA1.L", "armB1.L", "hand.L", target, { pole }), 0, 1, null, null);
  const el = world(trs, ni("armB1.L")).p;
  check(dist(world(trs, ni("hand.L")).p, target) < 0.5, "arm: hand on target");
  check(el[1] > sh[1], "arm: elbow toward the pole");
}
// end orientation from two axes: the palm (-Z) flat on a wall facing +X, the fingers (+Y) pointing up
{
  const trs = pose("utrs_idle_120", 0.3), sh = world(trs, ni("armA1.L")).p;
  const target = [sh[0] + 25, sh[1] - 10, sh[2] - 10];
  const n = [1, 0, 0], up = [0, 0, 1];
  lib.applyIK(trs, parentIdx, chain("armA1.L", "armB1.L", "hand.L", target, { axis: [0, 0, -1], dir: n, ew: 1, axis2: [0, 1, 0], dir2: up }), 0, 1, null, null);
  const r = world(trs, ni("hand.L")).r, palm = rot(r, [0, 0, -1]), fing = rot(r, [0, 1, 0]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  check(dot(palm, n) > 0.999, `two axes: palm onto the wall normal (${dot(palm, n).toFixed(4)})`);
  check(dot(fing, up) > 0.999, `two axes: fingers up (${dot(fing, up).toFixed(4)})`);
}
// jiggle: still -> the animated pose; a sudden move swings the bone (within maxAngle); then it settles back
{
  const trs = pose("utrs_idle_120", 0.3), i = ni("jacket_back"), rest = Array.from(trs.slice(i * 10 + 3, i * 10 + 7));
  const rec = { trs };
  const M = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  // (the slot's section after its count: dt, model matrix, then the bones)
  const data = (x, g = 0) => new Float32Array([1 / 60, ...M(x), i, 150, 10, (30 * Math.PI) / 180, 20, g, 0, 1, 0, -1, 1, NaN, NaN, NaN, NaN, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ang = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[0] * rest[0] + q[1] * rest[1] + q[2] * rest[2] + q[3] * rest[3]) / (Math.hypot(...q) * Math.hypot(...rest))))) * 180 / Math.PI;
  const step = (x) => { const saved = new Map(); lib.applyJiggle(rec, parentIdx, data(x), 0, 1, saved); const q = Array.from(trs.slice(i * 10 + 3, i * 10 + 7)); lib.ikRestore(trs, saved); return q; };
  let q = step(0); for (let k = 0; k < 30; k++) q = step(0);
  check(ang(q) < 0.5, `jiggle: still, the animated pose (${ang(q).toFixed(2)} deg)`);
  let worst = 0; for (let k = 1; k <= 20; k++) { q = step(k * 15); worst = Math.max(worst, ang(q)); }
  check(worst > 3 && worst <= 30.5, `jiggle: moving, swings within maxAngle (${worst.toFixed(1)} deg)`);
  for (let k = 0; k < 240; k++) q = step(300);
  check(ang(q) < 0.5, `jiggle: settles back (${ang(q).toFixed(2)} deg)`);
  // gravity sags the tip below its animated position (a steady offset), 0 = none
  const stepG = (g) => { const saved = new Map(); lib.applyJiggle(rec, parentIdx, data(300, g), 0, 1, saved); const r = Array.from(trs.slice(i * 10 + 3, i * 10 + 7)); lib.ikRestore(trs, saved); return r; };
  for (let k = 0; k < 240; k++) q = stepG(1500);
  const sag = ang(q);
  for (let k = 0; k < 240; k++) q = stepG(0);
  check(sag > 2 && ang(q) < 0.5, `jiggle gravity: sags ${sag.toFixed(1)} deg, back to the pose without`);
}
// jiggle anchor: the hammer (on the thigh) keeps its bind-pose angle to the hips, whatever the thigh does
{
  const base = lib.initTRS(new Float32Array(nodes.length * 10), nodes), i = ni("leg_hammer"), hip = ni("spine1");
  const rel = (trs) => { const a = world(trs, hip).r, b = world(trs, i).r; const c = [-a[0], -a[1], -a[2], a[3]];
    return [c[3] * b[0] + c[0] * b[3] + c[1] * b[2] - c[2] * b[1], c[3] * b[1] - c[0] * b[2] + c[1] * b[3] + c[2] * b[0], c[3] * b[2] + c[0] * b[1] - c[1] * b[0] + c[2] * b[3], c[3] * b[3] - c[0] * b[0] - c[1] * b[1] - c[2] * b[2]]; };
  const r0 = rel(base), tip = (q) => rot(q, [0, 1, 0]), angDir = (a, b) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const [w, lo, hi] of [[1, 0, 0.5], [0.5, 1, 1e9]]) {
    let worst = 0, animated = 0;
    const rec = { trs: null };
    for (let f = 0; f < 120; f++) {
      const trs = pose("utrs_run_60", f / 60); rec.trs = trs;
      animated = Math.max(animated, angDir(tip(rel(trs)), tip(r0)));
      lib.applyJiggle(rec, parentIdx, new Float32Array([1 / 60, ...I, i, 400, 40, 0.001, 20, 0, 0, 1, 0, hip, w, NaN, NaN, NaN, NaN, 0, 0, 0, 0, 0, 0, 0, 0]), 0, 1, null, base);
      if (f > 60) worst = Math.max(worst, angDir(tip(rel(trs)), tip(r0)));
    }
    check(worst >= lo && worst < (hi === 1e9 ? animated - 5 : hi), `jiggle anchor weight ${w}: hammer vs hips ${worst.toFixed(1)} deg off rest (animated: ${animated.toFixed(0)})`);
  }
}
// jiggle limit: the jacket back never swings into the body (spine2 +Z) past its rest direction
{
  const trs = pose("utrs_idle_120", 0.3), i = ni("jacket_back"), rec = { trs };
  const M = (y) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1];
  const inward = () => { const p = world(trs, ni("spine2")).r, b = world(trs, i).r, c = [-p[0], -p[1], -p[2], p[3]]; const d = rot(c, rot(b, [0, 1, 0])), r = rot(Array.from(trs.slice(i * 10 + 3, i * 10 + 7)), [0, 1, 0]); return d; };
  const run = (lim) => {
    const saved = new Map(); let worst = -90, y = 0; const restD = rot(Array.from(trs.slice(i * 10 + 3, i * 10 + 7)), [0, 1, 0]);
    for (let f = 0; f < 120; f++) {
      y += f < 60 ? -12 : 0; // forward (model -Y) then a hard stop: the tip swings forward, into the back
      lib.ikRestore(trs, saved);
      const lp = lim === null ? [0, 0, 0, 0] : [0, 0, 1, lim * Math.PI / 180];
      lib.applyJiggle(rec, parentIdx, new Float32Array([1 / 60, ...M(y), i, 90, 4, Math.PI / 4, 25, 0, 0, 1, 0, -1, 1, NaN, NaN, NaN, NaN, 0, 0, 0, ...lp, 0]), 0, 1, saved);
      const d = inward(), ca = d[0] * restD[0] + d[1] * restD[1] + d[2] * restD[2];
      worst = Math.max(worst, Math.atan2(d[2] - restD[2] * ca, ca) * 180 / Math.PI);
    }
    lib.ikRestore(trs, saved);
    return worst;
  };
  const free = run(null), held = run(0), off = run(-5);
  check(free > 5 && held < 0.5 && off < -4.5, `jiggle limit: into the body ${free.toFixed(1)} deg free, ${held.toFixed(1)} at limit 0, ${off.toFixed(1)} at -5`);
}
// jiggle anchor pose + tilt + axis: the bone keeps exactly that rotation to the anchor; a tilt turns it about the
// bone's own axes; the tip axis is what springs (and what maxAngle measures)
{
  const base = lib.initTRS(new Float32Array(nodes.length * 10), nodes), i = ni("leg_hammer"), hip = ni("spine1");
  const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const rel = (trs) => qmul([-world(trs, hip).r[0], -world(trs, hip).r[1], -world(trs, hip).r[2], world(trs, hip).r[3]], world(trs, i).r);
  const qang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const pose = [-0.4941, -0.3417, -0.796, -0.0738], pl = Math.hypot(...pose), P = pose.map((x) => x / pl);
  const axis = [-0.619, 0.57, -0.54];
  const run = (tilt) => {
    let worst = 0, tipWorst = 0;
    const rec = { trs: null };
    for (let f = 0; f < 90; f++) {
      const trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes), st = lib.createSamplerState(anims), a = ai("utrs_run_60");
      lib.sampleAnimation(st, anims[a], a, f / 60, 0, 0, true, trs); rec.trs = trs;
      lib.applyJiggle(rec, parentIdx, new Float32Array([1 / 60, ...I, i, 400, 40, 0.001, 50, 0, ...axis, hip, 1, ...pose, ...tilt, 0, 0, 0, 0, 0]), 0, 1, null, base);
      if (f < 30) continue;
      // the tip direction against the target pose's (the twist about the tip axis stays the animation's)
      const want = rot(qmul(world(trs, hip).r, P), axis), got = rot(world(trs, i).r, axis);
      const n = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
      const w = n(want), g2 = n(got);
      tipWorst = Math.max(tipWorst, Math.acos(Math.min(1, w[0] * g2[0] + w[1] * g2[1] + w[2] * g2[2])) * 180 / Math.PI);
      worst = Math.max(worst, qang(rel(trs), P));
    }
    return { tipWorst, worst };
  };
  const r0 = run([0, 0, 0]), r1 = run([0.3, 0, 0]);
  check(r0.tipWorst < 0.5 && r1.tipWorst > 10, `jiggle anchor pose: tip on the pose's ${r0.tipWorst.toFixed(2)} deg; tilted 17 deg about X: ${r1.tipWorst.toFixed(1)} deg off it`);
}
// jiggle drag: a steady move leaves the tip behind with drag (air), not without (damping is relative)
{
  const trs = pose("utrs_idle_120", 0.3), i = ni("jacket_back"), rec = { trs }, rest = Array.from(trs.slice(i * 10 + 3, i * 10 + 7));
  const ang = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[0] * rest[0] + q[1] * rest[1] + q[2] * rest[2] + q[3] * rest[3]) / (Math.hypot(...q) * Math.hypot(...rest))))) * 180 / Math.PI;
  const steady = (drag) => {
    rec.jig = null; let q = rest;
    for (let f = 0; f < 240; f++) { const saved = new Map(); lib.applyJiggle(rec, parentIdx, new Float32Array([1 / 60, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -f * 12, 0, 1, i, 90, 9, Math.PI / 4, 25, 0, 0, 1, 0, -1, 1, NaN, NaN, NaN, NaN, 0, 0, 0, 0, 0, 0, 0, drag]), 0, 1, saved); q = Array.from(trs.slice(i * 10 + 3, i * 10 + 7)); lib.ikRestore(trs, saved); }
    return ang(q);
  };
  const a0 = steady(0), a1 = steady(3);
  check(a0 < 0.5 && a1 > 5, `jiggle drag: steady 720 px/s, ${a0.toFixed(2)} deg behind without drag, ${a1.toFixed(1)} with drag 3`);
}
// crossfade out of a blend-weight pose: the first frame of the new clip is still the old (mixed) pose
{
  const st = lib.createSamplerState(anims), trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes);
  const mix = (names) => ({ count: names.length, anims: names.map((n) => anims[ai(n)]), idx: names.map(ai), w: names.map(() => 1 / names.length) });
  const foot = ni("legA1.L") * 10 + 3, q = () => Array.from(trs.slice(foot, foot + 4));
  const ang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (Math.hypot(...a) * Math.hypot(...b)))) * 180) / Math.PI;
  const jm = ai("utrs_jump_l_50") >= 0 ? ["utrs_jump_l_50"] : ["utrs_jump_50"];
  for (let k = 0; k < 8; k++) lib.sampleAnimation(st, anims[ai("utrs_jump_50")], ai("utrs_jump_50"), k / 60, 1 / 60, 0.1, false, trs, mix(jm));
  const before = q();
  lib.sampleAnimation(st, anims[ai("utrs_fall_60")], ai("utrs_fall_60"), 1 / 60, 1 / 60, 0.3, true, trs, mix(["utrs_fall_60"]));
  check(ang(before, q()) < 1, `crossfade: the fall's first frame is still the jump pose (${ang(before, q()).toFixed(2)} deg)`);
}
// hinge: a pole far from the animation's bend plane: the elbow must still bend about its own hinge (no sideways
// forearm); without hingeAxis the swing carries the animated hinge and the elbow turns sideways
{
  const K = [0.266, 0.019, -0.964]; // armB1.L's hinge (lower-bone local), measured on the clips
  const run = (hinge) => {
    const trs = pose("utrs_surf_l_60", 0.2);
    const A = world(trs, ni("armA1.L")).p, B = world(trs, ni("armB1.L")).p, C = world(trs, ni("hand.L")).p;
    const L = dist(A, B) + dist(B, C);
    // target: forward-down at 75% reach; pole: rotated 100 deg from the animated elbow about the reach axis
    const target = [A[0] + L * 0.5, A[1] - L * 0.2, A[2] - L * 0.5];
    const u = [target[0] - A[0], target[1] - A[1], target[2] - A[2]], ul = Math.hypot(...u); u.forEach((x, i) => (u[i] = x / ul));
    const e = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], k = e[0] * u[0] + e[1] * u[1] + e[2] * u[2];
    let v = [e[0] - u[0] * k, e[1] - u[1] * k, e[2] - u[2] * k]; const vl = Math.hypot(...v) || 1; v = v.map((x) => x / vl);
    const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const c = Math.cos((100 * Math.PI) / 180), sn = Math.sin((100 * Math.PI) / 180);
    const pd = [v[0] * c + w[0] * sn, v[1] * c + w[1] * sn, v[2] * c + w[2] * sn];
    const pole = [A[0] + u[0] * L * 0.4 + pd[0] * L, A[1] + u[1] * L * 0.4 + pd[1] * L, A[2] + u[2] * L * 0.4 + pd[2] * L];
    lib.applyIK(trs, parentIdx, chain("armA1.L", "armB1.L", "hand.L", target, { pole, hinge: hinge ? K : null }), 0, 1, null, null);
    const a = world(trs, ni("armA1.L")).p, b = world(trs, ni("armB1.L")), cc = world(trs, ni("hand.L")).p;
    const eU = [b.p[0] - a[0], b.p[1] - a[1], b.p[2] - a[2]], eL = [cc[0] - b.p[0], cc[1] - b.p[1], cc[2] - b.p[2]];
    const n = [eU[1] * eL[2] - eU[2] * eL[1], eU[2] * eL[0] - eU[0] * eL[2], eU[0] * eL[1] - eU[1] * eL[0]], nl = Math.hypot(...n);
    const h = rot(b.r, K), hl = Math.hypot(...h);
    return { onTarget: dist(cc, target) < L * 0.002, hingeDot: (n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) / (nl * hl), elbowToPole: (b.p[0] - a[0]) * pd[0] + (b.p[1] - a[1]) * pd[1] + (b.p[2] - a[2]) * pd[2] > 0 };
  };
  const off = run(false), on = run(true);
  check(on.onTarget && on.elbowToPole && on.hingeDot > 0.999, `hinge: hand on target, elbow toward the pole, a clean hinge (axis . bend ${on.hingeDot.toFixed(3)}; without: ${off.hingeDot.toFixed(3)})`);
}

// a weighted clip at its own phase (setAnimationBlendPhase): the same pose whatever the playing clip's time
{
  const at = (t, ph) => {
    const trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes), st = lib.createSamplerState(anims), i = ai("utrs_idle_120");
    const mix = { count: 1, anims: [anims[ai("utrs_vault_l_60")]], idx: [ai("utrs_vault_l_60")], w: [1], ph: [ph] };
    lib.sampleAnimation(st, anims[i], i, t, 0, 0, true, trs, mix);
    return world(trs, ni("hand.L")).p;
  };
  const fixedA = at(0.1, 0.9), fixedB = at(1.5, 0.9), freeA = at(0.1, NaN), freeB = at(1.5, NaN);
  check(dist(fixedA, fixedB) < 1e-4 && dist(freeA, freeB) > 1e-3, `blend phase: fixed ${dist(fixedA, fixedB).toFixed(5)} apart, following the playing clip ${dist(freeA, freeB).toFixed(3)}`);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
