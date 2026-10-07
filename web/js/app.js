// Entry point: get a ROM from the visitor, extract it in a worker, then boot the viewer.
// The ROM never leaves the browser; with consent it's kept in IndexedDB so the next visit skips the upload.
import { checkRom, RomError, EXTRACTOR_VERSION } from "./extract/index.js";

const $ = (s) => document.querySelector(s);
const gate = $("#gate"), drop = $("#drop"), fileIn = $("#romfile"), err = $("#gateErr");
const prog = $("#gateProg"), progBar = $("#gateBar"), progLbl = $("#gateStage");

// ---------- IndexedDB: one record holding the ROM bytes ----------
const DB = "conker-explorer", STORE = "rom";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); res(req && req.result); };
    tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
  });
}
const loadSaved = () => idbOp("readonly", (s) => s.get("rom")).catch(() => null);
const saveRom = (bytes) => idbOp("readwrite", (s) => s.put(bytes, "rom")).catch(() => {});
const forgetRom = () => idbOp("readwrite", (s) => s.delete("rom")).catch(() => {});

// ---------- UI ----------
const STAGES = { Characters: [0, 0.22], Objects: [0.22, 0.4], Levels: [0.4, 0.86], Attachments: [0.86, 0.9], Animations: [0.9, 0.97], Audio: [0.97, 1], Done: [1, 1] };
function setBusy(on, label = "") {
  gate.classList.toggle("busy", on);
  prog.hidden = !on;
  if (on) { progLbl.textContent = label; progBar.style.width = "0%"; }
}
function setProgress(stage, frac) {
  const [a, b] = STAGES[stage] || [0, 1];
  progBar.style.width = (100 * (a + (b - a) * frac)).toFixed(1) + "%";
  progLbl.textContent = stage === "Done" ? "Opening the explorer…" : `Extracting ${stage.toLowerCase()}…`;
}
function showError(msg) {
  setBusy(false);
  err.textContent = msg;
  err.hidden = !msg;
}

async function start(fileBytes, { remember, fromCache }) {
  showError("");
  setBusy(true, fromCache ? "Loading your saved ROM…" : "Checking ROM…");
  let rom;
  try {
    rom = await checkRom(fileBytes);
  } catch (e) {
    if (fromCache) { await forgetRom(); return showError("The saved ROM couldn't be read, so it was removed. Choose your ROM file again."); }
    return showError(e instanceof RomError ? e.message : "Couldn't read that file.");
  }
  if (remember && !fromCache) await saveRom(rom);
  const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const animtab = getJSON("data/animtable.json"), hints = getJSON("data/hints.json");
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const t0 = performance.now();
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "progress") return setProgress(m.stage, m.frac);
    worker.terminate();
    if (m.type === "error") {
      console.error(m.message);
      return showError("Extraction failed. Try reloading the page; if it keeps happening, the ROM may be damaged.");
    }
    console.info(`extracted in ${((performance.now() - t0) / 1000).toFixed(1)} s (extractor v${EXTRACTOR_VERSION})`);
    window.CONKER_AUDIO = m.data.audio || null;
    delete m.data.audio;
    window.CONKER_DATA = m.data;
    window.CONKER_ANIMTAB = await animtab;
    bootViewer();
  };
  worker.onerror = (e) => { worker.terminate(); console.error(e); showError("Your browser couldn't run the extractor. Use a current version of Chrome, Edge, Firefox or Safari."); };
  const copy = rom.slice().buffer;
  worker.postMessage({ rom: copy, hints: await hints }, [copy]);
}

function bootViewer() {
  document.body.classList.add("ready");
  gate.remove();
  const s = document.createElement("script");
  s.src = "js/viewer.js";
  document.body.appendChild(s);
}

async function readFile(f) {
  if (!f) return;
  if (/\.(zip|7z|rar)$/i.test(f.name)) return showError("Extract the ROM from the archive first, then choose the .z64, .n64 or .v64 file.");
  if (f.size < 32 * 1024 * 1024 || f.size > 128 * 1024 * 1024) return showError("That doesn't look like the Conker ROM. It should be a 64 MB .z64, .n64 or .v64 file.");
  start(new Uint8Array(await f.arrayBuffer()), { remember: $("#remember").checked });
}

fileIn.addEventListener("change", () => readFile(fileIn.files[0]));
drop.addEventListener("click", () => { if (!gate.classList.contains("busy")) fileIn.click(); });
drop.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !gate.classList.contains("busy")) { e.preventDefault(); fileIn.click(); } });
for (const ev of ["dragenter", "dragover"]) gate.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) gate.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
gate.addEventListener("drop", (e) => { if (!gate.classList.contains("busy")) readFile(e.dataTransfer.files[0]); });

$("#romForget").addEventListener("click", async () => { await forgetRom(); location.reload(); });

if (!window.isSecureContext || !crypto.subtle) {
  showError("Open this page over https (or http://localhost). Browsers only allow the ROM check on secure pages.");
} else {
  const saved = await loadSaved();
  if (saved) start(saved, { remember: true, fromCache: true });
}
