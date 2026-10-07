// Extract everything the viewer shows from a user-supplied ROM.
import { Rom, normalizeRom, sha1Hex, US_SHA1 } from "./rom.js";
import { buildAll } from "./build.js";
import { attachAnims } from "./anims.js";

export const EXTRACTOR_VERSION = 1;

export class RomError extends Error {}

/** Validate the file and return big-endian ROM bytes. */
export async function checkRom(fileBytes) {
  let rom;
  try { rom = normalizeRom(fileBytes); } catch (e) { throw new RomError("That file isn't an N64 ROM."); }
  const sha = await sha1Hex(rom);
  if (sha !== US_SHA1) {
    throw new RomError("This ROM isn't Conker's Bad Fur Day (US). The viewer needs the unmodified US release (SHA-1 4cbadd3c…f47a).");
  }
  return rom;
}

/** romBytes must already be checked. progress(stage, fraction 0..1); opts = {hints, debug} */
export function extract(romBytes, progress = () => {}, opts = {}) {
  const rom = new Rom(romBytes);
  const data = buildAll(rom, progress, opts);
  if (opts.hints && opts.hints.scroll) applyScroll(data, opts.hints.scroll);
  progress("Animations", 0);
  attachAnims(rom, data, opts.hints);
  progress("Done", 1);
  return data;
}

// scrolling materials (water, lava, conveyor belts...) are animated by per-level game code; hints give the speed
function applyScroll(data, scroll) {
  const tid = (g) => (g.ti >= 0 ? data.texmeta[g.ti][0] : -1);
  const at = (key, g) => { const v = scroll[`${key}:${tid(g)}`]; if (v) g.scroll = v; };
  for (const L of data.levels) {
    const chunk = Number(L.src.match(/chunk (\d+)/)[1]);
    L.groups.forEach((g) => at(`lvl:${chunk}`, g));
    L.partpool.forEach((p) => p.g.forEach((g) => at(`part:${chunk}:${p.ext}:${p.part}`, g)));
  }
  data.objects.forEach((o) => o.groups.forEach((g) => at(`obj:${o.name}`, g)));
  data.posable.forEach((m) => m.groups.forEach((g) => at(`pos:${m.id}`, g)));
}
