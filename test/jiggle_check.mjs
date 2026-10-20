// Headless jiggle measurements on the UTRS skeleton with the real worker code (v1 src/c3runtime/gltfWorker.js,
// or v2 with WORKER=...): the model runs (utrs_run_60), stops, turns; prints per scenario how far the hammer
// swings relative to the hips (spine1) and how far the jacket back swings into the body (toward spine2's +Z).
//   node test/jiggle_check.mjs [glb]   JIG='{"leg_hammer":{...}}' overrides the bones' params
import fs from "node:fs";
const W = fs.readFileSync(process.env.WORKER || new URL("../src/c3runtime/gltfWorker.js", import.meta.url), "utf8");
const lib = new Function(W.slice(W.indexOf("const TRS_STRIDE = 10"), W.indexOf("let graph = null")) + `
return { prepareAnimation, initTRS, createSamplerState, sampleAnimation, ikWorld, applyJiggle, ikRestore, JIG_STRIDE }`)();
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
const baseTRS = lib.initTRS(new Float32Array(nodes.length * 10), nodes);
const world = (trs, i) => { const p = new Float64Array(3), r = new Float64Array(4), s = new Float64Array(3); lib.ikWorld(trs, parentIdx, i, p, r, s); return { p, r, s }; };
const rot = (q, v) => { const [x, y, z] = v, [qx, qy, qz, qw] = q; const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x); return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx]; };
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DEG = 180 / Math.PI;

// animBlend.js jiggleTuning (keep in step), JIG env overrides
const BONES = {
  jacket_back: { stiffness: 90, damping: 9, maxAngle: 30, length: 25, gravity: 0 },
  "jacket_side.L": { stiffness: 110, damping: 9, maxAngle: 25, length: 20, gravity: 0 },
  "jacket_side.R": { stiffness: 110, damping: 9, maxAngle: 25, length: 20, gravity: 0 },
  necklace: { stiffness: 140, damping: 10, maxAngle: 20, length: 12, gravity: 0 },
  leg_hammer: { stiffness: 160, damping: 11, maxAngle: 20, length: 20, gravity: 0 },
};
if (process.env.JIG) for (const [k, v] of Object.entries(JSON.parse(process.env.JIG))) BONES[k] = { ...BONES[k], ...v };
const PACK = Object.entries(BONES);
const extra = (p) => [p.anchor ? ni(p.anchor) : -1, p.anchorWeight ?? 1, ...(p.anchorPose || [NaN, NaN, NaN, NaN]), ...(p.anchorTilt || [0, 0, 0]).map((v) => v / DEG), ...(p.limitAxis || [0, 0, 0]), (p.limitAngle ?? 0) / DEG, p.drag ?? 0];
function jigData(dt, M) {
  const d = [PACK.length, dt, ...M];
  for (const [n, p] of PACK) d.push(ni(n), p.stiffness, p.damping, p.maxAngle / DEG, p.length, p.gravity, ...(p.axis || [0, 1, 0]), ...extra(p));
  return new Float32Array(d);
}
const PX = 1.1;
const modelMatrix = (x, y, yaw) => { const c = Math.cos(yaw) * PX, s = Math.sin(yaw) * PX; return [c, s, 0, 0, -s, c, 0, 0, 0, 0, PX, 0, x, y, 0, 1]; };

// hammer rest direction in the hips' (spine1) frame, and two axes across it: fore/aft (spine1 Z) and sideways
const restW = (n) => world(baseTRS, ni(n));
const HR = (() => { const hp = restW("spine1"), hm = restW("leg_hammer"); return rot(conj(hp.r), rot(hm.r, [0, 1, 0])); })();
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const HS = nrm(cross([0, 0, 1], HR)), HF = nrm(cross(HR, HS));
// scenario: speed(t) px/s and yaw(t) rad (forward = model -Y turned by yaw)
function run(name, T, speedAt, yawAt, clip = "utrs_run_60") {
  const rec = { trs: lib.initTRS(new Float32Array(nodes.length * 10), nodes) }, st = lib.createSamplerState(anims), saved = new Map();
  const dt = 1 / 60, a = ai(clip);
  let x = 0, y = 0, at = 0;
  const hamDir0 = [], ham = { min: Infinity, max: -Infinity, side: [Infinity, -Infinity] }, jac = { inward: -Infinity, at: 0 };
  for (let f = 0; f < T * 60; f++) {
    const t = f * dt, yaw = yawAt(t), sp = speedAt(t);
    const fwd = [Math.sin(yaw), -Math.cos(yaw)]; // model -Y turned by yaw
    x += fwd[0] * sp * dt; y += fwd[1] * sp * dt;
    lib.ikRestore(rec.trs, saved);
    at += dt * 3.5 * Math.max(0.3, sp / 700);
    lib.sampleAnimation(st, anims[a], a, at, 0, 0, true, rec.trs);
    lib.applyJiggle(rec, parentIdx, jigData(dt, modelMatrix(x, y, yaw)), 1, PACK.length, saved, baseTRS);
    if (t < 1) continue; // settle
    // hammer: its +Y in the spine1 (hips) frame: pitch angle (fore/aft swing) about the hips
    const hip = world(rec.trs, ni("spine1")), h = world(rec.trs, ni("leg_hammer"));
    const dir = rot(conj(hip.r), rot(h.r, [0, 1, 0]));
    // angle from the rest direction (in the hips' frame), split into fore/aft (about spine1 X) and sideways
    const pitch = Math.atan2(dot(dir, HF), dot(dir, HR)) * DEG, side = Math.atan2(dot(dir, HS), dot(dir, HR)) * DEG;
    ham.min = Math.min(ham.min, pitch); ham.max = Math.max(ham.max, pitch); ham.side[0] = Math.min(ham.side[0], side); ham.side[1] = Math.max(ham.side[1], side);
    // jacket back: its +Y vs the animated one, component toward spine2 +Z (into the body)
    const sp2 = world(rec.trs, ni("spine2")), jb = world(rec.trs, ni("jacket_back"));
    const jd = rot(conj(sp2.r), rot(jb.r, [0, 1, 0]));
    const restJ = rot(baseTRS.subarray(ni("jacket_back") * 10 + 3, ni("jacket_back") * 10 + 7), [0, 1, 0]); // animated local = rest (clips key it at rest)
    const inward = Math.atan2(jd[2] - restJ[2] * dot(jd, restJ), dot(jd, restJ)) * DEG; // + = into the body (spine2 +Z)
    if (inward > jac.inward) { jac.inward = inward; jac.at = t; }
  }
  console.log(`${name.padEnd(16)} hammer pitch vs hips ${ham.min.toFixed(0)}..${ham.max.toFixed(0)} (range ${(ham.max - ham.min).toFixed(0)} deg), side ${ham.side[0].toFixed(0)}..${ham.side[1].toFixed(0)} | jacket back max into body ${jac.inward.toFixed(1)} deg at ${jac.at.toFixed(2)} s`);
}
console.log("JIG_STRIDE", lib.JIG_STRIDE);
const rest = (n) => rot(baseTRS.subarray(ni(n) * 10 + 3, ni(n) * 10 + 7), [0, 1, 0]);
console.log("jacket_back +Y in spine2:", rest("jacket_back").map((v) => v.toFixed(2)).join(" "), "| spine2 child offset", [...baseTRS.subarray(ni("jacket_back") * 10, ni("jacket_back") * 10 + 3)].map((v) => v.toFixed(2)).join(" "));
run("steady run", 4, () => 700, () => 0);
run("stop", 4, (t) => (t < 2 ? 700 : 0), () => 0);
run("start", 4, (t) => (t < 2 ? 0 : 700), () => 0);
run("turn 180", 4, () => 700, (t) => (t < 2 ? 0 : Math.PI));
run("spin in place", 4, () => 0, (t) => t * 6);
run("idle", 4, () => 0, () => 0, "utrs_idle_120");
