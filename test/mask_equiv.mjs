// (mask variant, 3.0.62 setMainThreadNodes) the same gltfWorker.js sampled twice, B with the main-thread channel mask
// of UTRS's body-IK bones: the masked bones' TRS must be bit-identical (the others are left alone by design).
//   node test/mask_equiv.mjs <gltfWorker.js> <same gltfWorker.js> [glb] [steps]
// Bit-exactness of the 3DObject worker sampler / IK code: the 3.0.60 snapshot vs the modified source, fed the same
// randomized sequence (clip changes, crossfades, blend mixes with weights and phases, exact keyframe times, bone
// offsets, IK chains, restore cycles like onBatch). Compares the TRS array bit for bit after every step.
//   node test/worker_equiv.mjs <old gltfWorker.js> <new gltfWorker.js> [glb] [steps]
// (both SOURCE files: the test slices the sampler code out of them, so a minified dist copy won't do. To get an old
// one: `git show <rev>:src/c3runtime/gltfWorker.js > /tmp/old.js`, or keep a copy of src before editing)
import fs from "node:fs";
const [oldPath, newPath, glbPath = "/Users/ossama/Documents/Under The Red Sky/files/glb/utrsChar.glb", stepsArg = "20000"] = process.argv.slice(2);
const MASK_BONES = ["legA1.L", "legB1.L", "footA.L", "legA1.R", "legB1.R", "footA.R", "armA1.L", "armB1.L", "hand.L", "armA1.R", "armB1.R", "hand.R", "head", "spine3", "armA1.L", "armA1.R"];
const load = (p) => {
  const W = fs.readFileSync(p, "utf8");
  return new Function(W.slice(W.indexOf("const TRS_STRIDE = 10"), W.indexOf("let graph = null")) + `
return { prepareAnimation, initTRS, createSamplerState, sampleAnimation, applyIK, ikRestore, applyBoneOffsets, restoreBoneOffsets }`)();
};
const libs = [load(oldPath), load(newPath)];
const buf = fs.readFileSync(glbPath);
const jl = buf.readUInt32LE(12), g = JSON.parse(buf.subarray(20, 20 + jl).toString()), bin = 20 + jl + 8;
const acc = (i) => { const A = g.accessors[i], v = g.bufferViews[A.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type] * A.count, off = bin + (v.byteOffset || 0) + (A.byteOffset || 0);
  return { data: new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4)), min: A.min, max: A.max }; };
// each lib gets its own copy of the animation objects (prepareAnimation caches on them)
const build = (lib) => {
  const nodes = g.nodes.map((n) => ({ ...n })), idxOf = new Map(nodes.map((n, i) => [n, i]));
  const anims = g.animations.map((an) => lib.prepareAnimation({ name: an.name, channels: an.channels.map((c) => { const s = an.samplers[c.sampler]; return { target: { node: nodes[c.target.node], path: c.target.path }, sampler: { input: acc(s.input), output: { data: acc(s.output).data } } }; }) }, idxOf));
  return { nodes, anims };
};
const sets = libs.map(build);
const parentIdx = new Int32Array(g.nodes.length).fill(-1);
g.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentIdx[c] = i)));
const ni = (n) => g.nodes.findIndex((x) => x.name === n);
const names = g.animations.map((a) => a.name);
// the blend-tree families share a channel layout: mix within one family like the game does
const fam = (re) => names.map((n, i) => (re.test(n) ? i : -1)).filter((i) => i >= 0);
const families = [fam(/^utrs_(run|jog|idle|skid|land_soft)/), fam(/^utrs_(jump|fall)/), fam(/^utrs_surf/), fam(/^utrs_vault/), names.map((_, i) => i)];
let seed = 1234567;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickOf = (a) => a[Math.floor(rnd() * a.length)];
const steps = +stepsArg;
// the shared random input sequence
const seq = [];
let drv = families[0][0], time = 0, fam0 = families[0];
for (let s = 0; s < steps; s++) {
  if (rnd() < 0.05) { fam0 = pickOf(families); drv = pickOf(fam0); if (rnd() < 0.5) time = 0; }
  const dt = rnd() < 0.05 ? 0 : rnd() * 0.04;
  time += dt;
  // sometimes exactly on a keyframe time of the driver's first channel
  let t = time;
  if (rnd() < 0.1) { const ch = g.animations[drv].channels[0], inp = acc(g.animations[drv].samplers[ch.sampler].input).data; t = inp[Math.floor(rnd() * inp.length)]; }
  const mix = rnd() < 0.8 ? (() => { const k = 1 + Math.floor(rnd() * 6), idx = [], w = [], ph = []; for (let j = 0; j < k; j++) { idx.push(pickOf(fam0)); w.push(rnd() < 0.15 ? 0 : rnd()); ph.push(rnd() < 0.7 ? NaN : rnd() < 0.2 ? 1 : rnd()); } return { idx, w, ph }; })() : null;
  const blend = rnd() < 0.2 ? 0 : rnd() < 0.3 ? 0.001 : rnd() * 0.5;
  const loop = rnd() < 0.85;
  const offs = rnd() < 0.7 ? [["spine2", rnd() - 0.5], ["spine3", rnd() - 0.5], ["head", rnd() - 0.5]].map(([b, a]) => { const h = a * 0.5; return [ni(b), Math.sin(h), 0, 0, Math.cos(h)]; }) : null;
  const ik = rnd() < 0.7 ? ["L", "R"].flatMap((sd) => rnd() < 0.8 ? [[ni("legA1." + sd), ni("legB1." + sd), ni("footA." + sd), (rnd() - 0.5) * 60, (rnd() - 0.5) * 60, rnd() * 20, ...(rnd() < 0.5 ? [NaN, NaN, NaN] : [rnd() * 50, -40, 40]), rnd() < 0.2 ? rnd() : 1, ...(rnd() < 0.5 ? [0, 0, 1, rnd() - 0.5, rnd() - 0.5, 1, rnd()] : [0, 0, 0, 0, 0, 0, 0]), 0, 0, 0, 0, 0, 0, ...(rnd() < 0.5 ? [-1, 0.009, 0.014] : [0, 0, 0])]] : []) : null;
  const restore = rnd() < 0.9; // onBatch restores IK/offsets before resampling
  seq.push({ drv, t, dt, mix, blend, loop, offs, ik, restore });
}
const run = (k, useMask) => {
  const lib = libs[k], { nodes, anims } = sets[k];
  const need = new Set();
  for (const b of MASK_BONES) for (let i = ni(b); i >= 0 && !need.has(i); i = parentIdx[i]) need.add(i);
  const masks = new Map();
  const maskOf = (ai) => { if (!useMask) return undefined; let m = masks.get(ai); if (!m) { const t = anims[ai]._targetIdx; m = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) m[i] = t[i] >= 0 && need.has(t[i]) ? 1 : 0; masks.set(ai, m); } return m; };
  const trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes);
  const st = lib.createSamplerState(anims);
  const mixObj = { count: 0, anims: [], idx: [], w: [], ph: [] };
  const saved = new Map(), ikSaved = new Map();
  const snaps = [];
  for (const q of seq) {
    if (q.restore) { if (ikSaved.size) lib.ikRestore(trs, ikSaved); if (saved.size) lib.restoreBoneOffsets(trs, saved); }
    let mix = null;
    if (q.mix) { mix = mixObj; mix.count = q.mix.idx.length; for (let j = 0; j < mix.count; j++) { mix.idx[j] = q.mix.idx[j]; mix.anims[j] = anims[q.mix.idx[j]]; mix.w[j] = q.mix.w[j]; mix.ph[j] = q.mix.ph[j]; } }
    lib.sampleAnimation(st, anims[q.drv], q.drv, q.t, q.dt, q.blend, q.loop, trs, mix, maskOf(q.drv));
    if (q.offs) { const f = new Float32Array(q.offs.flat()); lib.applyBoneOffsets(trs, f, 0, q.offs.length, saved, nodes.length); }
    if (q.ik && q.ik.length) { const f = new Float32Array(q.ik.flat()); lib.applyIK(trs, parentIdx, f, 0, q.ik.length, ikSaved, null); }
    const keep = new Float32Array(need.size * 10); let o = 0;
    for (const n of [...need].sort((a, b) => a - b)) { keep.set(trs.subarray(n * 10, n * 10 + 10), o); o += 10; }
    snaps.push(new Uint32Array(keep.buffer));
  }
  return snaps;
};
const A = run(1, false), B = run(1, true);
let first = -1, diffs = 0;
for (let s = 0; s < steps; s++) { const a = A[s], b = B[s]; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diffs++; if (first < 0) first = s; break; } }
console.log(`masked nodes only: ${steps} steps, ${sets[0].anims.length} clips, differing steps: ${diffs}${first >= 0 ? " (first " + first + ")" : ""}`);
process.exit(diffs ? 1 : 0);
