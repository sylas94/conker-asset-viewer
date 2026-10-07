// Runs the extractor off the main thread. In: {rom: ArrayBuffer (already checked)}. Out: progress + data.
import { extract } from "./extract/index.js";

self.onmessage = (e) => {
  try {
    const data = extract(new Uint8Array(e.data.rom), (stage, frac) => self.postMessage({ type: "progress", stage, frac }));
    delete data.texmetaFull;
    delete data.txfail;
    // hand every typed array's buffer over instead of copying ~100 MB
    const buffers = new Set();
    const walk = (v) => {
      if (ArrayBuffer.isView(v)) { buffers.add(v.buffer); return; }
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === "object") walk(x); return; }
      if (v && typeof v === "object") for (const k in v) { const x = v[k]; if (x && typeof x === "object") walk(x); }
    };
    walk(data);
    self.postMessage({ type: "done", data }, [...buffers]);
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
