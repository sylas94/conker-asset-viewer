// Animation clip packs (assets02). Port of conker_anim_extract.py + attach_anims.py.
import { u8, u16, u32 } from "./rom.js";
import { pySum, cmpTuple } from "./py.js";

const ASSETS_TABLE = 0xAB1950;
const MAXKF = 600, KFMAX = 18;

export function attachAnims(rom, data, hints = null) {
  const tiHints = (hints && hints.animTi) || {};
  const d = rom.b;
  const s8 = (o) => { const v = u8(d, o); return v & 0x80 ? v - 0x100 : v; };
  const s16 = (o) => { const v = u16(d, o); return v & 0x8000 ? v - 0x10000 : v; };
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
    // flags&0x80: a bitmask (MSB first, elements 1..ec-1) of elements that also carry a translation; every keyframe
    // then starts with a raw s16 x,y,z triple per masked element before the bit-packed channels (func_150A8A18)
    const masked = [];
    if (flags & 0x80) {
      for (let e = 1; e < ec && e <= 64; e++) if ((u8(d, cw + ((e - 1) >> 3)) << ((e - 1) & 7)) & 0x80) masked.push(e);
      cw += Math.floor((ec - 1 + 15) / 16) * 2;
    }
    for (let k = 0; k < 3 * (ec - 1); k++) {
      const c = u16(d, cw); cw += 2; slots.push([c & 0xF, c & 0xFFF0, 1]);
      if (c & 0x10) { const c2 = u16(d, cw); cw += 2; slots.push([c2 & 0xF, c2 & 0xFFF0, 0]); }
    }
    return { ec, stride, flags, interval: u8(d, off + 8) + 1, slots, masked };
  }
  function decodeAnim(hdrOff, streamOff, streamLen) {
    const h = parseHeader(hdrOff), stride = h.stride;
    const nkf = stride === 0 ? 1 : Math.max(1, Math.floor(streamLen / stride));
    const frames = [], trans = [];
    for (let k = 0; k < nkf; k++) {
      let p = streamOff + k * stride, acc = 0, nb = 0;
      const tr = [];
      for (let i = 0; i < h.masked.length; i++, p += 6) tr.push([s16(p), s16(p + 2), s16(p + 4)]);
      trans.push(tr);
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
    return { header: h, nkf, frames, trans, nelem: frames.length ? frames[0].length : 0 };
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

  // decode one clip pack -> viewer clips (all real clips, most full-body first, then smoothest)
  function packClips(packBase, key, prop = false) {
    const anims = animations(packBase), cand = [];
    anims.forEach(([ho, so, sl], aid) => {
      const h = parseHeader(ho), stride = h.stride;
      let nkf = stride === 0 ? 1 : Math.max(1, Math.floor(sl / stride));
      if (nkf < (prop ? 1 : 2) || nkf > MAXKF) return;   // props keep single-keyframe poses too
      const r = decodeAnim(ho, so, sl), nel = r.nelem;
      nkf = r.nkf;
      if (nel < 1) return;
      const F = r.frames, nz = [];
      for (let e = 0; e < nel; e++) {
        let any = false;
        for (let k = 0; k < nkf && !any; k++) for (let a = 0; a < 3; a++) if (F[k][e][a] & 0xFFFF) { any = true; break; }
        if (any) nz.push(e);
      }
      if (prop) {
        // held props: every element, clips in ROM order (first 8), skipping all-zero ones
        if (!nz.length) return;
        nz.length = 0;
        for (let e = 0; e < nel; e++) nz.push(e);
      } else if (nz.length < 2) return;
      // mean frame-to-frame jump (degrees): only used to order clips (smoothest first). The old garbage filter
      // (mean > 18) existed for the mis-decoded translation clips; with those fixed every clip is real.
      const jumps = [];
      for (const e of nz) for (let a = 0; a < 3; a++) for (let k = 1; k < nkf; k++)
        jumps.push(Math.abs(((F[k][e][a] - F[k - 1][e][a] + 0x8000) & 0xFFFF) - 0x8000) * 360.0 / 65536.0);
      const mean = jumps.length ? pySum(jumps) / jumps.length : 0;
      const step = nkf <= KFMAX ? 1 : Math.floor((nkf + KFMAX - 1) / KFMAX);
      const kept = [];
      for (let k = 0; k < nkf; k += step) kept.push(k);
      cand.push([nz.length, mean, r, kept, nz, Math.max(1, h.interval * step), aid]);
    });
    if (prop) cand.splice(8);
    else cand.sort((a, b) => cmpTuple([-a[0], a[1]], [-b[0], b[1]]));
    const clips = cand.map(([, , r, kept, nz, iv, aid]) => {
      const flat = new Int16Array(kept.length * nz.length * 3);
      let o = 0;
      for (const k of kept) for (const e of nz) for (const v of r.frames[k][e]) flat[o++] = v;   // u16 BAM -> s16
      const clip = { n: kept.length, iv, idx: nz, d: flat, aid };
      // per-element translation tracks (all-zero ones dropped): td[(k * ti_.length + i) * 3 + axis]
      let live = r.header.masked.map((e, i) => i).filter((i) => kept.some((k) => r.trans[k][i].some((v) => v !== 0)));
      const allow = tiHints[`${key}:${aid}`];   // the July-31 build left some tracks out; keep its choice
      if (allow) live = live.filter((i) => allow.includes(r.header.masked[i]));
      if (live.length) {
        clip.ti_ = live.map((i) => r.header.masked[i]);
        clip.td = new Int16Array(kept.length * live.length * 3);
        let t = 0;
        for (const k of kept) for (const i of live) { const v = r.trans[k][i]; clip.td[t++] = v[0]; clip.td[t++] = v[1]; clip.td[t++] = v[2]; }
      }
      return clip;
    });
    return clips;
  }
  const animpacks = {};
  for (const entry of [...used].sort((a, b) => a - b)) {
    const clips = packClips(packs.get(entry)[2], String(entry));
    if (clips.length) animpacks[String(entry)] = clips;
  }
  // articulated held props: clip packs in assets0A, keyed "p<packId>"; clip element = bone rotIndex + aoff
  const propPacks = listPacks(0x0A);
  for (const p of data.propanim || []) {
    const pk = propPacks.get(p.packId), key = "p" + p.packId;
    p.pack = key;
    if (pk && !(key in animpacks)) animpacks[key] = packClips(pk[2], key, true);
    p.aoff = animpacks[key] && animpacks[key].length ? Math.max(0, Math.min(1, pk[0] - p.bones.length)) : 0;
    delete p.packId;
  }
  data.animpacks = animpacks;
  posable.sort((a, b) => (a.id ?? 9999) - (b.id ?? 9999));
  return data;
}
