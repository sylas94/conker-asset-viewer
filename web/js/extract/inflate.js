// Raw DEFLATE (RFC 1951) decoder, synchronous, so the extractor runs the same in a Worker and in Node.
// Mirrors Python's zlib.decompressobj(wbits=-15).decompress(): corrupt data throws, a stream that
// simply runs out of input returns whatever was decoded so far.

const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLORD = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

class Truncated extends Error {}

// lookup table indexed by the next `bits` input bits (LSB-first): entry = symbol<<4 | codeLength
function buildTable(lens, n) {
  let max = 0;
  for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
  if (max === 0) return { tab: null, bits: 0 };
  const count = new Uint16Array(16), next = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  let code = 0;
  for (let b = 1; b <= max; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const size = 1 << max, tab = new Int32Array(size).fill(-1);
  for (let s = 0; s < n; s++) {
    const L = lens[s];
    if (!L) continue;
    let c = next[L]++, r = 0;
    for (let k = 0; k < L; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    for (let j = r; j < size; j += 1 << L) tab[j] = (s << 4) | L;
  }
  return { tab, bits: max };
}

let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    const d = new Uint8Array(32).fill(5);
    FIXED = [buildTable(l, 288), buildTable(d, 32)];
  }
  return FIXED;
}

export function inflateRaw(src, pos = 0, sizeHint = 0) {
  const n = src.length;
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(4096, (n - pos) * 4)), op = 0;
  let bb = 0, bc = 0, p = pos;

  const need = (k) => {
    while (bc < k) {
      if (p >= n) throw new Truncated();
      bb |= src[p++] << bc; bc += 8;
    }
  };
  const bits = (k) => { need(k); const v = bb & ((1 << k) - 1); bb >>>= k; bc -= k; return v; };
  const sym = (t) => {
    // a short final code may need fewer bits than the table width: pad with zeros if input ends
    while (bc < t.bits) {
      if (p >= n) { if (bc === 0) throw new Truncated(); break; }
      bb |= src[p++] << bc; bc += 8;
    }
    const e = t.tab[bb & ((1 << t.bits) - 1)];
    if (e < 0) throw new Error("inflate: invalid code");
    const L = e & 15;
    if (L > bc) throw new Truncated();
    bb >>>= L; bc -= L;
    return e >> 4;
  };
  const grow = (k) => {
    if (op + k <= out.length) return;
    let m = out.length * 2;
    while (m < op + k) m *= 2;
    const o = new Uint8Array(m); o.set(out.subarray(0, op)); out = o;
  };

  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bb >>>= bc & 7; bc -= bc & 7;
        const len = bits(16), nlen = bits(16);
        if ((len ^ 0xFFFF) !== nlen) throw new Error("inflate: bad stored block");
        grow(len);
        let k = len;
        while (k > 0 && bc >= 8) { out[op++] = bits(8); k--; }
        if (p + k > n) { out.set(src.subarray(p, n), op); op += n - p; p = n; throw new Truncated(); }
        out.set(src.subarray(p, p + k), op); op += k; p += k;
        continue;
      }
      let lt, dt;
      if (type === 1) [lt, dt] = fixedTables();
      else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORD[i]] = bits(3);
        const ct = buildTable(cl, 19);
        if (!ct.tab) throw new Error("inflate: empty code-length code");
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = sym(ct);
          if (s < 16) lens[i++] = s;
          else {
            let rep, val = 0;
            if (s === 16) { if (i === 0) throw new Error("inflate: repeat with no previous"); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (s === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > hlit + hdist) throw new Error("inflate: too many lengths");
            while (rep--) lens[i++] = val;
          }
        }
        lt = buildTable(lens.subarray(0, hlit), hlit);
        dt = buildTable(lens.subarray(hlit), hdist);
        if (!lt.tab) throw new Error("inflate: empty literal code");
      } else throw new Error("inflate: bad block type");

      for (;;) {
        const s = sym(lt);
        if (s < 256) { if (op >= out.length) grow(1); out[op++] = s; continue; }
        if (s === 256) break;
        const li = s - 257;
        if (li >= 29) throw new Error("inflate: bad length symbol");
        const len = LBASE[li] + bits(LEXT[li]);
        if (!dt.tab) throw new Error("inflate: no distance code");
        const ds = sym(dt);
        if (ds >= 30) throw new Error("inflate: bad distance symbol");
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > op) throw new Error("inflate: distance too far back");
        grow(len);
        let from = op - dist;
        for (let k = 0; k < len; k++) out[op++] = out[from++];
      }
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  return op === out.length ? out : out.slice(0, op);
}

// Rare's "rzip": u32 big-endian uncompressed length, then a raw deflate stream.
// Returns null on corrupt data (like model_final.runzip); a truncated stream gives partial output.
export function runzip(d) {
  try {
    const hint = d.length >= 4 ? ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0 : 0;
    return inflateRaw(d.length >= 4 ? d.subarray(4) : new Uint8Array(0), 0, hint > 0 && hint < 0x1000000 ? hint : 0);
  } catch (e) {
    return null;
  }
}
