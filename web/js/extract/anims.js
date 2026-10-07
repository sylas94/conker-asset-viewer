// Animation clip packs (assets02). Port of conker_anim_extract.py + attach_anims.py.
import { u8, u16, u32 } from "./rom.js";
import { pySum, cmpTuple } from "./py.js";

const ASSETS_TABLE = 0xAB1950;
const MAXKF = 600, KFMAX = 18;

export function attachAnims(rom, data) {
  const d = rom.b;
  const s8 = (o) => { const v = u8(d, o); return v & 0x80 ? v - 0x100 : v; };
  const groupBase = (idx) => ASSETS_TABLE + u32(d, ASSETS_TABLE + idx * 8);

  function listPacks(groupIdx) {
    const gbase = groupBase(groupIdx), n = Math.floor(u32(d, gbase) / 8), out = new Map();
    for (let i = 0; i < n; i++) {
      const off = u32(d, gbase + i * 8), szc = u32(d, gbase + i * 8 + 4);
      if ((szc & 0xFFFFFFF) === 0 || (szc >>> 28) !== 0) continue;
      const base = gbase + off, d0 = u32(d, base);
      if (d0 < 8 || d0 % 8 || d0 > 0x8000) continue;
      if (base + d0 + 1 >= d.length) continue;
      out.set(i, [d[base + d0 + 1], (d0 / 8) >> 1, base]);
    }
    return out;
  }
  function animations(packBase) {
    const n = Math.floor(u32(d, packBase) / 8), dirs = [];
    for (let i = 0; i < n; i++) dirs.push([packBase + u32(d, packBase + i * 8), u32(d, packBase + i * 8 + 4)]);
    const anims = [];
    for (let i = 0; i < dirs.length - 1; i += 2) anims.push([dirs[i][0], dirs[i + 1][0], dirs[i + 1][1]]);
    return anims;
  }
  function parseHeader(off) {
    const ec = u8(d, off + 1), stride = u8(d, off + 5), w6 = u8(d, off + 6), w7 = u8(d, off + 7), flags = w7 & 0xF0;
    const slots = [[w6 >> 4, (s8(off) << 12) & 0xFFFF, 1], [w6 & 0xF, (s8(off + 2) << 12) & 0xFFFF, 1], [w7 & 0xF, (s8(off + 4) << 12) & 0xFFFF, 1]];
    let cw = off + 0xA;
    if (flags & 0x40) cw += 2;
    if (flags & 0x20) cw += 2;
    if (flags & 0x80) cw += Math.floor((ec - 1 + 15) / 16) * 2;
    for (let k = 0; k < 3 * (ec - 1); k++) {
      const c = u16(d, cw); cw += 2; slots.push([c & 0xF, c & 0xFFF0, 1]);
      if (c & 0x10) { const c2 = u16(d, cw); cw += 2; slots.push([c2 & 0xF, c2 & 0xFFF0, 0]); }
    }
    return { ec, stride, flags, interval: u8(d, off + 8) + 1, slots };
  }
  function decodeAnim(hdrOff, streamOff, streamLen) {
    const h = parseHeader(hdrOff), stride = h.stride;
    const nkf = stride === 0 ? 1 : Math.max(1, Math.floor(streamLen / stride));
    const frames = [];
    for (let k = 0; k < nkf; k++) {
      let p = streamOff + k * stride, acc = 0, nb = 0;
      const main = [];
      for (const [w, base, isMain] of h.slots) {
        let A = 0;
        if (w) {
          while (nb < w) { acc = ((acc << 8) | u8(d, p++)) & 0xFFFFFF; nb += 8; }
          nb -= w; A = (acc >> nb) & ((1 << w) - 1);
        }
        if (isMain) main.push((base + (A << 5)) & 0xFFFF);
      }
      const fr = [];
      for (let i = 0; i + 2 < main.length; i += 3) fr.push([main[i], main[i + 1], main[i + 2]]);
      frames.push(fr);
    }
    return { header: h, nkf, frames, nelem: frames.length ? frames[0].length : 0 };
  }

  const posable = data.posable;
  const packs = listPacks(2), byec = new Map();
  for (const [entry, [ec, na]] of packs) if (!byec.has(ec) || na > byec.get(ec)[1]) byec.set(ec, [entry, na]);
  const used = new Set();
  for (const m of posable) {
    const B = m.bones.length;
    const options = [B, B + 1].filter((ec) => byec.has(ec)).map((ec) => [ec, byec.get(ec)]);
    if (!options.length) continue;
    let best = options[0];
    for (const o of options) if (o[1][1] > best[1][1]) best = o;
    const [ecCh, [entry]] = best;
    m.pack = entry; m.aoff = ecCh - B; used.add(entry);
  }

  const animpacks = {};
  for (const entry of [...used].sort((a, b) => a - b)) {
    const anims = animations(packs.get(entry)[2]), cand = [];
    anims.forEach(([ho, so, sl], aid) => {
      const h = parseHeader(ho), stride = h.stride;
      let nkf = stride === 0 ? 1 : Math.max(1, Math.floor(sl / stride));
      if (nkf < 2 || nkf > MAXKF) return;
      const r = decodeAnim(ho, so, sl), nel = r.nelem;
      nkf = r.nkf;
      if (nel < 1) return;
      const F = r.frames, nz = [];
      for (let e = 0; e < nel; e++) {
        let any = false;
        for (let k = 0; k < nkf && !any; k++) for (let a = 0; a < 3; a++) if (F[k][e][a] & 0xFFFF) { any = true; break; }
        if (any) nz.push(e);
      }
      if (nz.length < 2) return;
      const jumps = [];
      for (const e of nz) for (let a = 0; a < 3; a++) for (let k = 1; k < nkf; k++)
        jumps.push(Math.abs(((F[k][e][a] - F[k - 1][e][a] + 0x8000) & 0xFFFF) - 0x8000) * 360.0 / 65536.0);
      const mean = pySum(jumps) / jumps.length;
      let mx = -Infinity;
      for (const j of jumps) if (j > mx) mx = j;
      if (mx > 180 || mean > 18) return;
      const step = nkf <= KFMAX ? 1 : Math.floor((nkf + KFMAX - 1) / KFMAX);
      const kept = [];
      for (let k = 0; k < nkf; k += step) kept.push(k);
      cand.push([nz.length, mean, r, kept, nz, Math.max(1, h.interval * step), aid]);
    });
    cand.sort((a, b) => cmpTuple([-a[0], a[1]], [-b[0], b[1]]));
    const clips = cand.map(([, , r, kept, nz, iv, aid]) => {
      const flat = new Int16Array(kept.length * nz.length * 3);
      let o = 0;
      for (const k of kept) for (const e of nz) for (const v of r.frames[k][e]) flat[o++] = v;   // u16 BAM -> s16
      return { n: kept.length, iv, idx: nz, d: flat, aid };
    });
    if (clips.length) animpacks[String(entry)] = clips;
  }
  data.animpacks = animpacks;
  posable.sort((a, b) => (a.id ?? 9999) - (b.id ?? 9999));
  return data;
}
