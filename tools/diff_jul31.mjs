// Compare the JS extractor with the July-31 desktop build (the best known-good output) item by item.
//   node tools/diff_jul31.mjs <rom> <jul31.json> [posable|objects|levels|attachments] [maxShown]
// jul31.json = the "geometry" JSON from the July-31 conker_viewer.html (never commit it).
import fs from "node:fs";
import { checkRom, extract } from "../web/js/extract/index.js";

const [romPath, refPath, only, maxShownArg] = process.argv.slice(2);
const maxShown = Number(maxShownArg) || 6;
const rom = await checkRom(new Uint8Array(fs.readFileSync(romPath)));
const hints = JSON.parse(fs.readFileSync(new URL("../web/data/hints.json", import.meta.url), "utf8"));
const js = extract(rom, () => {}, { hints });
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

const arr = (v, T) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  const b = Buffer.from(v, "base64");
  return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
function sig(data, g) {
  const col = arr(g.col, Uint8Array), n = col.length / 3;
  const avg = [0, 1, 2].map((k) => { let s = 0; for (let i = k; i < col.length; i += 3) s += col[i]; return n ? Math.round(s / n / 8) * 8 : 0; });
  const tid = g.ti >= 0 ? `${data.texmeta[g.ti]?.[0]}@${data.textures[g.ti].w}x${data.textures[g.ti].h}` : -1;
  const idx = arr(g.idx, Uint16Array);
  const fl = ["al", "ac", "bl", "dec", "mod", "ws", "wt", "sky", "vat", "tg", "rt"].filter((k) => g[k]).map((k) => k + (g[k] === 1 ? "" : "=" + g[k])).join(",");
  const anim = g.anim ? " anim" + g.anim.length : "";
  const ext = ["blink", "frown", "frownIris", "variant", "scroll", "tint"].filter((k) => g[k] != null).map((k) => k).join(",");
  return `tex${tid} t${idx.length / 3} c${avg.join("/")} [${fl}]${anim}${ext ? " +" + ext : ""}`;
}
function cmpItems(label, A, B, keyOf, groupsOf) {
  const mA = new Map(A.map((x) => [keyOf(x), x])), mB = new Map(B.map((x) => [keyOf(x), x]));
  const onlyA = [...mA.keys()].filter((k) => !mB.has(k)), onlyB = [...mB.keys()].filter((k) => !mA.has(k));
  let same = 0, diff = 0, shown = 0;
  for (const [k, b] of mB) {
    const a = mA.get(k);
    if (!a) continue;
    const sa = groupsOf(a).map((g) => sig(js, g)).sort(), sb = groupsOf(b).map((g) => sig(ref, g)).sort();
    if (sa.join("\n") === sb.join("\n")) { same++; continue; }
    diff++;
    if (shown++ < maxShown) {
      const ca = new Map(), cb = new Map();
      sa.forEach((s) => ca.set(s, (ca.get(s) || 0) + 1)); sb.forEach((s) => cb.set(s, (cb.get(s) || 0) + 1));
      console.log(`  ~ ${label} ${k}`);
      for (const [s, c] of ca) if ((cb.get(s) || 0) < c) console.log(`      js  : ${s}${c > 1 ? " x" + c : ""}`);
      for (const [s, c] of cb) if ((ca.get(s) || 0) < c) console.log(`      jul31: ${s}${c > 1 ? " x" + c : ""}`);
    }
  }
  console.log(`${label}: identical ${same}, different ${diff}, only-js ${onlyA.length} [${onlyA.slice(0, 20)}], only-jul31 ${onlyB.length} [${onlyB.slice(0, 30)}]`);
}
console.log(`textures js ${js.textures.length} / jul31 ${ref.textures.length}`);
if (!only || only === "posable") cmpItems("posable", js.posable, ref.posable, (m) => m.id, (m) => m.groups);
if (!only || only === "objects") cmpItems("objects", js.objects, ref.objects, (m) => m.name, (m) => m.groups);
if (!only || only === "levels") cmpItems("levels", js.levels, ref.levels, (m) => m.src.split(" · ")[0], (m) => [...m.groups, ...m.partpool.flatMap((p) => p.g)]);
if (!only || only === "attachments") cmpItems("attachments", js.attachments, ref.attachments, (m) => m.oid, (m) => m.parts.flatMap((p) => p.g));
