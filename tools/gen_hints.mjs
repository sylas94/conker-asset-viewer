// Build web/data/hints.json: the decisions the July-31 desktop build made that can't be read off the display
// lists (which texture a character's runtime-bound RSP segment shows, its blink/frown frames, which runtime
// surfaces it left untextured or dropped). Hints hold texture IDs and flags only — every pixel and vertex is
// still decoded from the visitor's ROM.
//   node tools/gen_hints.mjs <rom> <jul31.json>      (jul31.json = geometry JSON of the July-31 build; never commit it)
import fs from "node:fs";
import { checkRom, extract } from "../web/js/extract/index.js";

const [romPath, refPath] = process.argv.slice(2);
const rom = await checkRom(new Uint8Array(fs.readFileSync(romPath)));
const js = extract(rom, () => {}, { debug: true });
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

const arr = (v, T) => {
  if (typeof v !== "string") return v;
  const b = Buffer.from(v, "base64");
  return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
// [texid, W, H, fmt, siz, flag] for a July-31 texture index (W/H as decoded there)
const spec = (ti) => { const m = ref.texmeta[ti], t = ref.textures[ti]; return [m[0], t.w, t.h, m[1], m[2], m[3]]; };
const vkeys = (g) => {
  const slot = arr(g.slot, Uint8Array), pos = arr(g.pos, Int16Array), out = new Set();
  for (let i = 0; i < slot.length; i++) out.add(`${slot[i]},${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`);
  return out;
};
const FL = ["dec", "ac", "bl", "ws", "wt"];
const flags = (x, skip = []) => FL.filter((f) => !skip.includes(f)).map((f) => x[f] || 0).join();

const hints = { posable: {} };
const stat = { textured: 0, untextured: 0, dropped: 0, unmatched: 0 };
const conflicts = [];
const refById = new Map(ref.posable.map((m) => [m.id, m]));
for (const m of js.posable) {
  const r = refById.get(m.id);
  if (!r) continue;
  const rk = r.groups.map((g) => [g, vkeys(g)]);
  for (const g of m.groups) {
    if (!g._seg) continue;
    const k = vkeys(g);
    // eye whites and irises share vertices, so prefer a group whose render flags agree; the July-31 build
    // sometimes overrode a flag (eyes forced opaque), so fall back to ignoring blend, then all flags
    let best = null, bestN = 0;
    for (const skip of [[], ["bl"], FL]) {
      for (const [rg, rks] of rk) {
        if (flags(rg, skip) !== flags(g, skip)) continue;
        let n = 0; for (const x of k) if (rks.has(x)) n++;
        if (n > bestN) { bestN = n; best = rg; }
      }
      if (best && bestN >= 0.8 * k.size) break;
    }
    let h;
    if (!g._sampled && best && bestN >= 0.8 * k.size) continue;   // shade-only: untextured anyway, only "dropped" matters
    if (best && bestN >= 0.8 * k.size) {
      if (best.ti < 0) { h = { tex: null }; stat.untextured++; }
      else {
        if (!g._sampled) { stat.unmatched++; continue; }
        h = { tex: spec(best.ti) }; stat.textured++;
        if (best.blink) h.blink = best.blink.map(spec);
        if (best.frown != null) h.frown = spec(best.frown);
        if (best.frownIris != null) h.frownIris = spec(best.frownIris);
      }
      const fl = {};
      for (const f of FL) if ((best[f] || 0) !== (g[f] || 0)) fl[f] = best[f] || 0;
      if (Object.keys(fl).length) h.fl = { [flags(g)]: fl };
    } else if (bestN <= 0.2 * k.size) { h = { drop: 1 }; stat.dropped++; }
    else { stat.unmatched++; if (process.env.VERBOSE) console.log(`  unmatched model ${m.id} ${g._hk} verts ${k.size} overlap ${bestN}`); continue; }
    const mh = (hints.posable[m.id] ||= {});
    const prev = mh[g._hk];
    if (prev) {
      const strip = (x) => JSON.stringify({ ...x, fl: undefined });
      if (strip(prev) !== strip(h)) { conflicts.push(`model ${m.id} ${g._hk}: ${strip(prev)} vs ${strip(h)}`); continue; }
      if (h.fl) prev.fl = { ...(prev.fl || {}), ...h.fl };
    } else mh[g._hk] = h;
  }
}
// per-segment fallback ("seg:*") when every tile size seen on that segment got the same treatment
for (const mh of Object.values(hints.posable)) {
  const bySeg = {};
  for (const [hk, h] of Object.entries(mh)) if (!hk.endsWith(":u")) (bySeg[hk.split(":")[0]] ||= []).push(h);
  for (const [seg, hs] of Object.entries(bySeg)) {
    const t = hs.map((h) => JSON.stringify({ ...h, fl: undefined }));
    if (t.every((x) => x === t[0])) mh[seg + ":*"] = { ...hs[0], fl: undefined };
  }
}
fs.writeFileSync(new URL("../web/data/hints.json", import.meta.url), JSON.stringify(hints));
console.log(`runtime-segment groups: textured ${stat.textured}, untextured ${stat.untextured}, dropped ${stat.dropped}, unmatched ${stat.unmatched}`);
console.log(`models with hints: ${Object.keys(hints.posable).length}`);
if (conflicts.length) console.log("CONFLICTS:\n  " + conflicts.join("\n  "));
