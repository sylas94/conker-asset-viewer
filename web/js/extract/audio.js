// Sound effects, voices and instrument samples: N64 VADPCM in the audio bank (assets group 0x17).
// Entry 0 = the ctl bank ('B1', base sample rate), entry 2 = the tbl sample data. Conker's ctl uses Rare's packed
// sound records, so the sample index (tbl offset, length, codebook) and codebook locations come from hints.json;
// the audio bytes and codebook coefficients themselves are read from the visitor's ROM.
import { u32, u16 } from "./rom.js";
import { parseDir } from "./build.js";
import { runzip } from "./inflate.js";

export function extractAudio(rom, hint) {
  if (!hint) return null;
  const g = rom.group(0x17), pd = parseDir(g);
  if (!pd || pd.length < 3) return null;
  const [co, cs, cc] = pd[0];
  const ctl = cc ? runzip(g.subarray(co, co + cs)) : g.subarray(co, co + cs);
  const rate = ctl && ctl.length >= 0x10 && u16(ctl, 0) === 0x4231 ? u32(ctl, 0xC) : 22050;
  const [to, ts] = pd[2];
  const tbl = g.slice(to, to + ts);                       // own copy: transferred to the page on its own
  const s32 = (o) => u32(g, o) | 0;
  const books = hint.books.map((off) => {
    const order = s32(off), npred = s32(off + 4), n = order * npred * 8, coefs = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = u16(g, off + 8 + i * 2); coefs[i] = v & 0x8000 ? v - 0x10000 : v; }
    return [order, npred, coefs];
  });
  const samples = hint.samples.map(([o, l, b, r], i) => ({
    r, o, l, b, s: Math.round(Math.floor(l / 9) * 16 / rate * 1000) / 1000, name: "sample_" + String(i).padStart(4, "0"),
  })).filter((s) => s.o + s.l <= tbl.length && s.b < books.length);
  return { rate, books, blob: tbl, samples };
}
