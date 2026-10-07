// ROM access for Conker's Bad Fur Day (US). Mirrors rom.py.
import { inflateRaw, runzip } from "./inflate.js";

export const US_SHA1 = "4cbadd3c4e0729dec46af64ad018050eada4f47a";
const ASSETS_TABLE = 0xAB1950;
const TEXPOOL = 0x1A37E0;
const DATA_ROM = 0x42450 + 0x145ED8;
export const DATA_VRAM = 0x80082B20;
const POOL_STRIDES = 0x80091D20;
const POOL_COUNT = 7762;

// ---- bounds-checked big-endian readers (throw where Python's struct.unpack would) ----
const F32 = new DataView(new ArrayBuffer(4));
export function u8(d, o) {
  if (o < 0 || o >= d.length) throw new RangeError("u8 out of range");
  return d[o];
}
export function u16(d, o) {
  if (o < 0 || o + 2 > d.length) throw new RangeError("u16 out of range");
  return (d[o] << 8) | d[o + 1];
}
export function u32(d, o) {
  if (o < 0 || o + 4 > d.length) throw new RangeError("u32 out of range");
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}
export function s16(d, o) {
  const v = u16(d, o);
  return v & 0x8000 ? v - 0x10000 : v;
}
export function f32(d, o) {
  F32.setUint32(0, u32(d, o));
  return F32.getFloat32(0);
}

/** .z64 / .v64 / .n64 -> big-endian .z64 order (copies). Throws if it isn't an N64 ROM. */
export function normalizeRom(src) {
  const b = new Uint8Array(src);
  const m = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0;
  if (m === 0x80371240) return b;
  if (m === 0x37804012) {
    for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    return b;
  }
  if (m === 0x40123780) {
    for (let i = 0; i + 3 < b.length; i += 4) {
      let t = b[i]; b[i] = b[i + 3]; b[i + 3] = t;
      t = b[i + 1]; b[i + 1] = b[i + 2]; b[i + 2] = t;
    }
    return b;
  }
  throw new Error("This file isn't an N64 ROM.");
}

export async function sha1Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class Rom {
  constructor(bytes) {
    this.b = bytes;
    this._gd = null;
    this._pool = null;
    this._assets = new Map();
  }

  groupBase(idx) { return ASSETS_TABLE + u32(this.b, ASSETS_TABLE + idx * 8); }

  /** raw ROM slice of asset group idx (== decomp assets/rzip/assetsNN/assetsNN.bin) */
  group(idx) {
    const off = u32(this.b, ASSETS_TABLE + idx * 8), len = u32(this.b, ASSETS_TABLE + idx * 8 + 4);
    return this.b.subarray(ASSETS_TABLE + off, ASSETS_TABLE + off + len);
  }

  /** decompressed files of a group, named like splat's rzip split (0000, 0001, ...) */
  subfiles(idx) {
    const g = this.group(idx), gabs = this.groupBase(idx), out = [];
    let previous = 0, n = 0, k = 0;
    while (8 + k * 8 <= g.length) {
      const start = u32(g, k * 8) | 0, comp = u32(g, k * 8 + 4) | 0; k++;
      const typ = comp >> 24, length = ((comp % 0x10000000) + 0x10000000) % 0x10000000;
      if (start >= g.length || length > this.b.length || start < previous) break;
      if (length === 0) continue;
      previous = start;
      const end = start + length, pad = (8 - ((gabs + end) % 8)) % 8;
      const raw = g.subarray(start, end + pad);
      let res;
      if (typ & 16) {
        try { res = inflateRaw(raw.subarray(4)); } catch (e) { res = null; }
      } else res = pad ? raw.subarray(0, raw.length - pad) : raw;
      if (res && res.length) out.push([String(n).padStart(4, "0"), res]);
      n++;
    }
    return out;
  }

  /** the game's decompressed .data section (VRAM 0x80082B20) */
  gameData() {
    if (!this._gd) this._gd = inflateRaw(this.b.subarray(DATA_ROM + 4, DATA_ROM + 4 + 0x40000), 0, u32(this.b, DATA_ROM));
    return this._gd;
  }

  /** decompressed texture-pool entry; texid == pool index (layout from the D_80091D20 stride table) */
  asset(texid) {
    if (this._assets.has(texid)) return this._assets.get(texid);
    if (!this._pool) {
      const gd = this.gameData(), t = POOL_STRIDES - DATA_VRAM;
      this._pool = new Array(POOL_COUNT);
      let a = TEXPOOL;
      for (let i = 0; i < POOL_COUNT; i++) { const s = u16(gd, t + 2 * i); this._pool[i] = [a, s]; a += s; }
    }
    let r = null;
    if (texid >= 0 && texid < this._pool.length && this._pool[texid][1]) {
      const [a, s] = this._pool[texid];
      r = runzip(this.b.subarray(a, a + s));
    }
    this._assets.set(texid, r);
    return r;
  }
}
