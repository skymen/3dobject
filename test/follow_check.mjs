// IK follow fields (3DObject >= 3.0.64): a chain set at one pose keeps working when the animation moves on.
//   node test/follow_check.mjs <gltfWorker.js> [glb]
// Checks, on random clips / times / chains: (1) follow 1,1 with the anchor at the animated end puts the end where a
// plain target at (animated end + offset) does, at the anchor's pose and at a later one; (2) follow 0,1 keeps the
// horizontal target and adds the animated end's vertical move; (3) a pole anchor gives the same bend as the pole
// moved by the upper joint's move.
import fs from "node:fs";
const [wPath, glbPath = "/Users/ossama/Documents/Under The Red Sky/files/glb/utrsChar.glb"] = process.argv.slice(2);
const W = fs.readFileSync(wPath, "utf8");
const lib = new Function(W.slice(W.indexOf("const TRS_STRIDE = 10"), W.indexOf("let graph = null")) + `
return { IK_STRIDE, prepareAnimation, initTRS, createSamplerState, sampleAnimation, applyIK, ikRestore, ikWorld, IK_TMP }`)();
const buf = fs.readFileSync(glbPath);
const jl = buf.readUInt32LE(12), g = JSON.parse(buf.subarray(20, 20 + jl).toString()), bin = 20 + jl + 8;
const acc = (i) => { const A = g.accessors[i], v = g.bufferViews[A.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type] * A.count, off = bin + (v.byteOffset || 0) + (A.byteOffset || 0);
  return { data: new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4)), min: A.min, max: A.max }; };
const nodes = g.nodes.map((n) => ({ ...n })), idxOf = new Map(nodes.map((n, i) => [n, i]));
const anims = g.animations.map((an) => lib.prepareAnimation({ name: an.name, channels: an.channels.map((c) => { const s = an.samplers[c.sampler]; return { target: { node: nodes[c.target.node], path: c.target.path }, sampler: { input: acc(s.input), output: { data: acc(s.output).data } } }; }) }, idxOf));
const parentIdx = new Int32Array(g.nodes.length).fill(-1);
g.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentIdx[c] = i)));
const ni = (n) => g.nodes.findIndex((x) => x.name === n);
let seed = 99;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const S = lib.IK_STRIDE, UP = [0, 1, 0]; // (model space up for the test: any unit vector works)
const pose = (ai, t) => {
  const trs = lib.initTRS(new Float32Array(nodes.length * 10), nodes), st = lib.createSamplerState(anims);
  lib.sampleAnimation(st, anims[ai], ai, t, 0, 0, true, trs, null);
  return trs;
};
const P = (trs, i) => { const T = lib.IK_TMP, p = [0, 0, 0]; lib.ikWorld(trs, parentIdx, i, p, [0, 0, 0, 1], [1, 1, 1]); return p; };
const chain = (side, f) => { const c = new Float32Array(S); c[0] = ni("legA1." + side); c[1] = ni("legB1." + side); c[2] = ni("footA." + side); c[6] = c[7] = c[8] = NaN; c[9] = 1; c[34] = c[35] = c[36] = NaN; f(c); return c; };
const solve = (trs, c) => { const t = trs.slice(); lib.applyIK(t, parentIdx, c, 0, 1, null, null); return t; };
let worst = [0, 0, 0], n = 0;
for (let k = 0; k < 2000; k++) {
  const ai = Math.floor(rnd() * anims.length), t0 = rnd() * 2, t1 = t0 + rnd() * 0.1, side = rnd() < 0.5 ? "L" : "R", ie = ni("footA." + side), iu = ni("legA1." + side);
  const off = [(rnd() - 0.5) * 6, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6];
  const A0 = pose(ai, t0), A1 = pose(ai, t1);
  const C0 = P(A0, ie), C1 = P(A1, ie), U0 = P(A0, iu), U1 = P(A1, iu);
  const pole = [U0[0] + (rnd() - 0.5) * 20, U0[1] + (rnd() - 0.5) * 20, U0[2] + 15];
  // (1) follow 1,1 at the later pose == a plain target at C1 + off
  const fol = chain(side, (c) => { c[3] = C0[0] + off[0]; c[4] = C0[1] + off[1]; c[5] = C0[2] + off[2]; c[26] = C0[0]; c[27] = C0[1]; c[28] = C0[2]; c[29] = 1; c[30] = 1; c[31] = UP[0]; c[32] = UP[1]; c[33] = UP[2]; });
  const plain = chain(side, (c) => { c[3] = C1[0] + off[0]; c[4] = C1[1] + off[1]; c[5] = C1[2] + off[2]; });
  const e1 = P(solve(A1, fol), ie), e2 = P(solve(A1, plain), ie);
  worst[0] = Math.max(worst[0], Math.hypot(e1[0] - e2[0], e1[1] - e2[1], e1[2] - e2[2]));
  // (2) follow 0,1 (up = model y here): the target's x, z stay, y moves with the animated end
  const hold = chain(side, (c) => { c[3] = C0[0] + off[0]; c[4] = C0[1] + off[1]; c[5] = C0[2] + off[2]; c[26] = C0[0]; c[27] = C0[1]; c[28] = C0[2]; c[29] = 0; c[30] = 1; c[31] = UP[0]; c[32] = UP[1]; c[33] = UP[2]; });
  const plain2 = chain(side, (c) => { c[3] = C0[0] + off[0]; c[4] = C0[1] + off[1] + (C1[1] - C0[1]); c[5] = C0[2] + off[2]; });
  const h1 = P(solve(A1, hold), ie), h2 = P(solve(A1, plain2), ie);
  worst[1] = Math.max(worst[1], Math.hypot(h1[0] - h2[0], h1[1] - h2[1], h1[2] - h2[2]));
  // (3) pole anchor: same bend as the pole moved by the upper joint's move
  const pa = chain(side, (c) => { c[3] = C1[0] + off[0]; c[4] = C1[1] + off[1]; c[5] = C1[2] + off[2]; c[6] = pole[0]; c[7] = pole[1]; c[8] = pole[2]; c[34] = U0[0]; c[35] = U0[1]; c[36] = U0[2]; });
  const pm = chain(side, (c) => { c[3] = C1[0] + off[0]; c[4] = C1[1] + off[1]; c[5] = C1[2] + off[2]; c[6] = pole[0] + U1[0] - U0[0]; c[7] = pole[1] + U1[1] - U0[1]; c[8] = pole[2] + U1[2] - U0[2]; });
  const k1 = P(solve(A1, pa), ni("legB1." + side)), k2 = P(solve(A1, pm), ni("legB1." + side));
  worst[2] = Math.max(worst[2], Math.hypot(k1[0] - k2[0], k1[1] - k2[1], k1[2] - k2[2]));
  n++;
}
console.log(`${n} cases, worst model-space differences: follow 1,1 ${worst[0].toExponential(2)}, follow 0,1 ${worst[1].toExponential(2)}, pole anchor ${worst[2].toExponential(2)}`);
process.exit(worst.every((x) => x < 1e-3) ? 0 : 1);
