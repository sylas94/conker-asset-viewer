// N64 texture decoders. Port of tex_decode.py (same output, byte for byte).
import { pyRound } from "./py.js";

function rgba16px(v) {
  const r = (v >> 11) & 0x1F, g = (v >> 6) & 0x1F, b = (v >> 1) & 0x1F, a = v & 1;
  return [Math.floor(r * 255 / 31), Math.floor(g * 255 / 31), Math.floor(b * 255 / 31), a ? 255 : 0];
}

// Python `a[i:j] = x` on a list (length may change)
function sliceAssign(a, i, j, x) {
  const L = a.length;
  i = Math.min(Math.max(i, 0), L); j = Math.min(Math.max(j, 0), L);
  if (j < i) j = i;
  a.splice(i, j - i, ...x);
}

// N64 LoadBlock: odd rows have their two 32-bit halves swapped within each 64-bit word
function deswizzle(data, w, h, bpp) {
  const rowbytes = pyRound(w * bpp);
  if (data.length >= rowbytes * h) {
    const out = new Uint8Array(rowbytes * h);
    for (let y = 0; y < h; y++) {
      const s = y * rowbytes;
      out.set(data.subarray(s, s + rowbytes), s);
      if (y % 2 === 1) {
        for (let b = 0; b + 8 <= rowbytes; b += 8) {
          for (let k = 0; k < 4; k++) { out[s + b + k] = data[s + b + 4 + k]; out[s + b + 4 + k] = data[s + b + k]; }
        }
      }
    }
    return out;
  }
  // short asset: reproduce Python's length-changing slice assignments exactly
  const out = new Array(rowbytes * h).fill(0);
  for (let y = 0; y < h; y++) {
    const s = y * rowbytes, row = Array.from(data.subarray(s, s + rowbytes));
    if (y % 2 === 1) {
      for (let b = 0; b < rowbytes; b += 8) {
        if (b + 8 <= rowbytes) {
          const X = Array.from(data.subarray(s + b + 4, s + b + 8)), Y = Array.from(data.subarray(s + b, s + b + 4));
          sliceAssign(row, b, b + 4, X);
          sliceAssign(row, b + 4, b + 8, Y);
        }
      }
    }
    sliceAssign(out, s, s + rowbytes, row);
  }
  return Uint8Array.from(out);
}

function guardOpaque(out, n) {
  let trans = 0;
  for (let i = 0; i < n; i++) if (out[i * 4 + 3] < 128) trans++;
  if (trans > n * 0.90) for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return out;
}

function decRgba16(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, w * h * 2), w, h, 2), out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (i * 2 + 2 > d.length) break;
    const p = rgba16px((d[i * 2] << 8) | d[i * 2 + 1]);
    out[i * 4] = p[0]; out[i * 4 + 1] = p[1]; out[i * 4 + 2] = p[2]; out[i * 4 + 3] = p[3];
  }
  return guardOpaque(out, n);
}
function decRgba32(data, w, h) {
  const n = w * h, d = data.subarray(0, n * 4), out = new Uint8Array(n * 4);
  out.set(d.subarray(0, Math.min(n, Math.floor(d.length / 4)) * 4));
  return out;
}
function palette(tlut, count) {
  const pal = [];
  for (let i = 0; i < count; i++) pal.push(i * 2 + 2 <= tlut.length ? rgba16px((tlut[i * 2] << 8) | tlut[i * 2 + 1]) : [0, 0, 0, 0]);
  return pal;
}
function decCi8(data, w, h) {
  const n = w * h, tlut = data.subarray(Math.max(0, data.length - 512));
  let sw = Math.floor((w + 7) / 8) * 8;
  if (sw * h > data.length - 512) sw = w;
  const idx = deswizzle(data.subarray(0, sw * h), sw, h, 1), pal = palette(tlut, 256), out = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = y * sw + x, oi = (y * w + x) * 4, p = si < idx.length ? pal[idx[si]] : [0, 0, 0, 0];
    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2]; out[oi + 3] = p[3];
  }
  return guardOpaque(out, n);
}
function decCi4(data, w, h) {
  const n = w * h, tlut = data.subarray(Math.max(0, data.length - 32));
  const rb = Math.floor((w + 1) / 2);
  let sb = Math.floor((rb + 7) / 8) * 8, sw = sb * 2;
  if (sb * h > data.length - 32) { sw = w; sb = Math.floor((w + 1) / 2); }
  const idxb = deswizzle(data.subarray(0, sb * h), sw, h, 0.5), pal = palette(tlut, 16), out = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * sw + x, bi = i >> 1;
    if (bi >= idxb.length) continue;
    const b = idxb[bi], p = pal[i % 2 === 0 ? b >> 4 : b & 0xF], oi = (y * w + x) * 4;
    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2]; out[oi + 3] = p[3];
  }
  return guardOpaque(out, n);
}
function decIa16(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, n * 2), w, h, 2), out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (i * 2 + 2 > d.length) break;
    const g = d[i * 2];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = d[i * 2 + 1];
  }
  return out;
}
function decIa8(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, n), w, h, 1), out = new Uint8Array(n * 4);
  for (let i = 0; i < Math.min(n, d.length); i++) {
    const v = d[i], g = (v >> 4) * 17;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = (v & 0xF) * 17;
  }
  return out;
}
function decIa4(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, n >> 1), w, h, 0.5), out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if ((i >> 1) >= d.length) break;
    const b = d[i >> 1], nyb = i % 2 === 0 ? b >> 4 : b & 0xF, I = ((nyb >> 1) & 7) * 36;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = I; out[i * 4 + 3] = nyb & 1 ? 255 : 0;
  }
  return out;
}
function decI8(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, n), w, h, 1), out = new Uint8Array(n * 4);
  for (let i = 0; i < Math.min(n, d.length); i++) {
    const g = d[i];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
  }
  return out;
}
function decI4(data, w, h) {
  const n = w * h, d = deswizzle(data.subarray(0, n >> 1), w, h, 0.5), out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if ((i >> 1) >= d.length) break;
    const b = d[i >> 1], g = (i % 2 === 0 ? b >> 4 : b & 0xF) * 17;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
  }
  return out;
}

/** Decode an N64 texture -> [rgba, fmtName] or [null, null].
 *  CI-ness comes from the SETTIMG flag; non-CI bit depth is picked by asset size (see tex_decode.py). */
export function decodeTexture(data, w, h, fmt = null, siz = null, flag = 0) {
  if (!data || !data.length || w <= 0 || h <= 0) return [null, null];
  const n = w * h, L = data.length;
  try {
    if (flag === 0x400000) return [decCi8(data, w, h), "CI8"];
    if (flag === 0x800000) return [decCi4(data, w, h), "CI4"];
    if (fmt === 2 && siz === 1) return [decCi8(data, w, h), "CI8"];
    if (fmt === 2 && siz === 0) return [decCi4(data, w, h), "CI4"];
    for (const [base, depth] of [[n * 4, 32], [n * 2, 16], [n, 8], [Math.floor(n / 2), 4]]) {
      if (base > 0 && 0.90 * base <= L && L <= 1.55 * base) {
        if (depth === 32) return [decRgba32(data, w, h), "RGBA32"];
        if (depth === 16) return fmt === 3 ? [decIa16(data, w, h), "IA16"] : [decRgba16(data, w, h), "RGBA16"];
        if (depth === 8) return fmt === 3 ? [decIa8(data, w, h), "IA8"] : [decI8(data, w, h), "I8"];
        return fmt === 3 ? [decIa4(data, w, h), "IA4"] : [decI4(data, w, h), "I4"];
      }
    }
    return [decRgba16(data, w, h), "rgba16?"];
  } catch (e) {
    return [null, null];
  }
}
