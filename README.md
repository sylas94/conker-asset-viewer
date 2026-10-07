# Conker Asset Explorer

A website for browsing the levels, characters, animations, props and textures of *Conker's Bad Fur Day* (N64, US). The site ships no game data. Visitors choose their own ROM, and the page extracts everything in their browser. The ROM is never uploaded.

## How it works

1. `web/js/app.js` reads the file, converts `.v64` / `.n64` byte order to `.z64`, and checks the SHA-1 against the US release (`4cbadd3c…f47a`).
2. A module worker (`web/js/worker.js`) runs the extractor in `web/js/extract/`. It takes about 2–4 s and reports progress.
3. The decoded data, as typed arrays and raw RGBA textures, is passed to the viewer (`web/js/viewer.js`), which renders it with WebGL.
4. If the visitor agrees, the ROM is saved in IndexedDB so the next visit skips the upload. **Change ROM** in the header deletes it.

The extractor reads only from the ROM:

| Data | Where in the ROM |
|---|---|
| Asset groups 00–1F | root table at `0xAB1950` (`{offset, length}` per group) |
| Texture pool | rzip files from `0x1A37E0`, positioned by the u16 stride table `D_80091D20` in `.data` (texid = pool index) |
| Game `.data` section | rzip at `0x42450 + 0x145ED8` (VRAM `0x80082B20`) |

"rzip" is a big-endian u32 uncompressed length followed by a raw deflate stream.

## Run locally

```
node tools/serve.mjs        # http://localhost:8080/
```

The page has to be served over http(s). Module workers and `crypto.subtle` don't work from `file://`.

## Deploy

`web/` is a static site. Upload it to any static host, such as GitHub Pages, Netlify or Cloudflare Pages. It needs no build step and no server code.

## Verifying the extractor

The Python scripts (`build_textured.py`, `attach_anims.py` and friends, with ROM access in `rom.py`) are the reference implementation. The JavaScript port must produce identical output:

```
set CONKER_ROM=path\to\conker.z64
python build_textured.py && python attach_anims.py          # writes textured.json (keep it out of git)
node tools/compare_js.mjs %CONKER_ROM% textured.json         # "IDENTICAL to the Python reference"
```

Run that comparison after any change to either side. `SANITY=1` plants deliberate differences to prove the comparison catches them.

## Not in the extractor yet

The July 31 desktop build (`conker_viewer.html`) also had audio (VADPCM samples), vertex normals, texture-gen and scrolling materials, eye blinks, prop animations, and more objects and characters. The code that produced that data no longer exists. Those features need to be rebuilt in the extractor, using that build as the reference output. The viewer already supports them and lights them up once the data is present.

`web/data/animtable.json` (move names and the animation-ID map used by the playable-Conker mode) is a small hand-labelled table copied from that build. It contains no art or audio.

## Never commit

ROM files, `textured.json`, `texmeta.json`, or any built `conker_viewer.html`. They contain the game's assets. `.gitignore` covers them.
