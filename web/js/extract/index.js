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

/** romBytes must already be checked. progress(stage, fraction 0..1) */
export function extract(romBytes, progress = () => {}) {
  const rom = new Rom(romBytes);
  const data = buildAll(rom, progress);
  progress("Animations", 0);
  attachAnims(rom, data);
  progress("Done", 1);
  return data;
}
