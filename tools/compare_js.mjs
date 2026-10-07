// Run the browser extractor under Node and diff it against the Python reference build.
//   node tools/compare_js.mjs <rom.z64> <reference textured.json>
import fs from "node:fs";
import zlib from "node:zlib";
import { checkRom, extract } from "../web/js/extract/index.js";

const [romPath, refPath] = process.argv.slice(2);
if (!romPath || !refPath) { console.error("usage: node tools/compare_js.mjs <rom> <textured.json>"); process.exit(2); }

const t0 = performance.now();
const rom = await checkRom(new Uint8Array(fs.readFileSync(romPath)));
const t1 = performance.now();
const js = extract(rom, (stage, f) => { if (f === 0) process.stdout.write(`  ${stage}…\n`); });
const t2 = performance.now();
console.log(`check ${(t1 - t0).toFixed(0)} ms, extract ${(t2 - t1).toFixed(0)} ms`);
console.log("tex outcomes:", js.txfail);

const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
if (process.env.SANITY) { js.levels[3].groups[2].p[7]++; js.posable[5].bones[1][3] += 0.001; js.animpacks[Object.keys(js.animpacks)[2]][1].d[9]++; js.textures[100].px[33]^=1; js.levels[10].props[4].sc[0] += 1; js.objects[7].groups[0].ac = 0; }

function pngRGBA(b64) {
  const p = Buffer.from(b64, "base64");
  let i = 8, w, h, ct, idat = [];
  while (i < p.length) {
    const n = p.readUInt32BE(i), t = p.toString("latin1", i + 4, i + 8), d = p.subarray(i + 8, i + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (t === "IDAT") idat.push(d);
    i += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = ct === 6 ? 4 : 3, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * bpp + 1)] !== 0) throw new Error("png filter");
    for (let x = 0; x < w; x++) {
      const s = y * (w * bpp + 1) + 1 + x * bpp, o = (y * w + x) * 4;
      out[o] = raw[s]; out[o + 1] = raw[s + 1]; out[o + 2] = raw[s + 2]; out[o + 3] = bpp === 4 ? raw[s + 3] : 255;
    }
  }
  return { w, h, px: out };
}

let diffs = 0;
const MAXSHOW = 40;
function report(path, a, b) {
  diffs++;
  if (diffs <= MAXSHOW) console.log(`DIFF ${path}: js=${JSON.stringify(a)?.slice(0, 160)} ref=${JSON.stringify(b)?.slice(0, 160)}`);
}
function cmp(a, b, path) {
  if (ArrayBuffer.isView(a) && typeof b === "string") {
    const buf = Buffer.from(b, "base64");
    const T = a.constructor, arr = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (arr.length !== a.length) return report(path + ".length", a.length, arr.length);
    for (let i = 0; i < a.length; i++) if (a[i] !== arr[i]) return report(`${path}[${i}]`, a[i], arr[i]);
    return;
  }
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return report(path, a, b);
    if (a.length !== b.length) return report(path + ".length", a.length, b.length);
    for (let i = 0; i < b.length; i++) cmp(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (b && typeof b === "object") {
    if (!a || typeof a !== "object") return report(path, a, b);
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) report(path + " keys", ka, kb);
    for (const k of kb) if (k in a) cmp(a[k], b[k], `${path}.${k}`);
    return;
  }
  if (typeof b === "number" && typeof a === "number") {
    if (a !== b) report(path, a, b);
    return;
  }
  if (a !== b) report(path, a, b);
}

// textures: compare decoded pixels
if (js.textures.length !== ref.textures.length) report("textures.length", js.textures.length, ref.textures.length);
for (let i = 0; i < Math.min(js.textures.length, ref.textures.length); i++) {
  const a = js.textures[i], b = ref.textures[i], p = pngRGBA(b.d);
  if (a.w !== b.w || a.h !== b.h || a.a !== b.a || a.pw !== p.w || a.ph !== p.h) { report(`textures[${i}] dims`, [a.w, a.h, a.a, a.pw, a.ph], [b.w, b.h, b.a, p.w, p.h]); continue; }
  for (let k = 0; k < p.px.length; k++) if (a.px[k] !== p.px[k]) { report(`textures[${i}].px[${k}]`, a.px[k], p.px[k]); break; }
}
for (const key of ["texmeta", "characters", "objects", "levels", "posable", "attachments", "animpacks"]) cmp(js[key], ref[key], key);
console.log(diffs ? `${diffs} differences` : "IDENTICAL to the Python reference");
process.exit(diffs ? 1 : 0);
