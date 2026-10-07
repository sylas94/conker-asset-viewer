// Geometry / texture / level extractor. Port of build_textured.py — keep the two in lockstep:
// texture indices are assigned in call order, so every tex_index() call happens in the same sequence.
import { u8, u32, s16, f32, DATA_VRAM } from "./rom.js";
import { runzip } from "./inflate.js";
import { decodeTexture } from "./texdecode.js";
import { pyRound, pyRoundN, pySum, cmpTuple, truthy } from "./py.js";

const TEXMAX = 256;
const TEX_OVERRIDE = new Map([[0xc3a, [64, 16, 0, 3, 0]], [0x54f, [64, 32, 3, 2, 0]]]);
const RT_WATER = [0x1c14, 0x1c1b, 0x1c1c, 0x1c1d, 0x1c1e, 0x1c1f, 0x1c20, 0x1c21, 0x1c22, 0x1c15, 0x1c16, 0x1c17, 0x1c18, 0x1c19, 0x1c1a];
const WATER_CHUNKS = new Set([6, 7, 18, 23, 41, 59, 65]);
const BACKDROP_TEXIDS = new Set([0x785]);
const PANEL_FRAMES_IDS = [0x102, 0x103, 0x104];
const LV1A_PANEL_IDS = [0x60B, 0x60C, 0x60D, 0x16C, 0xC7D];
const A01KNOWN = new Set([0x00, 0x01, 0x05, 0x06, 0xda, 0xdb, 0xdc, 0xd7, 0xd9, 0xde, 0xdf, 0xe6, 0xe7, 0xe8, 0xe2, 0xe3, 0xef, 0xf0, 0xf2, 0xf3, 0xf4, 0xf5, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]);

const clampI16 = (x) => Math.max(-32768, Math.min(32767, x));
const clampUV = (x) => Math.max(-32000, Math.min(32000, x));
const sortedNums = (it) => Array.from(new Set(it)).sort((a, b) => a - b);

export function parseDir(b) {
  if (!b || b.length < 8) return null;
  const fo = u32(b, 0);
  if (fo === 0 || fo % 8 || fo > b.length || fo > 0x8000) return null;
  const out = [];
  for (let i = 0; i < fo / 8; i++) {
    const w = u32(b, i * 8 + 4);
    out.push([u32(b, i * 8), w & 0xFFFFFFF, (w >>> 28) & 0xF]);
  }
  return out;
}

export function triOf(op, w0, w1) {
  if (op === 0x05) return [[((w0 >>> 16) & 0xFF) >> 1, ((w0 >>> 8) & 0xFF) >> 1, (w0 & 0xFF) >> 1]];
  if (op === 0x06) return [[(w0 >>> 17) & 0x1F, (w0 >>> 9) & 0x1F, (w0 >>> 1) & 0x1F], [(w1 >>> 17) & 0x1F, (w1 >>> 9) & 0x1F, (w1 >>> 1) & 0x1F]];
  return [[(w1 >>> 25) & 0x1F, (w1 >>> 20) & 0x1F, (w1 >>> 15) & 0x1F], [(w1 >>> 10) & 0x1F, (w1 >>> 5) & 0x1F, w1 & 0x1F],
    [(w0 >>> 10) & 0x1F, (w0 >>> 5) & 0x1F, w0 & 0x1F], [(w0 >>> 23) & 0x1F, (w0 >>> 18) & 0x1F, ((w1 >>> 30) & 0x3) | ((w0 >>> 13) & 0x1C)]];
}

// Does a G_SETCOMBINE sample a texture? (TEXEL0/TEXEL1 in any RGB or alpha input of either cycle; RGB C also
// takes TEXEL0/1_ALPHA.) Conker draws skin, muzzles, gloves etc. with shade-only combiners while the last
// texture is still loaded — those triangles must render in vertex colour, not with that stale texture.
export function combUsesTex(w0, w1) {
  const t = (v) => v === 1 || v === 2;
  const rgb = [(w0 >>> 20) & 0xF, (w1 >>> 28) & 0xF, (w0 >>> 15) & 0x1F, (w1 >>> 15) & 7,
    (w0 >>> 5) & 0xF, (w1 >>> 24) & 0xF, w0 & 0x1F, (w1 >>> 6) & 7];
  const alpha = [(w0 >>> 12) & 7, (w1 >>> 12) & 7, (w0 >>> 9) & 7, (w1 >>> 9) & 7,
    (w1 >>> 21) & 7, (w1 >>> 3) & 7, (w1 >>> 18) & 7, w1 & 7];
  return rgb.some(t) || rgb[2] === 8 || rgb[2] === 9 || rgb[6] === 8 || rgb[6] === 9 || alpha.some(t);
}

// SETOTHERMODE_L mask (length 1..32, shift such that length+shift <= 32)
function omodeMask(length, sft) {
  return ((2 ** length - 1) * 2 ** sft) >>> 0;
}

// assets03/09 object files: the newer header (flag 0x80000000 in the word at 0x14) is 0x18 bytes and the vertex
// array starts right after it; the older one is 0x28. Reading the newer kind from 0x28 shifts every vertex by one
// slot, so each triangle joins the wrong corners (the "crumpled" props: toilet roll, boxes, the yo-yo, ...).
function objVtxBase(d) { return d.length >= 0x18 && (u32(d, 0x14) & 0x80000000) ? 0x18 : 0x28; }
// Conker's microcode keeps vertex normals out of the colour bytes: G_MOVEMEM index 0x0E points at a stream of
// s8 (nx, ny) pairs, one per vertex-buffer slot, and nz is the low byte of the vertex's flag word (Vtx + 7).
// Returns [nx, ny, nz] or null; unlit models carry an all-zero stream.
const s8 = (d, o) => (d[o] << 24) >> 24;
function cbfdNormal(data, nb, slotIdx, vo) {
  if (nb < 0 || nb + 2 * slotIdx + 2 > data.length) return null;
  return [s8(data, nb + 2 * slotIdx), s8(data, nb + 2 * slotIdx + 1), s8(data, vo + 7)];
}
const unitNormal = (n) => { if (!n) return false; const l = Math.hypot(n[0], n[1], n[2]); return l > 100 && l < 140; };
// per-vertex normals for a group (Int8 xyz), only when every vertex has a real one
function encodeNormals(vs, at) {
  const N = new Int8Array(vs.length * 3);
  for (let k = 0; k < vs.length; k++) {
    const n = vs[k][at];
    if (!unitNormal(n)) return null;
    N[k * 3] = n[0]; N[k * 3 + 1] = n[1]; N[k * 3 + 2] = n[2];
  }
  return N;
}
function isPOT(n) { return n > 0 && (n & (n - 1)) === 0; }
// bytes a W x H texture occupies in the pool (indices + palette for CI)
function texBytes(W, H, fmt, siz, flag) {
  if (flag & 0x400000) return W * H + 512;
  if (flag & 0x800000) return W * H / 2 + 32;
  return W * H * [0.5, 1, 2, 4][siz ?? 2];
}
function pot(n) { let p = 1; while (p < n) p <<= 1; return p; }
function resizeNN(px, w, h, pw, ph) {
  const out = new Uint8Array(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const sy = Math.floor(y * h / ph);
    for (let x = 0; x < pw; x++) {
      const sx = Math.floor(x * w / pw), si = (sy * w + sx) * 4, di = (y * pw + x) * 4;
      out[di] = px[si]; out[di + 1] = px[si + 1]; out[di + 2] = px[si + 2]; out[di + 3] = px[si + 3];
    }
  }
  return out;
}
function hasAlpha(px) {
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

const mtxDefault = [0, 0, 0];

export function buildAll(rom, progress = () => {}, { hints = null, debug = false } = {}) {
  const posHints = (hints && hints.posable) || {};
  // ---------- global texture registry ----------
  const TEX = [];          // {px (POT RGBA), pw, ph, w, h, a}
  const TEXKEY = new Map(); // "texid,W,H" -> index (-1 failed)
  const TEXKEYREV = [];     // index -> [texid,W,H]
  const TEXMETA = [];       // [texid,W,H,fmt,siz,flag,assetlen,fname]
  const TXFAIL = { notexid: 0, toobig: 0, noasset: 0, decodefail: 0, ok: 0 };

  function fixCiDims(data, W, H, flag) {
    if (!truthy(data) || !W || !H) return [W, H];
    const n = data.length;
    let bpp, tlut;
    if (flag & 0x400000) { bpp = 1.0; tlut = 512; }
    else if (flag & 0x800000) { bpp = 0.5; tlut = 32; }
    else { const base = W * H; tlut = 0; bpp = n >= base * 4 ? 4.0 : (n >= base * 2 ? 2.0 : 1.0); }
    const cap = n - tlut;
    if (cap <= 0) return [W, H];
    const bf = (w, h) => Math.trunc(w * h * bpp);
    let k = 1;
    while (bf(W * (k + 1), H * (k + 1)) <= cap && W * (k + 1) <= TEXMAX && H * (k + 1) <= TEXMAX) k++;
    return k > 1 ? [W * k, H * k] : [W, H];
  }

  function texIndex(texid, W, H, fmt = null, siz = null, flag = 0) {
    if (!texid || !W || !H || W < 1 || H < 1) { TXFAIL.notexid++; return -1; }
    const data = rom.asset(texid);
    let idx = -1;
    if (TEX_OVERRIDE.has(texid)) [W, H, fmt, siz, flag] = TEX_OVERRIDE.get(texid);
    else [W, H] = fixCiDims(data, W, H, flag);
    if (W > TEXMAX || H > TEXMAX) { TXFAIL.toobig++; return -1; }
    const key = texid + "," + W + "," + H;
    if (TEXKEY.has(key)) return TEXKEY.get(key);
    if (!truthy(data)) TXFAIL.noasset++;
    else {
      const [px0, fname] = decodeTexture(data, W, H, fmt, siz, flag);
      if (px0 && px0.length && px0.length === W * H * 4) {
        const pw = pot(W), ph = pot(H);
        const px = pw !== W || ph !== H ? resizeNN(px0, W, H, pw, ph) : px0;
        idx = TEX.length;
        TEX.push({ px, pw, ph, w: W, h: H, a: hasAlpha(px) });
        TEXMETA.push([texid, W, H, fmt, siz, flag, data.length, fname]);
        TEXKEYREV[idx] = [texid, W, H];
        TXFAIL.ok++;
      } else TXFAIL.decodefail++;
    }
    TEXKEY.set(key, idx);
    return idx;
  }

  // ---------- skeleton (bind pose = translation accumulation) ----------
  function resolveBones(bones) {
    const bc = bones.length, slot2idx = new Map(), wt = new Array(bc).fill(null);
    bones.forEach((b, i) => slot2idx.set(b[1], i));
    const resolve = (i, depth = 0) => {
      if (wt[i] !== null) return wt[i];
      if (depth > bc) return [bones[i][2], bones[i][3], bones[i][4]];
      const [par, , rx, ry, rz] = bones[i], pj = slot2idx.get(par);
      if (par === 0xFF || pj === undefined || pj === i) wt[i] = [rx, ry, rz];
      else { const pw = resolve(pj, depth + 1); wt[i] = [pw[0] + rx, pw[1] + ry, pw[2] + rz]; }
      return wt[i];
    };
    for (let i = 0; i < bc; i++) resolve(i);
    const m = new Map();
    for (let i = 0; i < bc; i++) m.set(bones[i][1], wt[i]);
    return m;
  }
  function readSkeleton(blob) {
    if (blob.length < 0x14) return null;
    const so = u32(blob, 8), bc = u32(blob, 0xC) >>> 4;
    if (so === 0 || bc === 0 || bc > 200 || so + bc * 16 > blob.length) return null;
    const bones = [];
    for (let i = 0; i < bc; i++) { const o = so + i * 16; bones.push([u8(blob, o), u8(blob, o + 1), f32(blob, o + 4), f32(blob, o + 8), f32(blob, o + 12)]); }
    return resolveBones(bones);
  }

  // ---------- core DL walk -> per-texindex geometry ----------
  function walkDlGroups(data, dl, vtxBase, vend, groups, { skel = null, sky = 0, extkey = 0, state = null, runEnd = null, rtInherit = false, tdims = null, vmin = 0x28 } = {}) {
    const slot = new Map();
    let i = dl, mtx = mtxDefault;
    if (state === null) state = {};
    let curtex = state.tex ?? null, curW = state.W ?? 0, curH = state.H ?? 0;
    let curfmt = state.fmt ?? null, cursiz = state.siz ?? null, curflag = state.flag ?? 0;
    let expsize = state.exp ?? false, curprim = state.prim ?? [255, 255, 255];
    let curomode = state.omode ?? 0, curcomb0 = state.comb0 ?? 0, curseg = state.seg ?? 0;
    let curcmS = state.cmS ?? 0, curcmT = state.cmT ?? 0, curuls = state.uls ?? 0, curult = state.ult ?? 0;
    let omodeSet = state.omset ?? false, lastpool = state.lastpool ?? null;
    let curcomb1 = state.comb1 ?? 0, combSet = state.combset ?? false, curgeo = state.geo ?? 0;
    let t0W = state.t0W ?? 0, t0H = state.t0H ?? 0;   // last render-tile (0) size, for tile setups that precede the SETTIMG
    let maskS = state.maskS ?? 0, maskT = state.maskT ?? 0, nb = state.nb ?? -1;
    let t0uls = state.t0uls ?? 0, t0ult = state.t0ult ?? 0;   // last render-tile (0) origin
    const ekStr = Array.isArray(extkey) ? extkey.join(":") : String(extkey);

    function gettarget() {
      const rt = curseg >= 2 ? curseg : 0;
      const sampled = !combSet || combUsesTex(curcomb0, curcomb1);
      let ti;
      if (!sampled) ti = -1;
      else if (rt) ti = rtInherit && lastpool ? texIndex(...lastpool) : -1;
      else {
        // size = first SETTILESIZE after the SETTIMG; if none followed it, the render tile's size set before it
        let W = expsize && t0W ? t0W : curW, H = expsize && t0H ? t0H : curH;
        const td = tdims && curtex ? tdims.get(curtex) : null;
        if (td) [W, H] = td;
        // a clamped tile is often a couple of texels short of the texture (62 of 64); decoding at the short width
        // shears every row. Take the wrap-mask / next power-of-two size when the asset is exactly that big.
        if (curtex && (!isPOT(W) || !isPOT(H))) {
          const W2 = isPOT(W) ? W : maskS && 1 << maskS >= W ? 1 << maskS : pot(W), H2 = isPOT(H) ? H : maskT && 1 << maskT >= H ? 1 << maskT : pot(H);
          if ((W2 !== W || H2 !== H) && texBytes(W2, H2, curfmt, cursiz, curflag) === rom.asset(curtex)?.length
              && texBytes(W, H, curfmt, cursiz, curflag) !== rom.asset(curtex)?.length) { W = W2; H = H2; }
        }
        ti = curtex ? texIndex(curtex, W, H, curfmt, cursiz, curflag) : -1;
        if (ti >= 0) lastpool = [curtex, W, H, curfmt, cursiz, curflag];
      }
      const zmode = (curomode >>> 10) & 3;
      const dec = zmode === 3 ? 1 : 0, blend = zmode === 2 ? 1 : 0;
      const fbl = ((curomode >>> 14) & 1) || ((curomode >>> 13) & 1) ? 1 : 0;
      const c = curcomb0;
      const mod = [(c >>> 20) & 0xF, (c >>> 15) & 0x1F, (c >>> 5) & 0xF, c & 0x1F].includes(4) ? 1 : 0;
      const ek = rt ? ekStr + "/" + rt : ekStr;
      const ac = !omodeSet || (curomode & 3) !== 0 || ((curomode >>> 12) & 1) ? 1 : 0;
      const wrapS = curcmS & 2 ? 2 : (curcmS & 1 ? 1 : 0), wrapT = curcmT & 2 ? 2 : (curcmT & 1 ? 1 : 0);
      const tg = curgeo & 0x40000 ? 1 : 0;   // G_TEXTURE_GEN: UVs generated from normals (chrome / env maps)
      const key = [ti, dec, blend, sky, ek, mod, rt, ac, wrapS, wrapT, fbl, sampled ? "" : "u" + curtex, tg].join("|");
      let g = groups.get(key);
      if (!g) {
        g = { V: [], map: new Map(), F: [], ti, dec, blend, prim: curprim, sky, mod, rt, ac, ws: wrapS, wt: wrapT, fbl, uls: curuls, ult: curult, tg };
        groups.set(key, g);
      }
      return g;
    }

    const lim = runEnd === null ? data.length : Math.min(data.length, runEnd);
    while (i + 8 <= lim) {
      const w0 = u32(data, i), w1 = u32(data, i + 4), op = w0 >>> 24;
      if (op === 0xDF) {
        if (runEnd === null) break;
        i += 8; continue;
      }
      if (op === 0x01) {
        const n = (w0 >>> 12) & 0xFF, end = (w0 >>> 1) & 0x7F, start = end - n, seg = (w1 >>> 24) & 0xF, off = w1 & 0xFFFFFF;
        const vb = seg === 1 ? vtxBase + off : off;
        for (let k = 0; k < n; k++) {
          const vo = vb + k * 16;
          if (vmin <= vo && vo + 16 <= vend) {
            const x = s16(data, vo) + mtx[0], y = s16(data, vo + 2) + mtx[1], z = s16(data, vo + 4) + mtx[2];
            slot.set(start + k, [x, y, z, s16(data, vo + 8), s16(data, vo + 10), u8(data, vo + 12), u8(data, vo + 13), u8(data, vo + 14), u8(data, vo + 15),
              cbfdNormal(data, nb, start + k, vo)]);
          }
        }
      } else if (op === 0xDC && (w0 & 0xFF) === 0x0E) {
        const seg = (w1 >>> 24) & 0xF, off = w1 & 0xFFFFFF;
        nb = seg === 1 ? vtxBase + off : seg === 0 ? off : -1;   // runtime segments: not in the file
      } else if (op === 0xDA && skel) {
        mtx = skel.get(Math.floor((w1 & 0xFFFFFF) / 0x40)) || mtxDefault;
      } else if (op === 0xFA) {
        curprim = [(w1 >>> 24) & 0xFF, (w1 >>> 16) & 0xFF, (w1 >>> 8) & 0xFF];
      } else if (op === 0xEF) {
        curomode = w1; omodeSet = true;
      } else if (op === 0xFC) {
        curcomb0 = w0; curcomb1 = w1; combSet = true;
      } else if (op === 0xD9) {
        curgeo = ((curgeo & (w0 & 0xFFFFFF)) | w1) >>> 0;
      } else if (op === 0xE2) {
        const shf = (w0 >>> 8) & 0xFF, length = (w0 & 0xFF) + 1, sft = 32 - length - shf;
        if (0 <= sft && sft <= 32) {
          const mask = omodeMask(length, sft);
          curomode = ((curomode & ~mask) | (w1 & mask)) >>> 0; omodeSet = true;
        }
      } else if (op === 0xFD) {
        const off = w1 & 0xFFFFFF;
        curflag = off & 0xC00000; curtex = off & 0x3FFFFF; expsize = true;
        curseg = (w1 >>> 24) & 0xF;
        curfmt = (w0 >>> 21) & 7; cursiz = (w0 >>> 19) & 3;
      } else if (op === 0xF5) {
        curfmt = (w0 >>> 21) & 7; cursiz = (w0 >>> 19) & 3;
        // wrap/mask belong to the render tile (0); a later palette or load tile (6/7) doesn't change how it samples
        if (((w1 >>> 24) & 7) === 0) {
          curcmS = (w1 >>> 8) & 3; curcmT = (w1 >>> 18) & 3;
          maskS = (w1 >>> 4) & 0xF; maskT = (w1 >>> 14) & 0xF;
        }
      } else if (op === 0xF2) {
        const uls = (w0 >>> 12) & 0xFFF, ult = w0 & 0xFFF, lrs = (w1 >>> 12) & 0xFFF, lrt = w1 & 0xFFF, tile0 = ((w1 >>> 24) & 7) === 0;
        if (tile0) { t0W = ((lrs - uls) >> 2) + 1; t0H = ((lrt - ult) >> 2) + 1; t0uls = uls; t0ult = ult; }
        // the first SETTILESIZE after SETTIMG is the render tile; later ones are mip levels (TMEM offsets, not UVs)
        if (expsize) {
          curW = ((lrs - uls) >> 2) + 1; curH = ((lrt - ult) >> 2) + 1;
          // a mipmapped load that keeps the render tile (0) from the previous texture sizes only its mip tiles; the
          // UV origin is still tile 0's (mip origins are scaled per level) — taking the mip's left clamped UVs whole
          // texture-widths off, so the surface showed one edge texel (a03·0019's hand)
          curuls = tile0 ? uls : t0uls; curult = tile0 ? ult : t0ult; expsize = false;
        }
      } else if (op === 0x05 || op === 0x06 || (0x10 <= op && op <= 0x1F)) {
        const g = gettarget();
        for (const [a, b, c] of triOf(op, w0, w1)) {
          if (slot.has(a) && slot.has(b) && slot.has(c) && a !== b && b !== c && a !== c) {
            const idx = [];
            for (const s of [a, b, c]) {
              const v = slot.get(s), m = g.map.get(s);
              if (m === undefined || g.V[m][0] !== v[0] || g.V[m][1] !== v[1] || g.V[m][2] !== v[2]) { g.map.set(s, g.V.length); g.V.push(v); }
              idx.push(g.map.get(s));
            }
            g.F.push(idx);
          }
        }
      }
      i += 8;
    }
    Object.assign(state, { tex: curtex, W: curW, H: curH, fmt: curfmt, siz: cursiz, flag: curflag, exp: expsize, prim: curprim,
      omode: curomode, comb0: curcomb0, seg: curseg, cmS: curcmS, cmT: curcmT, omset: omodeSet, lastpool, uls: curuls, ult: curult,
      comb1: curcomb1, combset: combSet, geo: curgeo, t0W, t0H, maskS, maskT, nb, t0uls, t0ult });
  }

  // ---------- runtime-bound animated textures ----------
  const chunkOf = (name) => { if (!name.startsWith("sub")) return -1; const v = Number(name.slice(3)); return Number.isInteger(v) ? v : -1; };
  let rtWaterFrames = null, panelFramesL = null, lv1aPanelsL = null;
  const rtWater = () => {
    if (!rtWaterFrames) {
      const f = RT_WATER.map((t) => texIndex(t, 64, 64, 2, 0, 0x800000)).filter((i) => i >= 0);
      rtWaterFrames = f.length > 2 ? [...f, ...f.slice(1, -1).reverse()] : f;   // ping-pong
    }
    return rtWaterFrames;
  };
  const panelFrames = () => (panelFramesL ??= PANEL_FRAMES_IDS.map((t) => texIndex(t, 32, 32, 0, 2, 0)).filter((i) => i >= 0));
  const lv1aPanels = () => (lv1aPanelsL ??= LV1A_PANEL_IDS.map((t) => texIndex(t, 64, 32, 0, 2, 0)).filter((i) => i >= 0));

  function rtFallback(groups, onlyUntextured = false) {
    let best = null, bestn = 0;
    for (const gr of groups.values()) if (gr.ti >= 0 && gr.F.length > bestn) { bestn = gr.F.length; best = gr.ti; }
    if (best === null) return;
    for (const gr of groups.values()) if (gr.rt && (!onlyUntextured || gr.ti < 0)) gr.ti = best;
  }

  // ---------- pack groups -> item ----------
  function bandOf(a, n, k) {
    const p = a[Math.floor(n * 0.02)], q = a[Math.floor(n * 0.98)], r = (q - p) || 1;
    return [p - k * r, q + k * r];
  }
  function encodeGroup(V, used, ti, guls, gult) {
    const P = new Int16Array(used.length * 3), UV = new Int16Array(used.length * 2), COL = new Uint8Array(used.length * 3), VA = new Uint8Array(used.length);
    const tw = ti >= 0 ? TEX[ti].w : 1, th = ti >= 0 ? TEX[ti].h : 1;
    used.forEach((oi, k) => {
      const v = V[oi];
      P[k * 3] = clampI16(pyRound(v[0])); P[k * 3 + 1] = clampI16(pyRound(v[1])); P[k * 3 + 2] = clampI16(pyRound(v[2]));
      const u = (v[3] / 32.0 - guls) / tw, vv = (v[4] / 32.0 - gult) / th;
      UV[k * 2] = clampUV(pyRound(u * 512)); UV[k * 2 + 1] = clampUV(pyRound(vv * 512));
      COL[k * 3] = v[5]; COL[k * 3 + 1] = v[6]; COL[k * 3 + 2] = v[7];
      VA[k] = v.length > 8 ? v[8] : 255;
    });
    return { P, UV, COL, VA, NRM: encodeNormals(used.map((oi) => V[oi]), 9) };
  }
  function uvSpan(UV, axis) {
    let mn = Infinity, mx = -Infinity;
    for (let i = axis; i < UV.length; i += 2) { if (UV[i] < mn) mn = UV[i]; if (UV[i] > mx) mx = UV[i]; }
    return UV.length ? (mx - mn) / 512.0 : 0.0;
  }
  const minOf = (a) => { let m = Infinity; for (const x of a) if (x < m) m = x; return m; };

  function packItem(name, src, kind, groups, animmap = null, allowCull = false) {
    const allv = [];
    for (const g of groups.values()) for (const v of g.V) allv.push(v);
    if (allv.length < 6) return null;
    const n = allv.length;
    const xs = allv.map((v) => v[0]).sort((a, b) => a - b), ys = allv.map((v) => v[1]).sort((a, b) => a - b), zs = allv.map((v) => v[2]).sort((a, b) => a - b);
    const bx = bandOf(xs, n, 5), by = bandOf(ys, n, 5), bz = bandOf(zs, n, 5);
    const okv = (v) => bx[0] <= v[0] && v[0] <= bx[1] && by[0] <= v[1] && v[1] <= by[1] && bz[0] <= v[2] && v[2] <= bz[1] && Math.abs(v[0]) < 32760 && Math.abs(v[1]) < 32760 && Math.abs(v[2]) < 32760;
    const diag = Math.sqrt((bx[1] - bx[0]) ** 2 + (by[1] - by[0]) ** 2 + (bz[1] - bz[0]) ** 2) || 1;
    const spanThresh = 0.30 * diag;
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const valid = new Map(), en = new Map();
    let nspan = 0, nvalid = 0;
    const vkey = (v) => v[0] + "," + v[1] + "," + v[2];
    for (const [key, g] of groups) {
      const V = g.V, lst = [];
      for (const f of g.F) {
        if (!(okv(V[f[0]]) && okv(V[f[1]]) && okv(V[f[2]]))) continue;
        const a = V[f[0]], b = V[f[1]], c = V[f[2]];
        const sp = Math.max(dist(a, b), dist(b, c), dist(c, a)) > spanThresh;
        lst.push([f, sp]); nvalid++; if (sp) nspan++;
        if (allowCull) {
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          const nrm = [nx / nl, ny / nl, nz / nl];
          for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const ek = cmpTuple(p.slice(0, 3), q.slice(0, 3)) <= 0 ? vkey(p) + "|" + vkey(q) : vkey(q) + "|" + vkey(p);
            let l = en.get(ek); if (!l) en.set(ek, (l = [])); l.push(nrm);
          }
        }
      }
      valid.set(key, lst);
    }
    if (nvalid < 6) return null;
    const frac = nspan / nvalid;
    let coh = 1.0;
    if (allowCull) {
      const dots = [];
      for (const ns of en.values()) {
        if (ns.length >= 2) { const n0 = ns[0]; for (let k = 1; k < ns.length; k++) { const m = ns[k]; dots.push(Math.abs(n0[0] * m[0] + n0[1] * m[1] + n0[2] * m[2])); } }
      }
      coh = dots.length ? pySum(dots) / dots.length : 0.0;
    }
    const docull = allowCull && frac > 0.10, hopeless = allowCull && frac > 0.45;
    const out = [];
    let tot = 0;
    for (const [key, lst] of valid) {
      const g = groups.get(key), V = g.V;
      let ti = g.ti, rtFrames = null;
      const rt = g.rt || 0;
      if (rt && V.length && !allowCull) {
        let hz = 0.0, nf = 0;
        for (const [f] of lst.slice(0, 400)) {
          const a = V[f[0]], b = V[f[1]], c = V[f[2]];
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          hz += Math.abs(ny) / nl; nf++;
        }
        const horiz = nf ? hz / nf : 0;
        let rs = 0, gs = 0, bs = 0;
        for (const v of V) { rs += v[5]; gs += v[6]; bs += v[7]; }
        const rr = Math.floor(rs / V.length), gg = Math.floor(gs / V.length), bb = Math.floor(bs / V.length);
        const orange = rr > gg + 20 && rr > bb + 20 && rr > 60;
        if (chunkOf(name) === 26) { const pf = lv1aPanels(); if (pf.length) { ti = pf[0]; rtFrames = pf; } }
        else if (horiz > 0.55 && !orange && WATER_CHUNKS.has(chunkOf(name))) { const fr = rtWater(); if (fr.length) { ti = fr[0]; rtFrames = fr; } }
      }
      if (g.sky && ti < 0) continue;
      const F = lst.filter(([, sp]) => !(docull && sp)).map(([f]) => f);
      if (!F.length) continue;
      const used = sortedNums(F.flat()), rm = new Map(used.map((o, k) => [o, k]));
      const guls = g.ws === 2 ? (g.uls || 0) / 4.0 : 0.0, gult = g.wt === 2 ? (g.ult || 0) / 4.0 : 0.0;
      const { P, UV, COL, VA, NRM } = encodeGroup(V, used, ti, guls, gult);
      const IDX = new Uint16Array(F.length * 3);
      F.forEach((f, k) => { IDX[k * 3] = rm.get(f[0]); IDX[k * 3 + 1] = rm.get(f[1]); IDX[k * 3 + 2] = rm.get(f[2]); });
      const grp = { ti, p: P, uv: UV, col: COL, idx: IDX };
      if (NRM) grp.nrm = NRM;
      if (VA.length && minOf(VA) < 250) { grp.va = VA; grp.vat = 1; }
      if (ti >= 0 && TEX[ti].a) grp.al = 1;
      if (g.ac) grp.ac = 1;
      if (allowCull && grp.al && !grp.ac) grp.bl = 1;   // objects: soft alpha with no alpha test only looks right blended
      let ws = g.ws || 0, wt = g.wt || 0;
      if (UV.length) {
        if (ws === 2 && !g.dec && uvSpan(UV, 0) > 1.5) ws = 0;
        if (wt === 2 && !g.dec && uvSpan(UV, 1) > 1.5) wt = 0;
      }
      if (ws) grp.ws = ws;
      if (wt) grp.wt = wt;
      if (rtFrames) { grp.anim = rtFrames; grp.rt = 1; grp.aspd = 4; grp.mod = 1; }
      else {
        if (g.dec) grp.dec = 1;
        if (g.blend) grp.bl = 1;
        if (grp.vat && g.fbl) grp.bl = 1;
        if (g.sky || (ti >= 0 && ti < TEXMETA.length && BACKDROP_TEXIDS.has(TEXMETA[ti][0]))) {
          const uvmax = Math.max(uvSpan(UV, 0), uvSpan(UV, 1));
          if (uvmax < 4.0) grp.sky = 1;
        }
        if (g.mod) grp.mod = 1;
        if (g.tg) grp.tg = 1;
        const pr = g.prim || [255, 255, 255];
        if (!(pr[0] === 255 && pr[1] === 255 && pr[2] === 255)) grp.tint = [...pr];
        if (animmap && animmap.has(ti)) grp.anim = animmap.get(ti);
      }
      out.push(grp); tot += F.length;
    }
    if (!out.length || tot < 8 || hopeless) return null;
    return { name, src, kind, groups: out, ntri: tot, _soup: pyRoundN(frac, 3), _coh: pyRoundN(coh, 3) };
  }

  function packPart(groups, animmap = null) {
    const allv = [];
    for (const g of groups.values()) for (const v of g.V) if (Math.abs(v[0]) < 32760 && Math.abs(v[1]) < 32760 && Math.abs(v[2]) < 32760) allv.push(v);
    if (allv.length < 3) return [[], 0];
    const n = allv.length;
    const xs = allv.map((v) => v[0]).sort((a, b) => a - b), ys = allv.map((v) => v[1]).sort((a, b) => a - b), zs = allv.map((v) => v[2]).sort((a, b) => a - b);
    const bx = bandOf(xs, n, 6), by = bandOf(ys, n, 6), bz = bandOf(zs, n, 6);
    const okv = (v) => bx[0] <= v[0] && v[0] <= bx[1] && by[0] <= v[1] && v[1] <= by[1] && bz[0] <= v[2] && v[2] <= bz[1] && Math.abs(v[0]) < 32760 && Math.abs(v[1]) < 32760 && Math.abs(v[2]) < 32760;
    const out = [];
    let tot = 0;
    for (const g of groups.values()) {
      const V = g.V, ti = g.ti;
      const F = g.F.filter((f) => okv(V[f[0]]) && okv(V[f[1]]) && okv(V[f[2]]));
      if (!F.length) continue;
      const used = sortedNums(F.flat()), rm = new Map(used.map((o, k) => [o, k]));
      const guls = g.ws === 2 ? (g.uls || 0) / 4.0 : 0.0, gult = g.wt === 2 ? (g.ult || 0) / 4.0 : 0.0;
      const { P, UV, COL, VA, NRM } = encodeGroup(V, used, ti, guls, gult);
      const IDX = new Uint16Array(F.length * 3);
      F.forEach((f, k) => { IDX[k * 3] = rm.get(f[0]); IDX[k * 3 + 1] = rm.get(f[1]); IDX[k * 3 + 2] = rm.get(f[2]); });
      if (!IDX.length) continue;
      const grp = { ti, p: P, uv: UV, col: COL, idx: IDX };
      if (NRM) grp.nrm = NRM;
      if (VA.length && minOf(VA) < 250) { grp.va = VA; grp.vat = 1; }
      if (ti >= 0 && TEX[ti].a) grp.al = 1;
      if (g.ac) grp.ac = 1;
      let ws = g.ws || 0, wt = g.wt || 0;
      if (UV.length) {
        if (ws === 2 && !g.dec && uvSpan(UV, 0) > 1.5) ws = 0;
        if (wt === 2 && !g.dec && uvSpan(UV, 1) > 1.5) wt = 0;
      }
      if (ws) grp.ws = ws;
      if (wt) grp.wt = wt;
      if (g.dec) grp.dec = 1;
      if (g.blend) grp.bl = 1;
      if (g.mod) grp.mod = 1;
      if (g.tg) grp.tg = 1;
      if (animmap && animmap.has(ti)) grp.anim = animmap.get(ti);
      out.push(grp); tot += F.length;
    }
    return [out, tot];
  }

  function isMapPlane(groups) {
    let n = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const g of groups.values()) for (const v of g.V) {
      if (Math.abs(v[0]) < 32000 && Math.abs(v[1]) < 32000 && Math.abs(v[2]) < 32000) {
        n++;
        if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0];
        if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1];
        if (v[2] < z0) z0 = v[2]; if (v[2] > z1) z1 = v[2];
      }
    }
    if (n < 3) return false;
    const sp = [x1 - x0, y1 - y0, z1 - z0].sort((a, b) => a - b);
    return sp[2] > 30000 && sp[0] < 2000;
  }

  // ---------- OBJECT builder (assets03 / assets09 files) ----------
  function buildObject(blob) {
    if (blob.length < 0x30) return [null, false];
    const head = u32(blob, 0), vb = objVtxBase(blob);
    if (!(0x28 <= head && head < blob.length)) return [null, false];
    const skel = readSkeleton(blob);
    let dls;
    if (blob[head] !== 0) dls = [head];
    else {
      const cnt = u32(blob, 4) >>> 2;
      if (cnt === 0 || cnt > 256) return [null, false];
      dls = [];
      for (let i = 0; i < cnt; i++) dls.push(u32(blob, head + 4 * i));
    }
    const groups = new Map(), tstate = {};
    for (const dl of dls) {
      if (!(0x28 <= dl && dl < blob.length)) continue;
      walkDlGroups(blob, dl, vb, head, groups, { skel, state: tstate, rtInherit: true, vmin: vb });
    }
    rtFallback(groups);
    return [groups, skel !== null];
  }

  // ---------- assets01 world models (characters / props) ----------
  const A01 = rom.group(0x01), PD01 = parseDir(A01);
  function getA01(id) {
    if (!PD01 || id >= PD01.length) return null;
    const [o, s, c] = PD01[id], blob = A01.subarray(o, o + s);
    const dec = c ? runzip(blob) : null;
    return truthy(dec) ? dec : blob;
  }
  function a01FindDl(data, vend) {
    let best = null, i = vend;
    const n = data.length;
    while (i + 8 <= n) {
      if (A01KNOWN.has(data[i])) {
        let j = i, ops = 0;
        while (j + 8 <= n) {
          if (data[j] === 0xDF) { ops++; j += 8; break; }
          if (A01KNOWN.has(data[j])) { ops++; j += 8; } else break;
        }
        if (ops >= 12 && (best === null || ops > best[1])) best = [i, ops];
        i = Math.max(j, i + 8);
      } else i += 8;
    }
    return best ? best[0] : null;
  }
  function a01Skel(data) {
    const so = u32(data, 0x10), sl = u32(data, 0x14);
    if (so === 0 || sl === 0 || sl % 16 || so + sl > data.length) return null;
    const bc = sl / 16;
    if (bc < 1 || bc > 200) return null;
    const bones = [];
    for (let i = 0; i < bc; i++) bones.push([u8(data, so + i * 16), u8(data, so + i * 16 + 1), f32(data, so + i * 16 + 4), f32(data, so + i * 16 + 8), f32(data, so + i * 16 + 12)]);
    return resolveBones(bones);
  }
  function a01FirstRun(data, hint) {
    let i = hint;
    const n = data.length;
    while (i + 8 <= n) {
      if (A01KNOWN.has(data[i])) {
        let j = i, ops = 0, ended = false;
        while (j + 8 <= n) {
          if (data[j] === 0xDF) { ops++; j += 8; ended = true; break; }
          if (A01KNOWN.has(data[j])) { ops++; j += 8; } else break;
        }
        if (ended && ops >= 6) return i;
        i = Math.max(j, i + 8);
      } else i += 8;
    }
    return null;
  }
  function a01DlRange(data, so, sl) {
    const vend = u32(data, 0x08) || 0x1000;
    // the display list follows the texture table (header 0x18/0x1C), on the next 8-byte boundary; scanning from
    // a 4-mod-8 offset never lines up with a real command (models 8, 58, 135, 145)
    const tt = u32(data, 0x18), tn = u32(data, 0x1c);
    let hint = so && so + sl <= data.length ? so + sl : Math.min(vend, data.length);
    if (tt && tn % 12 === 0 && tt + tn <= data.length && tt >= hint) hint = (tt + tn + 7) & ~7;
    let dlStart = a01FirstRun(data, hint);
    if (dlStart === null) dlStart = a01FindDl(data, Math.min(vend, data.length));
    if (dlStart === null) return null;
    const secC = u32(data, 0x20);
    let dlEnd = dlStart < secC && secC <= data.length ? secC : data.length;
    // header 0x08/0x0C lists the model's display lists; 31 models also list a second set at 0x28/0x2C that redraws
    // the same triangles with no texture setup and its own normal stream (a runtime pass). It follows the first set,
    // so stop there — walking it stacked a stale-textured duplicate of every triangle on top of the real mesh.
    const t1 = u32(data, 0x28), c1 = u32(data, 0x2C);
    if (t1 && c1 && c1 % 4 === 0 && t1 + c1 <= data.length) {
      for (let k = 0; k < c1; k += 4) { const p = u32(data, t1 + k); if (p > dlStart && p < dlEnd) dlEnd = p; }
    }
    return [vend, dlStart, dlEnd];
  }
  // an assets01 model's own texture table (header 0x18/0x1C): 12-byte {texid, texid, W<<16|H} entries — the real
  // texture sizes, which the display list's tile setup only approximates (mips, 64x16 load tiles, ...)
  function a01TexDims(data) {
    const tdims = new Map(), t = u32(data, 0x18), n = u32(data, 0x1c);
    if (t && n && n % 12 === 0 && t + n <= data.length) for (let i = t; i < t + n; i += 12) { const wh = u32(data, i + 8); if (wh) tdims.set(u32(data, i), [wh >>> 16, wh & 0xFFFF]); }
    return tdims;
  }
  function buildA01Object(id) {
    const data = getA01(id);
    if (!truthy(data) || data.length < 0x40) return [null, false];
    const skel = a01Skel(data);
    const r = a01DlRange(data, u32(data, 0x10), u32(data, 0x14));
    if (!r) return [null, false];
    const [, dlStart, dlEnd] = r, groups = new Map();
    walkDlGroups(data, dlStart, 0, data.length, groups, { skel, runEnd: dlEnd, rtInherit: true, tdims: a01TexDims(data) });
    rtFallback(groups);
    return [groups, skel !== null];
  }

  // walk a posable model's display list(s): bone-LOCAL vertices tagged with the G_MTX slot that drives them.
  // ranges = [[start, end, stopAtENDDL]], vaddr(seg, off) -> file offset of a vertex block, mh = runtime hints
  function walkPosable(data, ranges, vend, vaddr, tdims, mh, vmin = 0x28) {
    const groups = new Map(), slot = new Map(), vslot = new Map();
    let curslot = 0, curtex = null, curW = 0, curH = 0, curfmt = null, cursiz = null, curflag = 0, expsize = false;
    let curomode = 0, omodeSet = false, curcomb0 = 0, curcomb1 = 0, combSet = false, curseg = 0, curcmS = 0, curcmT = 0, curgeo = 0, nb = -1;
    function gettarget() {
      const rt = curseg >= 2 ? curseg : 0;
      const sampled = !combSet || combUsesTex(curcomb0, curcomb1);
      // runtime-bound segments (eyes, irises, faces) can't be read from the DL; hints name the texture
      const hk = rt + ":" + curW + "x" + curH;
      // hint per segment+tile: {tex} = show that texture, {tex:null} = untextured, {drop} = not drawn
      const h0 = !rt ? undefined : !sampled ? mh[hk + ":u"] : (mh[hk] !== undefined ? mh[hk] : mh[rt + ":*"]);
      const h = h0 && (h0.drop || (sampled && h0.tex)) ? h0 : null;
      const td = curtex ? tdims.get(curtex) : null;
      const ti = !sampled ? -1 : rt ? (h && h.tex ? texIndex(...h.tex) : -1) : (curtex ? texIndex(curtex, td ? td[0] : curW, td ? td[1] : curH, curfmt, cursiz, curflag) : -1);
      const zmode = (curomode >>> 10) & 3, dec = zmode === 3 ? 1 : 0, blend = zmode === 2 ? 1 : 0;
      const c = curcomb0;
      let mod = [(c >>> 20) & 0xF, (c >>> 15) & 0x1F, (c >>> 5) & 0xF, c & 0x1F].includes(4) ? 1 : 0;
      if (curgeo & 0x40000) mod = 0;
      const ac = !omodeSet || (curomode & 3) !== 0 || ((curomode >>> 12) & 1) ? 1 : 0;
      const wrapS = curcmS & 2 ? 2 : (curcmS & 1 ? 1 : 0), wrapT = curcmT & 2 ? 2 : (curcmT & 1 ? 1 : 0);
      const key = [ti, dec, blend, mod, rt, ac, wrapS, wrapT, sampled ? "" : "u" + curtex, curgeo & 0x40000 ? "tg" : "",
        h && h.drop ? "drop" : "", debug && rt ? hk : ""].join("|");
      let g = groups.get(key);
      if (!g) {
        g = { V: [], map: new Map(), kk: new Map(), F: [], ti, dec, bl: blend, mod, rt, ac, ws: wrapS, wt: wrapT, sampled, hint: h, hk: sampled ? hk : hk + ":u", tg: curgeo & 0x40000 ? 1 : 0 };
        groups.set(key, g);
      }
      return g;
    }
    for (const [dlStart, dlEnd, stopAtEnd] of ranges) {
    let i = dlStart;
    while (i + 8 <= dlEnd) {
      const w0 = u32(data, i), w1 = u32(data, i + 4), op = w0 >>> 24;
      if (op === 0xDF) { if (stopAtEnd) break; i += 8; continue; }
      if (op === 0xDA) curslot = Math.floor((w1 & 0xFFFFFF) / 0x40);
      else if (op === 0x01) {
        const n = (w0 >>> 12) & 0xFF, end = (w0 >>> 1) & 0x7F, start = end - n, off = vaddr((w1 >>> 24) & 0xF, w1 & 0xFFFFFF);
        for (let k = 0; k < n; k++) {
          const vo = off + k * 16;
          if (vmin <= vo && vo + 16 <= vend) {
            slot.set(start + k, [s16(data, vo), s16(data, vo + 2), s16(data, vo + 4), s16(data, vo + 8), s16(data, vo + 10), u8(data, vo + 12), u8(data, vo + 13), u8(data, vo + 14), u8(data, vo + 15),
              cbfdNormal(data, nb, start + k, vo)]);
            vslot.set(start + k, curslot);
          } else slot.delete(start + k);
        }
      } else if (op === 0xDC && (w0 & 0xFF) === 0x0E) {
        const seg = (w1 >>> 24) & 0xF;
        nb = seg <= 1 ? vaddr(seg, w1 & 0xFFFFFF) : -1;   // runtime segments: not in the file
      } else if (op === 0xEF) { curomode = w1; omodeSet = true; }
      else if (op === 0xFC) { curcomb0 = w0; curcomb1 = w1; combSet = true; }
      else if (op === 0xD9) curgeo = ((curgeo & (w0 & 0xFFFFFF)) | w1) >>> 0;
      else if (op === 0xE2) {
        const shf = (w0 >>> 8) & 0xFF, length = (w0 & 0xFF) + 1, sft = 32 - length - shf;
        if (0 <= sft && sft <= 32) { const mask = omodeMask(length, sft); curomode = ((curomode & ~mask) | (w1 & mask)) >>> 0; omodeSet = true; }
      } else if (op === 0xFD) {
        const off = w1 & 0xFFFFFF;
        curflag = off & 0xC00000; curtex = off & 0x3FFFFF; expsize = true;
        curseg = (w1 >>> 24) & 0xF; curfmt = (w0 >>> 21) & 7; cursiz = (w0 >>> 19) & 3;
      } else if (op === 0xF5) {
        curfmt = (w0 >>> 21) & 7; cursiz = (w0 >>> 19) & 3;
        if (((w1 >>> 24) & 7) === 0) { curcmS = (w1 >>> 8) & 3; curcmT = (w1 >>> 18) & 3; }   // render tile only
      } else if (op === 0xF2) {
        // render-tile (0) size, whether it's set before or after the SETTIMG (both orders occur); tiles 1+ are mips
        if (((w1 >>> 24) & 7) === 0) {
          const uls = (w0 >>> 12) & 0xFFF, ult = w0 & 0xFFF, lrs = (w1 >>> 12) & 0xFFF, lrt = w1 & 0xFFF;
          curW = ((lrs - uls) >> 2) + 1; curH = ((lrt - ult) >> 2) + 1; expsize = false;
        }
      } else if (op === 0x05 || op === 0x06 || (0x10 <= op && op <= 0x1F)) {
        const g = gettarget();
        for (const [a, b, c] of triOf(op, w0, w1)) {
          if (slot.has(a) && slot.has(b) && slot.has(c) && a !== b && b !== c && a !== c) {
            const idx = [];
            for (const s of [a, b, c]) {
              const v = slot.get(s), sl_ = vslot.has(s) ? vslot.get(s) : 0, kv = sl_ + "," + v[0] + "," + v[1] + "," + v[2];
              if (g.kk.get(s) !== kv) { g.map.set(s, g.V.length); g.V.push([sl_, ...v]); g.kk.set(s, kv); }
              idx.push(g.map.get(s));
            }
            g.F.push(idx);
          }
        }
      }
      i += 8;
    }
    }
    return groups;
  }
  function buildA01Posable(id) {
    const data = getA01(id);
    if (!truthy(data) || data.length < 0x40) return null;
    const so = u32(data, 0x10), sl = u32(data, 0x14), bc = Math.floor(sl / 16);
    if (so === 0 || bc === 0 || bc > 200 || so + bc * 16 > data.length) return null;
    const bones = [];
    for (let i = 0; i < bc; i++) {
      const o = so + i * 16;
      bones.push([u8(data, o), u8(data, o + 1), u8(data, o + 2), pyRoundN(f32(data, o + 4), 3), pyRoundN(f32(data, o + 8), 3), pyRoundN(f32(data, o + 12), 3)]);
    }
    const r = a01DlRange(data, so, sl);
    if (!r) return null;
    const [vend, dlStart, dlEnd] = r;
    const groups = walkPosable(data, [[dlStart, dlEnd, false]], vend, (seg, off) => off, a01TexDims(data), posHints[id] || {});
    return packPosable(id, bones, groups);
  }

  function packPosable(id, bones, groups, minTri = 12) {
    const outGroups = [];
    let ntri = 0;
    for (const g of groups.values()) {
      const V = g.V, F = g.F, ti = g.ti;
      if (!F.length || (g.hint && g.hint.drop)) continue;
      const used = sortedNums(F.flat()), rm = new Map(used.map((o, k) => [o, k]));
      const SLOT = new Uint8Array(used.length), POS = new Int16Array(used.length * 3), UV = new Int16Array(used.length * 2), COL = new Uint8Array(used.length * 3), VA = new Uint8Array(used.length);
      const tw = ti >= 0 ? TEX[ti].w : 1, th = ti >= 0 ? TEX[ti].h : 1;
      used.forEach((oi, k) => {
        const v = V[oi];
        SLOT[k] = v[0] & 0xFF;
        POS[k * 3] = clampI16(v[1]); POS[k * 3 + 1] = clampI16(v[2]); POS[k * 3 + 2] = clampI16(v[3]);
        UV[k * 2] = clampUV(pyRound(v[4] / 32.0 / tw * 512)); UV[k * 2 + 1] = clampUV(pyRound(v[5] / 32.0 / th * 512));
        if (g.hint && g.hint.tex) COL[k * 3] = COL[k * 3 + 1] = COL[k * 3 + 2] = 255;   // runtime face textures are drawn unshaded
        else { COL[k * 3] = v[6]; COL[k * 3 + 1] = v[7]; COL[k * 3 + 2] = v[8]; }
        VA[k] = v.length > 9 ? v[9] : 255;
      });
      const IDX = new Uint16Array(F.length * 3);
      F.forEach((f, k) => { IDX[k * 3] = rm.get(f[0]); IDX[k * 3 + 1] = rm.get(f[1]); IDX[k * 3 + 2] = rm.get(f[2]); });
      if (!IDX.length) continue;
      ntri += IDX.length / 3;
      const al = ti >= 0 && TEX[ti].a ? 1 : 0;
      const gg = { ti, al, ac: g.ac, bl: g.bl, dec: g.dec, mod: g.mod, ws: g.ws, wt: g.wt, n: IDX.length, slot: SLOT, pos: POS, uv: UV, col: COL, idx: IDX };
      const NRM = encodeNormals(used.map((oi) => V[oi]), 10);   // bone-local (the bind skeleton only translates)
      if (NRM) gg.nrm = NRM;
      if (g.hint && g.hint.fl) Object.assign(gg, g.hint.fl[[gg.dec, gg.ac, gg.bl, gg.ws, gg.wt].map((v) => v || 0).join()] || {});
      if (VA.length && minOf(VA) < 250) { gg.va = VA; gg.vat = 1; }
      if (gg.bl && !gg.al && !gg.vat) gg.bl = 0;   // XLU render mode with nothing to blend -> draw opaque
      if (g.tg) gg.tg = 1;                          // G_TEXTURE_GEN: UVs come from the normals (chrome / env maps)
      const h = g.hint;   // eye blink frames / frown swaps for runtime-bound faces
      if (h && h.blink) gg.blink = h.blink.map((t) => texIndex(...t));
      if (h && h.frown) gg.frown = texIndex(...h.frown);
      if (h && h.frownIris) gg.frownIris = texIndex(...h.frownIris);
      if (debug) { gg._seg = g.rt; gg._hk = g.hk; gg._sampled = g.sampled; gg._rawcol = Uint8Array.from(used.flatMap((oi) => V[oi].slice(6, 9))); }
      if (h && h.variants) {
        // runtime-selected texture variants (e.g. shirt colour): one copy of the group per variant
        h.variants.forEach((t, vi) => { const vti = texIndex(...t); outGroups.push({ ...gg, ti: vti, al: vti >= 0 && TEX[vti].a ? 1 : 0, variant: vi }); });
        ntri += (h.variants.length - 1) * IDX.length / 3;
        continue;
      }
      outGroups.push(gg);
    }
    if (ntri < minTri || !outGroups.length) return null;
    const pm = { id, bones, groups: outGroups, ntri };
    if (hints && hints.models && hints.models[id] && hints.models[id].variants) pm.variants = hints.models[id].variants;
    return pm;
  }

  // ---------- LEVEL builder ----------
  const groupCache = new Map();
  function subdata(blobIdx, idx) {
    if (!groupCache.has(blobIdx)) { const d = rom.group(blobIdx); groupCache.set(blobIdx, [d, parseDir(d)]); }
    const [d, top] = groupCache.get(blobIdx);
    if (!top || idx >= top.length) return null;
    const [o, s, c] = top[idx];
    let data = d.subarray(o, o + s);
    if (c) { const dec = runzip(data); if (truthy(dec)) data = dec; }
    return data;
  }
  function records(b) {
    if (b === null) return [];
    const out = [];
    for (let i = 0; i < Math.floor(b.length / 0x44); i++) {
      const r = b.subarray(i * 0x44, (i + 1) * 0x44);
      out.push({ pos: [s16(r, 0), s16(r, 2), s16(r, 4)], rot: [s16(r, 6), s16(r, 8), s16(r, 0xA)],
        kind: u32(r, 0xC), id: u32(r, 0x10), beh: u32(r, 0x14), init: u32(r, 0x18),
        scale: [f32(r, 0x20), f32(r, 0x24), f32(r, 0x28)], state: r[0x34], flags: r[0x3C] });
    }
    return out;
  }
  function partExtent(data, po) {
    const dlRel = u32(data, po), vb = po + 0x28, ve = po + dlRel;
    let n = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = vb; i + 16 <= ve; i += 16) {
      const x = s16(data, i), y = s16(data, i + 2), z = s16(data, i + 4); n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (!n) return [0, 0, 0];
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    return [Math.max(ex, ey, ez), Math.min(ex, ey, ez), Math.floor((ve - vb) / 16)];
  }
  const isEnclosure = (ext, mn, nv) => ext > 7000 && mn > 2500 && nv < 250;

  const A03 = rom.group(0x03), PD03 = parseDir(A03);
  function getA03(oid) {
    if (!PD03 || oid < 0 || oid >= PD03.length) return null;
    const [o, s, c] = PD03[oid];
    if (s === 0) return null;
    const blob = A03.subarray(o, o + s), dec = c ? runzip(blob) : null;
    return truthy(dec) ? dec : blob;
  }
  // ---------- articulated held props: assets09[objId] skinned to its own little skeleton ----------
  const A09 = rom.group(0x09), PD09 = parseDir(A09);
  function getA09(oid) {
    if (!PD09 || oid < 0 || oid >= PD09.length) return null;
    const [o, s, c] = PD09[oid];
    if (s === 0) return null;
    const blob = A09.subarray(o, o + s), dec = c ? runzip(blob) : null;
    return truthy(dec) ? dec : blob;
  }
  function buildPropPosable(objId) {
    const data = getA09(objId);
    if (!truthy(data) || data.length < 0x30) return null;
    const head = u32(data, 0), so = u32(data, 8), bc = u32(data, 0xC) >>> 4;
    if (!(0x28 <= head && head < data.length) || !so || !bc || bc > 200 || so + bc * 16 > data.length) return null;
    const bones = [];
    for (let i = 0; i < bc; i++) {
      const o = so + i * 16;
      bones.push([u8(data, o), u8(data, o + 1), u8(data, o + 2), pyRoundN(f32(data, o + 4), 3), pyRoundN(f32(data, o + 8), 3), pyRoundN(f32(data, o + 12), 3)]);
    }
    let dls;
    if (data[head] !== 0) dls = [head];
    else {
      const cnt = u32(data, 4) >>> 2;
      if (cnt === 0 || cnt > 256) return null;
      dls = [];
      for (let i = 0; i < cnt; i++) dls.push(u32(data, head + 4 * i));
    }
    const ranges = dls.filter((dl) => 0x28 <= dl && dl < data.length).map((dl) => [dl, data.length, true]);
    const vb = objVtxBase(data);
    const groups = walkPosable(data, ranges, head, (seg, off) => (seg === 1 ? vb + off : off), new Map(), {}, vb);
    return packPosable(-1, bones, groups, 1);   // small props (a 9-tri yo-yo string) are still real
  }
  function a03Groups(blob) {
    if (!truthy(blob) || blob.length < 0x30) return null;
    const head = u32(blob, 0), vb = objVtxBase(blob);
    if (!(0x28 <= head && head < blob.length)) return null;
    let dls;
    if (blob[head] !== 0) dls = [head];
    else {
      const cnt = u32(blob, 4) >>> 2;
      if (cnt === 0 || cnt > 256) return null;
      dls = [];
      for (let i = 0; i < cnt; i++) dls.push(u32(blob, head + 4 * i));
    }
    const groups = new Map(), tstate = {};
    for (const dl of dls) {
      if (!(0x28 <= dl && dl < blob.length)) continue;
      walkDlGroups(blob, dl, vb, head, groups, { state: tstate, rtInherit: false, vmin: vb });
    }
    return groups;
  }

  function buildLevel(level, animmap) {
    // a few levels (chunk 62) have no terrain block at all and are built purely from placed external props
    const a04 = subdata(0x04, level), pd = parseDir(a04) || [];
    let recs = records(subdata(0x0B, level));
    const tBc = subdata(0x0C, level), pdB = tBc ? parseDir(tBc) : null;
    if (pdB && pdB.length > 2) {
      const [o, s, c] = pdB[2];
      let tB = tBc.subarray(o, o + s);
      if (c) { const dec = runzip(tB); if (truthy(dec)) tB = dec; }
      recs = recs.concat(records(tB));
    }
    if (!pd.length && !recs.length) return null;
    const refparts = new Set(recs.filter((r) => r.kind === 1 || r.kind === 2).map((r) => r.id));
    const groups = new Map(), tstate = {};
    pd.forEach(([po, ps], pi) => {
      if (ps < 0x40 || refparts.has(pi)) return;
      const dlRel = u32(a04, po);
      if (!(0x28 <= dlRel && dlRel < ps)) return;
      const [ext, mn, nv] = partExtent(a04, po);
      const sky = isEnclosure(ext, mn, nv) ? 1 : 0;
      walkDlGroups(a04, po + dlRel, po + 0x28, po + dlRel, groups, { sky, state: tstate, extkey: pi, rtInherit: false });
    });
    const partpos = new Map();
    for (const r of recs) if ((r.kind === 1 || r.kind === 2) && !partpos.has(r.id)) partpos.set(r.id, r.pos);
    const valid = [];
    for (const pi of [...refparts].sort((a, b) => a - b)) {
      if (pi >= pd.length) continue;
      const [po, ps] = pd[pi];
      if (ps < 0x40) continue;
      const dlRel = u32(a04, po);
      if (!(0x28 <= dlRel && dlRel < ps)) continue;
      if (isEnclosure(...partExtent(a04, po))) continue;
      valid.push(pi);
    }
    const refwalk = (pi, seed) => {
      const [po] = pd[pi], dlRel = u32(a04, po), pg = new Map(), st = seed ? { ...seed } : {};
      walkDlGroups(a04, po + dlRel, po + 0x28, po + dlRel, pg, { extkey: ["p", pi], state: st, rtInherit: false });
      return [pg, st];
    };
    const finalst = new Map(), selftex = new Map();
    for (const pi of valid) {
      const [pg, st] = refwalk(pi, null);
      finalst.set(pi, st);
      selftex.set(pi, [...pg.values()].some((g) => g.ti >= 0));
    }
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const SEED_CAP2 = 3500 * 3500;
    const partpool = [], partidx = new Map();
    for (const pi of valid) {
      let seed = null;
      if (!selftex.get(pi) && partpos.has(pi)) {
        let best = null;
        for (const q of valid) {
          if (selftex.get(q) && partpos.has(q) && q !== pi) {
            const c = [d2(partpos.get(pi), partpos.get(q)), q];
            if (best === null || cmpTuple(c, best) < 0) best = c;
          }
        }
        if (best && best[0] <= SEED_CAP2) seed = finalst.get(best[1]);
      }
      const [pg] = refwalk(pi, seed);
      if (isMapPlane(pg)) continue;
      const [pk, nt] = packPart(pg, animmap);   // NB: raw texid-keyed map, looked up by tex index (as in Python)
      if (pk.length && nt >= 1) { partidx.set("04:" + pi, partpool.length); partpool.push({ part: pi, ext: 0, g: pk, nt }); }
    }
    for (const eid of [...new Set(recs.filter((r) => r.kind === 0).map((r) => r.id))].sort((a, b) => a - b)) {
      const blob = getA03(eid);
      if (!truthy(blob)) continue;
      let g;
      try { g = a03Groups(blob); } catch (e) { g = null; }
      if (!g || !g.size || isMapPlane(g)) continue;
      const [pk, nt] = packPart(g, animmap);
      if (pk.length && nt >= 1 && pk.some((gg) => (gg.ti ?? -1) >= 0)) { partidx.set("03:" + eid, partpool.length); partpool.push({ part: eid, ext: 1, g: pk, nt }); }
    }
    const reckey = (r) => (r.kind === 1 || r.kind === 2 ? "04:" + r.id : r.kind === 0 ? "03:" + r.id : null);
    const b19 = recs.filter((r) => r.beh === 0x19);
    if (b19.length && level === 23) {
      const pf = panelFrames();
      if (pf.length) for (const r of b19) {
        const k = reckey(r);
        if (k === null || !partidx.has(k)) continue;
        for (const g of partpool[partidx.get(k)].g) if ((g.ti ?? -1) < 0) { g.ti = pf[0]; g.anim = pf; g.aspd = 3; g.mod = 1; }
      }
    } else if (b19.length && WATER_CHUNKS.has(level)) {
      const wf = rtWater();
      if (wf.length) for (const r of b19) {
        const k = reckey(r);
        if (k === null || !partidx.has(k)) continue;
        for (const g of partpool[partidx.get(k)].g) if ((g.ti ?? -1) < 0) { g.ti = wf[0]; g.anim = wf; g.aspd = 4; g.rt = 1; g.mod = 1; }
      }
    }
    const bypos = new Map();
    let solo = 0;
    for (const r of recs) {
      const k = reckey(r);
      if (k === null || !partidx.has(k)) continue;
      let pk;
      if (r.pos[0] === 0 && r.pos[1] === 0 && r.pos[2] === 0) { solo++; pk = "solo:" + solo; }
      else pk = r.pos.join(",");
      let l = bypos.get(pk); if (!l) bypos.set(pk, (l = [])); l.push(r);
    }
    const props = [];
    let proptris = 0, gi = 0;
    for (const rs of bypos.values()) {
      const has0 = rs.some((r) => r.state === 0);
      for (const r of rs) {
        const vis = r.state === 0 || !has0 ? 1 : 0, pp = partidx.get(reckey(r));
        props.push({ pp, pos: [...r.pos], rot: [...r.rot], sc: r.scale.map((x) => pyRoundN(x, 3)), grp: gi, st: r.state, id: r.id,
          ext: partpool[pp].ext, beh: r.beh, init: r.init, fl: r.flags, vis });
        if (vis) proptris += partpool[pp].nt;
      }
      gi++;
    }
    return { groups, partpool, props, proptris };
  }

  // ---------- animated texture sets (D_80089324) ----------
  function loadAnimmap() {
    const gd = rom.gameData(), m = new Map(), base = 0x6804;
    for (let k = 0; k < 24; k++) {
      const o = base + k * 0xC;
      if (o + 0xC > gd.length) break;
      const fp = u32(gd, o), f1 = u32(gd, o + 4);
      if (fp < DATA_VRAM || fp - DATA_VRAM + 4 > gd.length) continue;
      const cnt = (f1 >>> 24) & 0xFF;
      if (cnt < 2 || cnt > 32) continue;
      const fo = fp - DATA_VRAM;
      if (fo + cnt * 4 > gd.length) continue;
      const frames = [];
      for (let j = 0; j < cnt; j++) frames.push(u32(gd, fo + j * 4));
      if (frames.every((t) => 0 < t && t < 0x2000)) for (const f of frames) if (!m.has(f)) m.set(f, frames);
    }
    return m;
  }
  function animGroupMap(groups, animmap) {
    const out = new Map();
    for (const g of groups.values()) {
      const ti = g.ti;
      if (ti < 0 || !TEXKEYREV[ti] || out.has(ti)) continue;
      const [texid, W, H] = TEXKEYREV[ti];
      if (animmap.has(texid)) {
        const frames = [];
        for (const ftid of animmap.get(texid)) { const fi = texIndex(ftid, W, H); if (fi >= 0) frames.push(fi); }
        if (frames.length >= 2) out.set(ti, frames);
      }
    }
    return out;
  }

  // ---------- attachment table (D_80086CC4) ----------
  const propanim = [], propSeen = new Set();
  function buildAttachments() {
    const gd = rom.gameData(), TABLE = 0x80086CC4 - DATA_VRAM, out = [], cache = new Map();
    for (let i = 0; i < 256; i++) {
      const e = TABLE + i * 8;
      if (e + 8 > gd.length) break;
      const ptr = u32(gd, e), cw = u32(gd, e + 4), count = cw >>> 24;
      if (!(0x80090000 <= ptr && ptr < 0x800A2000) || count < 1 || count > 16) break;
      const parts = [];
      for (let r = 0; r < count; r++) {
        const b = ptr - DATA_VRAM + r * 0x10;
        if (b + 0x10 > gd.length) continue;
        const model = gd[b], bone = gd[b + 1], off = [s16(gd, b + 8), s16(gd, b + 0xA), s16(gd, b + 0xC)];
        // type 2 = articulated prop: assets09[model] posed by its own clip pack assets0A[byte 6]
        if (gd[b + 3] === 2 && !propSeen.has(model)) {
          propSeen.add(model);
          let pp = null;
          try { pp = buildPropPosable(model); } catch (err) { pp = null; }
          if (pp) propanim.push({ objId: model, bone, packId: gd[b + 6], bones: pp.bones, groups: pp.groups, ntri: pp.ntri });
        }
        if (i >= 120) continue;   // the attach-any-part list stays the first 120 objects
        if (!cache.has(model)) {
          let g = null;
          try { [g] = buildA01Object(model); } catch (err) { g = null; }
          const it = g && g.size ? packItem(`attach·a01·${model}`, `assets01 model ${model}`, "attach", g, null, true) : null;
          cache.set(model, it ? it.groups : null);
        }
        const grps = cache.get(model);
        if (!grps) continue;
        parts.push({ model, bone, off, g: grps });
      }
      if (parts.length && i < 120) out.push({ oid: i + 1, parts });
    }
    return out;
  }

  // ---------- main ----------
  const animmap = loadAnimmap();
  const posable = [], objects = [], levels = [];
  progress("Characters", 0);
  // every assets01 model with a skeleton and real geometry is posable (single-bone ones are rigid props)
  for (let id = 0; id < 187; id++) {
    let pm = null;
    try { pm = buildA01Posable(id); } catch (e) { pm = null; }
    if (pm && pm.bones.length >= 1) { pm.name = `model ${String(id).padStart(3, "0")}`; posable.push(pm); }
    if (id % 8 === 0) progress("Characters", id / 187);
  }
  const objfiles = [...rom.subfiles(0x03).map(([n, b]) => ["03", n, b]), ...rom.subfiles(0x09).map(([n, b]) => ["09", n, b])];
  objfiles.forEach(([tag, base, blob], k) => {
    if (k % 16 === 0) progress("Objects", k / objfiles.length);
    let g = null;
    try { [g] = buildObject(blob); } catch (e) { g = null; }
    if (!g || !g.size) return;
    const item = packItem(`a${tag}·${base}`, `assets${tag} · ${base}`, "object", g, null, true);
    if (!item || item.ntri < 8) return;   // keep every real object; coherence only orders the list
    delete item._soup;
    objects.push(item);
  });
  const top = parseDir(rom.group(0x04));
  const lvlcand = [];
  for (let sub = 0; sub < top.length; sub++) {
    progress("Levels", sub / top.length);
    let lv = null;
    try { lv = buildLevel(sub, animmap); } catch (e) { lv = null; }
    if (!lv) continue;
    const g = lv.groups, am = animGroupMap(g, animmap);
    let item = packItem(`sub${sub}`, `assets04 chunk ${sub}`, "level", g, am);
    const total = (item ? item.ntri : 0) + lv.proptris;
    if (!item && total >= 300) item = { name: `sub${sub}`, src: "", kind: "level", groups: [], ntri: 0, _soup: 0, _coh: 1.0 };
    if (item && total >= 300) {
      delete item._soup; delete item._coh; item._sub = sub;
      item.partpool = lv.partpool; item.props = lv.props; item.ntri = total;
      lvlcand.push(item);
    }
  }
  lvlcand.sort((a, b) => a._sub - b._sub);
  lvlcand.forEach((m, i) => {
    m.name = `Level ${String(i + 1).padStart(2, "0")}`;
    m.src = `assets04 chunk ${String(m._sub).padStart(2, "0")} · ${m.ntri.toLocaleString("en-US")} tris`;
    delete m._sub; levels.push(m);
  });
  const sortkey = (m) => [m._coh >= 0.70 ? 0 : 1, -m.ntri];
  objects.sort((a, b) => cmpTuple(sortkey(a), sortkey(b)));
  for (const m of objects) delete m._coh;
  posable.sort((a, b) => b.ntri - a.ntri);
  progress("Attachments", 0);
  let attachments = [];
  try { attachments = buildAttachments(); } catch (e) { attachments = []; }
  // named texture-animation sets for the texture browser (curated in hints; frames decoded from the ROM)
  const animsets = ((hints && hints.animsets) || []).map((a) => ({ name: a.name, hold: a.hold, frames: a.frames.map((t) => texIndex(...t)).filter((i) => i >= 0) }))
    .filter((a) => a.frames.length > 1);
  const texmeta = TEXMETA.map((m) => [m[0], m[3], m[4], m[5], m[6]]);   // after attachments: they add textures too
  return { textures: TEX, texmeta, texmetaFull: TEXMETA, characters: [], objects, levels, posable, attachments, propanim, animsets, txfail: TXFAIL };
}
