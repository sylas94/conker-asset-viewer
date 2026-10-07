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

`web/js/extract/` is the source of truth. It's checked against the July 31 desktop build (`conker_viewer.html`), the best-looking output the old pipeline ever produced. The code that made that build no longer exists, but its data does:

```
# jul31.json = the "geometry" JSON embedded in the July-31 conker_viewer.html (keep it out of git)
node tools/diff_jul31.mjs <rom> jul31.json [posable|objects|levels|attachments]
```

The diff prints, item by item, which groups differ (texture, size, triangle count, flags). Some differences are deliberate: where the July 31 build decoded a texture at a size the game's own load commands contradict, the extractor follows the game.

A few things can't be read off the display lists, such as which texture a character's runtime-bound eye or face segment shows, or its blink and frown frames. `tools/gen_hints.mjs <rom> jul31.json` derives them from the July 31 build into `web/data/hints.json`. That file holds texture IDs and flags only; every pixel and vertex still comes from the visitor's ROM.

The Python scripts (`build_textured.py` and friends, with ROM access in `rom.py`) are the original July 24 pipeline, kept for reference. `node tools/compare_js.mjs <rom> textured.json` compared the first JS port against them, but the extractor has moved on since then.

## Not in the extractor yet

The July 31 build also had audio (VADPCM samples), scrolling materials, Conker's shirt variants, prop animations and a handful of extra props. The viewer already supports them and turns them on as soon as the data is present.

`web/data/animtable.json` holds the move names and animation-ID map used by the playable-Conker mode. It's a small hand-labelled table copied from that build and contains no art or audio.

## Never commit

ROM files, `textured.json`, `texmeta.json`, or any built `conker_viewer.html`. They contain the game's assets. `.gitignore` covers them.
