"use strict";
// Downloads: characters / objects / levels as glTF 2.0 binary (.glb) with embedded textures, characters with
// their skeleton, skin and every animation clip; textures as PNG at their real size. Everything is built in the
// browser from the data already extracted from the visitor's ROM. Positions are exported in metres
// (N64 units x 0.01, so Conker stands ~1.6 m tall), Y up.
(function () {
  const SCALE = 0.01;

  // ---------------- PNG ----------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zlibDeflate(u8) {
    const cs = new CompressionStream("deflate"), w = cs.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function encodePNG(rgba, w, h) {
    const row = w * 4 + 1, raw = new Uint8Array(h * row);
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * row + 1);   // filter 0 per row
    const idat = await zlibDeflate(raw);
    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
      return out;
    };
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // textures are stored power-of-two (nearest-neighbour stretched); recover the real W x H texels exactly
  function nativePixels(t) {
    if (t.pw === t.w && t.ph === t.h) return t.px;
    const out = new Uint8Array(t.w * t.h * 4);
    for (let y = 0; y < t.h; y++) {
      const sy = Math.min(t.ph - 1, Math.ceil(y * t.ph / t.h));
      for (let x = 0; x < t.w; x++) {
        const sx = Math.min(t.pw - 1, Math.ceil(x * t.pw / t.w)), si = (sy * t.pw + sx) * 4, di = (y * t.w + x) * 4;
        out[di] = t.px[si]; out[di + 1] = t.px[si + 1]; out[di + 2] = t.px[si + 2]; out[di + 3] = t.px[si + 3];
      }
    }
    return out;
  }
  async function texturePNG(DATA, ti) { const t = DATA.textures[ti]; return encodePNG(nativePixels(t), t.w, t.h); }

  // ---------------- maths (same conventions as the viewer) ----------------
  function bamToQuat(ax, ay, az) {           // clip BAM angles -> [x,y,z,w] (game order Q = qz*qy*qx)
    const hx = ((ax & 0xFFFF) / 65536) * Math.PI, hy = ((ay & 0xFFFF) / 65536) * Math.PI, hz = ((az & 0xFFFF) / 65536) * Math.PI;
    const cx = Math.cos(hx), sx = Math.sin(hx), cy = Math.cos(hy), sy = Math.sin(hy), cz = Math.cos(hz), sz = Math.sin(hz);
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
  }
  function rotMat3(ax, ay, az) {             // placement rotation, degrees, row-vector convention
    ax *= Math.PI / 180; ay *= Math.PI / 180; az *= Math.PI / 180;
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    return [[cy * cz, cy * sz, -sy], [sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy], [cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy]];
  }
  function smoothNormals(pos, idx) {
    const n = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
      if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else n[i + 1] = 1;
    }
    return n;
  }
  const arr = (v, T) => (typeof v === "string" ? (() => { const s = atob(v), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new T(u.buffer); })() : v);

  // ---------------- GLB writer ----------------
  class Glb {
    constructor(DATA, name) {
      this.DATA = DATA;
      this.json = { asset: { version: "2.0", generator: "Conker Asset Explorer (extracted from the user's own ROM)" },
        scene: 0, scenes: [{ name, nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [],
        accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], skins: [], animations: [] };
      this.chunks = []; this.len = 0;
      this.texCache = new Map(); this.matCache = new Map(); this.sampCache = new Map(); this.pending = [];
    }
    view(bytes, target) {
      const pad = (4 - (this.len % 4)) % 4;
      if (pad) { this.chunks.push(new Uint8Array(pad)); this.len += pad; }
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.chunks.push(u8);
      const v = { buffer: 0, byteOffset: this.len, byteLength: u8.length };
      if (target) v.target = target;
      this.len += u8.length;
      return this.json.bufferViews.push(v) - 1;
    }
    accessor(data, type, ctype, { target, normalized, minmax } = {}) {
      const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
      const a = { bufferView: this.view(data, target), componentType: ctype, count: data.length / comps, type };
      if (normalized) a.normalized = true;
      if (minmax) {
        const mn = new Array(comps).fill(Infinity), mx = new Array(comps).fill(-Infinity);
        for (let i = 0; i < data.length; i++) { const c = i % comps; if (data[i] < mn[c]) mn[c] = data[i]; if (data[i] > mx[c]) mx[c] = data[i]; }
        a.min = mn; a.max = mx;
      }
      return this.json.accessors.push(a) - 1;
    }
    sampler(ws, wt) {
      const k = ws + "," + wt;
      if (!this.sampCache.has(k)) {
        const w = (x) => (x === 2 ? 33071 : x === 1 ? 33648 : 10497);   // clamp / mirror / repeat
        this.sampCache.set(k, this.json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: w(ws), wrapT: w(wt) }) - 1);
      }
      return this.sampCache.get(k);
    }
    image(ti) {
      if (!this.texCache.has(ti)) {
        const img = { mimeType: "image/png", name: "tex_0x" + ((this.DATA.texmeta[ti] || [0])[0]).toString(16) };
        const ii = this.json.images.push(img) - 1;
        this.texCache.set(ti, ii);
        this.pending.push(texturePNG(this.DATA, ti).then((png) => { img.bufferView = this.view(png); }));
      }
      return this.texCache.get(ti);
    }
    // one material per distinct look: texture + wrap + alpha mode + tint
    material(g) {
      const ti = g.ti >= 0 && this.DATA.textures[g.ti] ? g.ti : -1;
      const mode = g.bl || g.vat ? "BLEND" : g.al ? "MASK" : "OPAQUE";
      const tint = g.tint ? g.tint.map((c) => c / 255) : [1, 1, 1];
      const k = [ti, g.ws || 0, g.wt || 0, mode, tint.join(",")].join("|");
      if (!this.matCache.has(k)) {
        const m = { name: ti >= 0 ? "tex_0x" + this.DATA.texmeta[ti][0].toString(16) : "vertex_colour", doubleSided: true, alphaMode: mode,
          pbrMetallicRoughness: { baseColorFactor: [...tint, 1], metallicFactor: 0, roughnessFactor: 1 } };
        if (mode === "MASK") m.alphaCutoff = 0.5;
        if (ti >= 0) m.pbrMetallicRoughness.baseColorTexture = { index: this.json.textures.push({ sampler: this.sampler(g.ws || 0, g.wt || 0), source: this.image(ti) }) - 1 };
        this.matCache.set(k, this.json.materials.push(m) - 1);
      }
      return this.matCache.get(k);
    }
    // a primitive from one viewer group; posF = Float32 positions already in metres
    primitive(g, posF, extra = {}) {
      const idx = arr(g.idx, Uint16Array), uv = arr(g.uv, Int16Array), col = arr(g.col, Uint8Array), va = g.va ? arr(g.va, Uint8Array) : null;
      const n = posF.length / 3, uvF = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) uvF[i] = uv[i] / 512;
      const attrs = {
        POSITION: this.accessor(posF, "VEC3", 5126, { target: 34962, minmax: true }),
        NORMAL: this.accessor(smoothNormals(posF, idx), "VEC3", 5126, { target: 34962 }),
        TEXCOORD_0: this.accessor(uvF, "VEC2", 5126, { target: 34962 }),
      };
      // vertex colour carries the baked N64 shading: used when the texture is modulated by it, or when untextured
      if (g.mod || g.ti < 0 || g.vat) {
        const c = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) {
          const white = !(g.mod || g.ti < 0);
          c[i * 4] = white ? 255 : col[i * 3]; c[i * 4 + 1] = white ? 255 : col[i * 3 + 1]; c[i * 4 + 2] = white ? 255 : col[i * 3 + 2];
          c[i * 4 + 3] = va ? va[i] : 255;
        }
        attrs.COLOR_0 = this.accessor(c, "VEC4", 5121, { target: 34962, normalized: true });
      }
      Object.assign(attrs, extra);
      const idx32 = new Uint16Array(idx);   // own copy so the bufferView is tightly packed
      return { attributes: attrs, indices: this.accessor(idx32, "SCALAR", 5123, { target: 34963 }), material: this.material(g), mode: 4 };
    }
    node(n) { return this.json.nodes.push(n) - 1; }
    async finish() {
      await Promise.all(this.pending);
      const j = this.json;
      for (const k of Object.keys(j)) if (Array.isArray(j[k]) && !j[k].length && k !== "nodes" && k !== "scenes") delete j[k];
      const pad4 = (n) => (n + 3) & ~3;
      const binLen = pad4(this.len);
      j.buffers = [{ byteLength: binLen }];
      const jsonBytes = new TextEncoder().encode(JSON.stringify(j)), jsonLen = pad4(jsonBytes.length);
      const total = 12 + 8 + jsonLen + 8 + binLen, out = new Uint8Array(total), dv = new DataView(out.buffer);
      dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
      dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4E4F534A, true);
      out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
      let o = 20 + jsonLen;
      dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004E4942, true); o += 8;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return out;
    }
  }

  // ---------------- characters: skeleton + skin + every clip ----------------
  function clipName(m, c, i, ANIMTAB) {
    if (ANIMTAB && m.id >= 0 && m.id <= 4 && c.aid != null) {
      const mv = ANIMTAB.moves.find((x) => x[1] === c.aid);
      if (mv) return mv[0];
    }
    return "clip_" + String(i + 1).padStart(3, "0") + (c.aid != null ? "_anim" + c.aid : "");
  }
  async function exportCharacter(DATA, m, { ANIMTAB = null, variant = 0 } = {}) {
    const glb = new Glb(DATA, m.name);
    const bones = m.bones.map((b) => ({ par: b[0], slot: b[1], rot: b[2], rest: [b[3], b[4], b[5]] }));
    const slot2idx = new Map(bones.map((b, i) => [b.slot, i]));
    // bind pose = rest offsets accumulated down the hierarchy (no rotation)
    const world = new Array(bones.length).fill(null);
    const wpos = (i, d = 0) => {
      if (world[i]) return world[i];
      const b = bones[i], pj = slot2idx.get(b.par);
      world[i] = b.par === 0xFF || pj === undefined || pj === i || d > bones.length ? b.rest.slice()
        : wpos(pj, d + 1).map((v, a) => v + b.rest[a]);
      return world[i];
    };
    bones.forEach((b, i) => wpos(i));
    const jointNodes = bones.map((b, i) => glb.node({ name: "bone_" + String(i).padStart(2, "0"), translation: b.rest.map((v) => v * SCALE) }));
    const roots = [];
    bones.forEach((b, i) => {
      const pj = slot2idx.get(b.par);
      if (b.par === 0xFF || pj === undefined || pj === i) roots.push(jointNodes[i]);
      else (glb.json.nodes[jointNodes[pj]].children ||= []).push(jointNodes[i]);
    });
    const armature = glb.node({ name: "Armature", children: roots });
    const ibm = new Float32Array(bones.length * 16);
    bones.forEach((b, i) => { const o = i * 16; ibm[o] = ibm[o + 5] = ibm[o + 10] = ibm[o + 15] = 1; ibm[o + 12] = -world[i][0] * SCALE; ibm[o + 13] = -world[i][1] * SCALE; ibm[o + 14] = -world[i][2] * SCALE; });
    const skin = glb.json.skins.push({ name: m.name, joints: jointNodes, skeleton: armature, inverseBindMatrices: glb.accessor(ibm, "MAT4", 5126) }) - 1;

    const prims = [];
    for (const g of m.groups) {
      if (g.variant != null && g.variant !== variant) continue;
      const slot = arr(g.slot, Uint8Array), pos = arr(g.pos, Int16Array), n = slot.length;
      const posF = new Float32Array(n * 3), joints = new Uint8Array(n * 4), weights = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const j = slot2idx.has(slot[i]) ? slot2idx.get(slot[i]) : 0, w = world[j];
        posF[i * 3] = (pos[i * 3] + w[0]) * SCALE; posF[i * 3 + 1] = (pos[i * 3 + 1] + w[1]) * SCALE; posF[i * 3 + 2] = (pos[i * 3 + 2] + w[2]) * SCALE;
        joints[i * 4] = j; weights[i * 4] = 1;
      }
      prims.push(glb.primitive(g, posF, {
        JOINTS_0: glb.accessor(joints, "VEC4", 5121, { target: 34962 }),
        WEIGHTS_0: glb.accessor(weights, "VEC4", 5126, { target: 34962 }),
      }));
    }
    const mesh = glb.json.meshes.push({ name: m.name, primitives: prims }) - 1;
    const meshNode = glb.node({ name: m.name, mesh, skin });
    glb.json.scenes[0].nodes.push(armature, meshNode);

    // animations: keyframe k at k*iv/30 s (30 ticks per second), looping back to frame 0 like the viewer
    const clips = (m.pack != null && DATA.animpacks && DATA.animpacks[String(m.pack)]) || [];
    const aoff = m.aoff || 0;
    const movers = new Set();   // joints that ever translate: give them a translation track in every clip
    for (const c of clips) for (const e of c.ti_ || []) bones.forEach((b, i) => { if (b.rot + aoff === e) movers.add(i); });
    clips.forEach((c, ci) => {
      const d = arr(c.d, Int16Array), td = c.td ? arr(c.td, Int16Array) : null, ncol = c.idx.length;
      const col = new Map(c.idx.map((e, i) => [e, i])), tcol = new Map((c.ti_ || []).map((e, i) => [e, i]));
      const nk = c.n, times = new Float32Array(nk + 1);
      for (let k = 0; k <= nk; k++) times[k] = (k * c.iv) / 30;
      const input = glb.accessor(times, "SCALAR", 5126, { minmax: true });
      const samplers = [], channels = [];
      bones.forEach((b, i) => {
        const e = b.rot + aoff, cc = col.get(e);
        const rot = new Float32Array((nk + 1) * 4);
        let prev = null;
        for (let k = 0; k <= nk; k++) {
          const kk = k % nk;
          let q = cc === undefined ? [0, 0, 0, 1] : bamToQuat(d[(kk * ncol + cc) * 3], d[(kk * ncol + cc) * 3 + 1], d[(kk * ncol + cc) * 3 + 2]);
          if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);   // shortest path
          rot.set(q, k * 4); prev = q;
        }
        channels.push({ sampler: samplers.push({ input, output: glb.accessor(rot, "VEC4", 5126), interpolation: "LINEAR" }) - 1, target: { node: jointNodes[i], path: "rotation" } });
        if (movers.has(i)) {
          const tc = tcol.get(e), tr = new Float32Array((nk + 1) * 3);
          for (let k = 0; k <= nk; k++) {
            const kk = k % nk;
            for (let a = 0; a < 3; a++) tr[k * 3 + a] = (b.rest[a] + (td && tc !== undefined ? td[(kk * c.ti_.length + tc) * 3 + a] / 16 : 0)) * SCALE;
          }
          channels.push({ sampler: samplers.push({ input, output: glb.accessor(tr, "VEC3", 5126), interpolation: "LINEAR" }) - 1, target: { node: jointNodes[i], path: "translation" } });
        }
      });
      glb.json.animations.push({ name: clipName(m, c, ci, ANIMTAB), samplers, channels });
    });
    return glb.finish();
  }

  // ---------------- static meshes ----------------
  const isTrigger = (g) => {   // untextured pure-white marker volumes the game never draws (viewer hides them)
    if (g.ti >= 0) return false;
    const col = arr(g.col, Uint8Array);
    for (let i = 0; i < col.length; i++) if (col[i] < 250) return false;
    return col.length > 0;
  };
  function staticMesh(glb, name, groups) {
    const prims = [];
    for (const g of groups) {
      if (isTrigger(g)) continue;
      const p = arr(g.p, Int16Array), posF = new Float32Array(p.length);
      for (let i = 0; i < p.length; i++) posF[i] = p[i] * SCALE;
      prims.push(glb.primitive(g, posF));
    }
    return prims.length ? glb.json.meshes.push({ name, primitives: prims }) - 1 : -1;
  }
  async function exportObject(DATA, m) {
    const glb = new Glb(DATA, m.name);
    const mesh = staticMesh(glb, m.name, m.groups);
    if (mesh >= 0) glb.json.scenes[0].nodes.push(glb.node({ name: m.name, mesh }));
    return glb.finish();
  }
  // a level: terrain + every visible placed prop (shared part meshes instanced via nodes)
  async function exportLevel(DATA, L) {
    const glb = new Glb(DATA, L.name);
    const root = [];
    const terrain = staticMesh(glb, L.name + " terrain", L.groups);
    if (terrain >= 0) root.push(glb.node({ name: "terrain", mesh: terrain }));
    const partMesh = new Map();
    const props = L._props || L.props;
    props.forEach((pr, i) => {
      if (!pr.vis) return;
      const part = L.partpool[pr.pp];
      if (!part) return;
      if (!partMesh.has(pr.pp)) partMesh.set(pr.pp, staticMesh(glb, (part.ext ? "obj_" : "part_") + part.part, part.g));
      const mesh = partMesh.get(pr.pp);
      if (mesh < 0) return;
      let R = rotMat3(pr.rot[0], pr.rot[1], pr.rot[2]);
      const u = pr.urot;   // the user's hinge setting from the States panel, applied in the part's own frame
      if (u && (u[0] || u[1] || u[2])) { const H = rotMat3(u[0], u[1], u[2]); R = H.map((r) => [0, 1, 2].map((j) => r[0] * R[0][j] + r[1] * R[1][j] + r[2] * R[2][j])); }
      const sc = pr.sc || [1, 1, 1], T = pr.pos;
      const M = [sc[0] * R[0][0], sc[0] * R[0][1], sc[0] * R[0][2], 0, sc[1] * R[1][0], sc[1] * R[1][1], sc[1] * R[1][2], 0,
        sc[2] * R[2][0], sc[2] * R[2][1], sc[2] * R[2][2], 0, T[0] * SCALE, T[1] * SCALE, T[2] * SCALE, 1];
      root.push(glb.node({ name: `${part.ext ? "obj" : "part"}_${part.part}_${i}`, mesh, matrix: M }));
    });
    glb.json.scenes[0].nodes.push(glb.node({ name: L.name, children: root }));
    return glb.finish();
  }

  globalThis.ConkerExport = { exportCharacter, exportObject, exportLevel, texturePNG, encodePNG, nativePixels };
})();
