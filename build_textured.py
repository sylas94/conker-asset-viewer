import struct, zlib, base64, os, glob, math, json
import rom
from rom import get_asset
from tex_decode import decode_texture
from model_final import runzip, u32 as U32, s16 as S16, parse_dir, tri_of
def u32(d,o): return struct.unpack('>I',d[o:o+4])[0]
def s16(d,o): return struct.unpack('>h',d[o:o+2])[0]
def f32(d,o): return struct.unpack('>f',d[o:o+4])[0]
# ---------- global texture registry (NO budget) ----------
TEX=[]          # list of {d(b64 png), w, h, a(bool has-alpha)}
_objid=id       # builtin id(), aliased because some functions take an `id` parameter that shadows it
TEXKEY={}       # (texid,W,H) -> index ; -1 = failed
TEXMETA=[]      # parallel to TEX: (texid,W,H,fmt,siz,flag,assetlen,fname)
TEXMAX=256      # decode textures up to 256x256 (was 128 budget cap)
def smart_png(w,h,rgba):
    """Write RGB png if fully opaque (small), else RGBA png (alpha preserved)."""
    has_alpha=any(rgba[i*4+3]<255 for i in range(w*h))
    def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    raw=bytearray()
    if has_alpha:
        for y in range(h):
            raw.append(0); raw+=rgba[y*w*4:(y+1)*w*4]
        ihdr=struct.pack('>IIBBBBB',w,h,8,6,0,0,0)
    else:
        for y in range(h):
            raw.append(0)
            for x in range(w):
                j=(y*w+x)*4; raw.append(rgba[j]); raw.append(rgba[j+1]); raw.append(rgba[j+2])
        ihdr=struct.pack('>IIBBBBB',w,h,8,2,0,0,0)
    png=b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',ihdr)+ch(b'IDAT',zlib.compress(bytes(raw),9))+ch(b'IEND',b'')
    return png,has_alpha
def _pot(n):
    p=1
    while p<n: p<<=1
    return p
def _resize_nn(px,w,h,pw,ph):
    """nearest-neighbour resize to power-of-two; content still maps 0..W -> 0..PW so tiling wraps
       at the same boundary (UVs keep using the ORIGINAL W/H so the wrap point is unchanged)."""
    out=bytearray(pw*ph*4)
    for y in range(ph):
        sy=(y*h)//ph
        for x in range(pw):
            sx=(x*w)//pw; si=(sy*w+sx)*4; di=(y*pw+x)*4
            out[di]=px[si]; out[di+1]=px[si+1]; out[di+2]=px[si+2]; out[di+3]=px[si+3]
    return out
TXFAIL={"notexid":0,"toobig":0,"noasset":0,"decodefail":0,"ok":0}
DIMFIX=[0]
def _fix_ci_dims(data, W, H, flag):
    """Some textures give a SETTILESIZE that is a HALF-size sub-tile / mip while the asset holds a larger
       base (ear 0x397: tile 16x16 but a 32x32 CI8 -> stripe garbage; pillar 0xf57: tile 8x8 but a 16x16
       RGBA32 -> rainbow noise). If the asset can hold an integer-k-times-larger base at the same aspect
       and bit-depth, upscale W,H to it. Only fires when the asset is genuinely >=4x the SETTILESIZE base."""
    if not data or not W or not H: return W,H
    n=len(data)
    if flag&0x400000: bpp=1.0; tlut=512      # CI8
    elif flag&0x800000: bpp=0.5; tlut=32     # CI4
    else:                                    # non-CI: pick bit-depth like decode_texture does (by size)
        base=W*H; tlut=0
        bpp = 4.0 if n>=base*4 else (2.0 if n>=base*2 else 1.0)
    cap=n-tlut
    if cap<=0: return W,H
    bf=lambda w,h: int(w*h*bpp)
    k=1
    while bf(W*(k+1),H*(k+1))<=cap and W*(k+1)<=TEXMAX and H*(k+1)<=TEXMAX: k+=1
    if k>1: DIMFIX[0]+=1; return W*k,H*k
    return W,H
# Per-texid decode overrides for textures whose SETTILE header LIES (fmt/siz/dims) and can't be recovered
# by the size heuristic (found via the full-texture coherence audit, audit_textures.py). Each -> (W,H,fmt,siz,flag).
#   0xc3a: DL says 64x32 RGBA32(siz3) but 4096 bytes = 64x16 RGBA32 -> decoded RGBA16 64x32 = rainbow static
#          (real image = stone arches). 0x54f: DL says RGBA16(fmt0) but the 4096 bytes are IA16 (glasses sprite).
TEX_OVERRIDE={0xc3a:(64,16,0,3,0), 0x54f:(64,32,3,2,0)}
def tex_index(texid,W,H,fmt=None,siz=None,flag=0):
    if not texid or not W or not H or W<1 or H<1: TXFAIL["notexid"]+=1; return -1
    data=get_asset(texid); idx=-1
    if texid in TEX_OVERRIDE: W,H,fmt,siz,flag=TEX_OVERRIDE[texid]   # exact correct params (header is wrong)
    else: W,H=_fix_ci_dims(data,W,H,flag)     # correct mip'd/sub-tile CI dims BEFORE decode + before UV scale
    if W>TEXMAX or H>TEXMAX: TXFAIL["toobig"]+=1; return -1
    key=(texid,W,H)
    if key in TEXKEY: return TEXKEY[key]
    if not data: TXFAIL["noasset"]+=1
    else:
        try:
            px,fname=decode_texture(data,W,H,fmt,siz,flag)
            if px and len(px)==W*H*4:
                pw,ph=_pot(W),_pot(H)                    # WebGL1 needs POT for REPEAT wrap + mipmaps
                if (pw,ph)!=(W,H): px=_resize_nn(px,W,H,pw,ph)
                png,ha=smart_png(pw,ph,px)               # store POT pixels; keep orig W/H below for UV
                b=base64.b64encode(png).decode(); idx=len(TEX); TEX.append({"d":b,"w":W,"h":H,"a":ha})
                TEXMETA.append((texid,W,H,fmt,siz,flag,len(data),fname)); TXFAIL["ok"]+=1
            else: TXFAIL["decodefail"]+=1
        except Exception: idx=-1; TXFAIL["decodefail"]+=1
    TEXKEY[key]=idx; return idx
_EYE_TI=[None]
def eye_tex_index():
    """Synthesize a forward-facing cartoon eye (white sclera, brown iris, black pupil, highlight) and
       register it once. The real per-character eye textures are bound at runtime by a LEVEL-keyed
       jump table (func_15100464 -> D_80090324), so there is no single static id to read; a centred
       pupil = 'looking straight ahead', which is what we want for a neutral-pose viewer."""
    if _EYE_TI[0] is not None: return _EYE_TI[0]
    S=64; px=bytearray(S*S*4)
    cx=cy=S/2.0
    def c(x): return max(0,min(255,int(x)))
    def lerp(a,b,t): return a+(b-a)*t
    for y in range(S):
        for x in range(S):
            dx=(x-cx)/(S*0.5); dy=(y-cy)/(S*0.5); r=math.sqrt(dx*dx+dy*dy)
            # OPAQUE eye that FILLS the quad (the quad IS the eye-white; there's no sclera mesh behind it,
            # so a transparent surround leaves gaps). Sclera fades to a dark socket rim at the edge so it
            # reads as an eye in a socket rather than a hard white square, and never shows through.
            R,G,B=(244,242,236)   # big white sclera fills most of the quad
            if r>=0.86:           # socket rim only at the very edge/corners: fade white -> dark, opaque
                t=min(1.0,(r-0.86)/0.40); R=lerp(244,52,t); G=lerp(242,40,t); B=lerp(236,32,t)
            if r<0.15:            # pupil
                R,G,B=16,14,14
            elif r<0.30:          # brown iris ring
                t=(r-0.15)/0.15; R=64+46*t; G=40+34*t; B=22+20*t
            hx=dx+0.16; hy=dy+0.20
            if hx*hx+hy*hy<0.012: R=G=B=252   # specular highlight
            j=(y*S+x)*4; px[j]=c(R); px[j+1]=c(G); px[j+2]=c(B); px[j+3]=255
    png,ha=smart_png(S,S,px)
    idx=len(TEX); TEX.append({"d":base64.b64encode(png).decode(),"w":S,"h":S,"a":ha})
    TEXMETA.append((0,S,S,0,2,0,0,"synth_eye")); _EYE_TI[0]=idx; return idx
# ---------- skeleton (bind pose = translation accumulation, identity rotation) ----------
def read_skeleton(blob):
    if len(blob)<0x14: return None
    skel_off=u32(blob,8); bc=u32(blob,0xC)>>4
    if skel_off==0 or bc==0 or bc>200 or skel_off+bc*16>len(blob): return None
    bones=[]
    for i in range(bc):
        o=skel_off+i*16
        bones.append((blob[o],blob[o+1],f32(blob,o+4),f32(blob,o+8),f32(blob,o+12)))  # parentSlot, slot, rx,ry,rz
    # map slot-id -> array index (byte@0 parent and matrix ids are SLOTS, not array positions)
    slot2idx={b[1]:i for i,b in enumerate(bones)}
    wt=[None]*bc
    def resolve(i,depth=0):
        if wt[i] is not None: return wt[i]
        if depth>bc: return (bones[i][2],bones[i][3],bones[i][4])
        par,slot,rx,ry,rz=bones[i]
        pj=slot2idx.get(par)
        if par==0xFF or pj is None or pj==i:
            wt[i]=(rx,ry,rz)
        else:
            pw=resolve(pj,depth+1); wt[i]=(pw[0]+rx,pw[1]+ry,pw[2]+rz)
        return wt[i]
    for i in range(bc): resolve(i)
    return {bones[i][1]:wt[i] for i in range(bc)}   # keyed by slot id (matches G_MTX offset/0x40)
# ---------- core DL walk -> per-texindex geometry ----------
def walk_dl_groups(data, dl, vtx_base, vend, groups, skel=None, xform=None, sky=0, extkey=0, state=None, run_end=None, rt_inherit=False):
    # RDP tile/combiner/othermode state PERSISTS across display lists on real hardware, so a level
    # part that draws right after another reuses the previously-loaded texture without its own SETTIMG.
    # Pass a shared `state` dict to thread that state across consecutive parts (fixes untextured/white
    # surfaces that inherit a "stacked" texture). Vertex slots and matrix are per-part (not persisted).
    slot={}; i=dl; mtx=(0,0,0)
    if state is None: state={}
    curtex=state.get('tex'); curW=state.get('W',0); curH=state.get('H',0)
    curfmt=state.get('fmt'); cursiz=state.get('siz'); curflag=state.get('flag',0)
    expsize=state.get('exp',False); curprim=state.get('prim',(255,255,255))
    curomode=state.get('omode',0); curcomb0=state.get('comb0',0); curseg=state.get('seg',0)
    curcmS=state.get('cmS',0); curcmT=state.get('cmT',0)   # SETTILE clamp/mirror bits (render tile)
    curuls=state.get('uls',0); curult=state.get('ult',0)   # SETTILESIZE tile origin (s10.2) -> N64 texcoords are tile-RELATIVE
    omode_set=state.get('omset',False)                     # was othermode explicitly issued? (chars rarely do)
    lastpool=state.get('lastpool')                         # last seg0 (pool-id) texture, for char runtime-part fallback
    def gettarget():
        nonlocal lastpool
        # runtime-bound texture = SETTIMG on a segment the game fills at runtime (>=2). The offset is a
        # segment-relative address, NOT a pool id -> never decode pool[offset] (that gave wrong textures,
        # e.g. character EYES use seg6/7/10/11 off 0x400/0x800 for the runtime look-at eye texture).
        rt = curseg if curseg>=2 else 0
        if rt:
            # can't recover the runtime texture. For characters, fall back to the model's own last real
            # texture so bodies read as textured (own art) rather than glaring white; levels stay ti=-1.
            ti = tex_index(*lastpool) if (rt_inherit and lastpool) else -1
        else:
            ti = tex_index(curtex,curW,curH,curfmt,cursiz,curflag) if curtex else -1
            if ti>=0: lastpool=(curtex,curW,curH,curfmt,cursiz,curflag)
        zmode=(curomode>>10)&3
        dec = 1 if zmode==3 else 0                                   # ZMODE_DECAL -> depth bias (opaque)
        blend = 1 if zmode==2 else 0                                 # ZMODE_XLU -> translucent (FORCE_BL is used in opaque AA too, so not a blend signal)
        # Blender-uses-alpha flags: FORCE_BL(14) forces the P*A+M*B blend on; ALPHA_CVG_SEL(13) routes the
        # combined alpha into coverage (soft alpha fades). Alone these are unreliable (AA-opaque sets FORCE_BL),
        # but COMBINED with a real per-vertex alpha fade (vat, min<250) they mark a translucent surface a plain
        # zmode==2 test misses -> e.g. Level 5 brown haze/cloud planes (tex 0x729, vtx alpha 0..254, no XLU zmode).
        fbl = 1 if ((curomode>>14)&1) or ((curomode>>13)&1) else 0
        # combiner: SHADE (mux 4) as ANY RGB input (a0 bits20-23, c0 15-19, a1 5-8, c1 0-4) => texture is
        # modulated by the BAKED vertex shade. Conker puts SHADE in the a1 slot, which the old c0/c1-only test missed
        # -> every model got mod=0 and the viewer substituted fake directional light, discarding the baked AO.
        mod = 1 if 4 in (((curcomb0>>20)&0xF),((curcomb0>>15)&0x1F),((curcomb0>>5)&0xF),(curcomb0&0x1F)) else 0
        ek = extkey if not rt else (extkey,rt)                       # keep runtime surfaces separate per part
        # alpha test active? G_AC_THRESHOLD (othermode_lo bits0-1) or CVG_X_ALPHA (bit12). Only THEN does the
        # texture's alpha bit punch holes. BUT only force-opaque when othermode was actually issued -- character
        # DLs almost never set it, so default to cutout there (matches original look; force-opaque broke them).
        ac = 1 if (not omode_set or (curomode & 3)!=0 or ((curomode>>12)&1)) else 0
        # tile wrap per axis: 2=clamp (decals/signs, don't repeat -> fixes edge bleeding), 1=mirror
        # (symmetric rugs/patterns via MIRRORED_REPEAT), 0=repeat (tiling ground/walls).
        wrapS = 2 if (curcmS&2) else (1 if (curcmS&1) else 0)
        wrapT = 2 if (curcmT&2) else (1 if (curcmT&1) else 0)
        key=(ti,dec,blend,sky,ek,mod,rt,ac,wrapS,wrapT,fbl)
        g=groups.get(key)
        if g is None:
            g={"V":[], "map":{}, "F":[], "ti":ti, "dec":dec, "blend":blend, "prim":curprim, "sky":sky,
               "mod":mod, "rt":rt, "ac":ac, "ws":wrapS, "wt":wrapT, "fbl":fbl, "uls":curuls, "ult":curult}
            groups[key]=g
        return g,ti
    lim=len(data) if run_end is None else min(len(data),run_end)
    while i+8<=lim:
        w0=u32(data,i); w1=u32(data,i+4); op=w0>>24
        if op==0xDF:
            # ENDDL: a model's DL block holds several sub-DLs drawn back-to-back. When walking the
            # whole block (run_end set), the RDP tile state AND the matrix stack persist across the
            # boundary on real HW, so continue into the next sub-DL instead of stopping.
            if run_end is None: break
            i+=8; continue
        if op==0x01:
            n=(w0>>12)&0xFF; end=(w0>>1)&0x7F; start=end-n; seg=(w1>>24)&0xF; off=w1&0xFFFFFF
            vb=(vtx_base+off) if seg==1 else off
            for k in range(n):
                vo=vb+k*16
                if 0x28<=vo and vo+16<=vend:
                    x=s16(data,vo)+mtx[0]; y=s16(data,vo+2)+mtx[1]; z=s16(data,vo+4)+mtx[2]
                    if xform: x,y,z=xform((x,y,z))
                    slot[start+k]=(x,y,z, s16(data,vo+8),s16(data,vo+10), data[vo+12],data[vo+13],data[vo+14], data[vo+15])  # +vtx ALPHA (translucency channel)
        elif op==0xDA and skel:
            mtx=skel.get((w1&0xFFFFFF)//0x40,(0,0,0))
        elif op==0xFA:  # SETPRIMCOLOR -> tint for intensity/animated textures
            curprim=((w1>>24)&0xFF,(w1>>16)&0xFF,(w1>>8)&0xFF)
        elif op==0xEF:  # G_RDPSETOTHERMODE (Conker's combined form): w1 = othermode_lo
            curomode=w1; omode_set=True
        elif op==0xFC:  # G_SETCOMBINE -> track colour combiner (for shade modulation)
            curcomb0=w0
        elif op==0xE2:  # SETOTHERMODE_L -> track render mode (zmode/blend)
            shf=(w0>>8)&0xFF; length=(w0&0xFF)+1; sft=32-length-shf
            if 0<=sft<=32:
                mask=(((1<<length)-1)<<sft)&0xFFFFFFFF
                curomode=(curomode & ~mask) | (w1 & mask); omode_set=True
        elif op==0xFD:
            off=w1&0xFFFFFF; curflag=off&0xC00000; curtex=off&0x3FFFFF; expsize=True
            curseg=(w1>>24)&0xF                              # segment: 0=direct pool id, >=2=runtime-bound
            # SETTIMG w0 may carry fmt/siz per GBI (used as weak default)
            curfmt=(w0>>21)&7; cursiz=(w0>>19)&3
        elif op==0xF5:  # SETTILE -> render tile fmt/siz + clamp/mirror (last one before drawing wins)
            curfmt=(w0>>21)&7; cursiz=(w0>>19)&3
            curcmS=(w1>>8)&3; curcmT=(w1>>18)&3          # bit0=mirror, bit1=clamp (per axis)
        elif op==0xF2:  # SETTILESIZE -> RENDER-tile dims + origin (ONLY the first after SETTIMG; later ones are
            # mipmap tiles whose uls/ult are TMEM offsets, not UV origins -> capturing those broke ~all UVs).
            if expsize:
                uls=(w0>>12)&0xFFF; ult=w0&0xFFF; lrs=(w1>>12)&0xFFF; lrt=w1&0xFFF
                curW=((lrs-uls)>>2)+1; curH=((lrt-ult)>>2)+1
                curuls=uls; curult=ult   # N64 texcoords are tile-relative -> subtract this origin when normalising UVs
                expsize=False
        elif op==0x05 or op==0x06 or 0x10<=op<=0x1F:
            g,ti=gettarget()
            for (a,b,c) in tri_of(op,w0,w1):
                if a in slot and b in slot and c in slot and a!=b and b!=c and a!=c:
                    idx=[]
                    for s in (a,b,c):
                        v=slot[s]
                        if s not in g["map"] or g["V"][g["map"][s]][:3]!=v[:3]:
                            g["map"][s]=len(g["V"]); g["V"].append(v)
                        idx.append(g["map"][s])
                    g["F"].append(tuple(idx))
        i+=8
    state.update(tex=curtex,W=curW,H=curH,fmt=curfmt,siz=cursiz,flag=curflag,exp=expsize,prim=curprim,
                 omode=curomode,comb0=curcomb0,seg=curseg,cmS=curcmS,cmT=curcmT,omset=omode_set,lastpool=lastpool,
                 uls=curuls,ult=curult)
# ---------- runtime-bound animated water ----------
# Water/reflective surfaces load their texture from an RSP segment the game fills at runtime
# (SETTIMG seg>=2, off 0), so the static DL has no pool id. The animated caustic-water set is
# 0x1c14..0x1c22 (CI4 64x64, decodes to a blue caustic ripple; the ONLY set statically referenced).
# We assign it to HORIZONTAL runtime surfaces (rivers/pools); vertical runtime surfaces (crowd
# billboards, light-shaft sprites, glass) are left untextured (flat) so they don't get water/noise.
RT_WATER=[0x1c14,0x1c1b,0x1c1c,0x1c1d,0x1c1e,0x1c1f,0x1c20,0x1c21,0x1c22,0x1c15,0x1c16,0x1c17,0x1c18,0x1c19,0x1c1a]
# assets04 chunks that ACTUALLY have runtime water (from D_80089324 record byte@6, decoded by the runtime-
# surface agent). Only these get the caustic set; elsewhere runtime surfaces (crowd/light/glass) render clean.
WATER_CHUNKS={6,7,18,23,41,59,65}
def _chunk_of(name):
    try: return int(name[3:]) if name.startswith('sub') else -1
    except Exception: return -1
_rt_water_frames=None
def rt_water():
    """decode the caustic-water frames as CI4 64x64 (TLUT is the last 32 bytes of each asset)."""
    global _rt_water_frames
    if _rt_water_frames is None:
        _rt_water_frames=[i for i in (tex_index(t,64,64,2,0,0x800000) for t in RT_WATER) if i>=0]
    return _rt_water_frames
# beh-0x19 flashing SCREEN panels (traced by the panel-animation agent, chunk 23 / level 0x23): the game
# binds a 3-frame set to RSP seg 4 at runtime (D_80089324 wildcard entry -> ids 0x102/0x103/0x104, hold 3),
# and tints each panel a different hue via per-object PRIM (== the pure vertex colour we already carry). We
# render the frames as 32x32 RGBA16 with texel*shade so the flicker plays in each panel's colour.
# Level-7 (chunk 10) distant BACKDROP plane: texid 0x785 is used NOWHERE else (verified across all 55 levels).
# It's a flat plane stretched over the FULL level extent (X10050 x Y11109), so in the free-fly viewer it reads
# as a "giant square cutting through the map". Tag its groups as sky/backdrop so the existing Sky toggle hides it
# (default still visible -- it IS real level geometry, just meant to be seen from the play camera only).
BACKDROP_TEXIDS={0x785}
PANEL_FRAMES_IDS=[0x102,0x103,0x104]
_panel_frames=None
def panel_frames():
    global _panel_frames
    if _panel_frames is None:
        _panel_frames=[i for i in (tex_index(t,32,32,0,2,0) for t in PANEL_FRAMES_IDS) if i>=0]
    return _panel_frames
# LEVEL 0x1A (assets04 chunk 26) runtime texture-bank: func_15100464 binds set D_80090324 to RSP segments 2-8
# and cycles it every few frames (frame counter D_800DD405>>2 + RNG flicker state D_800BE500), so the level's
# billboards/screens flicker through these control-panel textures. Static DL has SETTIMG on seg>=2 (runtime) =
# ti<0 in our walk -> those billboards render blank. Assign the cycling set so they show the flickering panels.
LV1A_PANEL_IDS=[0x60B,0x60C,0x60D,0x16C,0xC7D]      # 64x32 RGBA16 screens
_lv1a_panels=None
def lv1a_panels():
    global _lv1a_panels
    if _lv1a_panels is None:
        _lv1a_panels=[i for i in (tex_index(t,64,32,0,2,0) for t in LV1A_PANEL_IDS) if i>=0]
    return _lv1a_panels
def _rt_fallback(groups, only_untextured=False):
    """Runtime (seg>=2) parts have no recoverable texture. Give them the DOMINANT real texture (the ti>=0
       group with the most faces) so they read as the model's own material instead of flat vertex-colour.
       only_untextured=True (levels): fill just the ones that couldn't inherit an adjacent texture, so the
       contextual inherit wins where available."""
    best=None; bestn=0
    for gr in groups.values():
        if gr["ti"]>=0 and len(gr["F"])>bestn: bestn=len(gr["F"]); best=gr["ti"]
    if best is None: return
    for gr in groups.values():
        if gr.get("rt") and (not only_untextured or gr["ti"]<0): gr["ti"]=best
# ---------- pack groups -> item ----------
def b64i16(v): return base64.b64encode(struct.pack('<%dh'%len(v),*v)).decode()
def b64u16(v): return base64.b64encode(struct.pack('<%dH'%len(v),*v)).decode()
def b64u8(v):  return base64.b64encode(bytes(v)).decode()
def pack_item(name, src, kind, groups, animmap=None, allow_cull=False):
    allv=[]
    for g in groups.values(): allv+=[v[:3] for v in g["V"]]
    if len(allv)<6: return None
    xs=sorted(v[0] for v in allv); ys=sorted(v[1] for v in allv); zs=sorted(v[2] for v in allv); n=len(xs)
    def band(a): p=a[int(n*0.02)]; q=a[int(n*0.98)]; r=(q-p) or 1; return (p-5*r,q+5*r)
    bx,by,bz=band(xs),band(ys),band(zs)
    def okv(v): return bx[0]<=v[0]<=bx[1] and by[0]<=v[1]<=by[1] and bz[0]<=v[2]<=bz[1] and abs(v[0])<32760 and abs(v[1])<32760 and abs(v[2])<32760
    diag=math.sqrt((bx[1]-bx[0])**2+(by[1]-by[0])**2+(bz[1]-bz[0])**2) or 1
    span_thresh=0.30*diag
    # first pass: valid faces + spanning fraction + normal coherence (soup detectors)
    from collections import defaultdict
    valid={}; nspan=0; nvalid=0; en=defaultdict(list)
    for key,g in groups.items():
        V=g["V"]; lst=[]
        for f in g["F"]:
            if not(okv(V[f[0]]) and okv(V[f[1]]) and okv(V[f[2]])): continue
            a,b,c=V[f[0]],V[f[1]],V[f[2]]
            sp = max(math.dist(a[:3],b[:3]),math.dist(b[:3],c[:3]),math.dist(c[:3],a[:3])) > span_thresh
            lst.append((f,sp)); nvalid+=1; nspan+= 1 if sp else 0
            if allow_cull:  # coherence only for objects/characters (cheap; levels skip)
                ux,uy,uz=b[0]-a[0],b[1]-a[1],b[2]-a[2]; vx,vy,vz=c[0]-a[0],c[1]-a[1],c[2]-a[2]
                nx,ny,nz=uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx; nl=math.sqrt(nx*nx+ny*ny+nz*nz) or 1
                nrm=(nx/nl,ny/nl,nz/nl)
                for e in ((a[:3],b[:3]),(b[:3],c[:3]),(c[:3],a[:3])): en[tuple(sorted(e))].append(nrm)
        valid[key]=lst
    if nvalid<6: return None
    frac=nspan/nvalid
    # normal coherence: mean |dot| of face normals across shared edges (low = tangled soup)
    coh=1.0
    if allow_cull:
        dots=[]
        for ns in en.values():
            if len(ns)>=2:
                n0=ns[0]
                for m in ns[1:]: dots.append(abs(n0[0]*m[0]+n0[1]*m[1]+n0[2]*m[2]))
        coh=sum(dots)/len(dots) if dots else 0.0
    # clean model -> keep everything; soupy model -> drop spanning stitches; hopeless -> reject
    docull = allow_cull and frac>0.10
    hopeless = allow_cull and frac>0.45
    out=[]; tot=0
    for key,lst in valid.items():
        g=groups[key]; V=g["V"]; ti=g["ti"]
        # runtime-bound surface: assign the animated caustic-water set to HORIZONTAL groups (rivers/pools).
        # vertical runtime surfaces (crowd billboards, light shafts, glass) can't be recovered -> render
        # them flat with their own vertex colour (never as texture noise).
        rt=g.get("rt",0); rt_frames=None
        # level runtime surfaces: HORIZONTAL -> animated water; others keep the inherited wall texture
        # (rt_inherit gave them the adjacent real texture in the walk, so they're not flat solid colour).
        if rt and V and not allow_cull:
            hz=0.0; nf=0
            for (f,sp) in lst[:400]:
                a,b,c=V[f[0]],V[f[1]],V[f[2]]
                ux,uy,uz=b[0]-a[0],b[1]-a[1],b[2]-a[2]; vx,vy,vz=c[0]-a[0],c[1]-a[1],c[2]-a[2]
                nx,ny,nz=uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx; nl=math.sqrt(nx*nx+ny*ny+nz*nz) or 1
                hz+=abs(ny)/nl; nf+=1
            horiz=hz/nf if nf else 0
            rr=sum(v[5] for v in V)//len(V); gg=sum(v[6] for v in V)//len(V); bb=sum(v[7] for v in V)//len(V)
            orange = rr>gg+20 and rr>bb+20 and rr>60           # lava tint -> don't paint blue water on it
            if _chunk_of(name)==26:                            # level 0x1A: runtime billboards = flickering panels
                pf=lv1a_panels()
                if pf: ti=pf[0]; rt_frames=pf
            elif horiz>0.55 and not orange and _chunk_of(name) in WATER_CHUNKS:   # only real water chunks
                fr=rt_water()
                if fr: ti=fr[0]; rt_frames=fr
        # untextured enclosures are void/kill planes (flat solid colors), not real skyboxes -> drop
        if g.get("sky") and ti<0: continue
        F=[f for (f,sp) in lst if not(docull and sp)]
        if not F: continue
        used=sorted({i for f in F for i in f}); rm={o:k for k,o in enumerate(used)}
        P=[];UV=[];COL=[];VA=[]
        # Subtract the tile ORIGIN only on CLAMP axes: WebGL CLAMP_TO_EDGE clamps to [0,1], so a clamped tile at
        # texel-origin uls (e.g. a blood-splat decal at 256) must be shifted to 0 to clamp correctly. Repeat axes
        # wrap fine with absolute UVs (and uls is Conker's global 256 default -> subtracting would misalign them).
        guls=g.get("uls",0)/4.0 if g.get("ws")==2 else 0.0; gult=g.get("ult",0)/4.0 if g.get("wt")==2 else 0.0
        for oi in used:
            v=V[oi]; P+=[max(-32768,min(32767,int(round(v[0])))),max(-32768,min(32767,int(round(v[1])))),max(-32768,min(32767,int(round(v[2]))))]
            tw=TEX[ti]["w"] if ti>=0 else 1; th=TEX[ti]["h"] if ti>=0 else 1
            u=(v[3]/32.0-guls)/tw; vv=(v[4]/32.0-gult)/th
            UV+=[max(-32000,min(32000,int(round(u*512)))),max(-32000,min(32000,int(round(vv*512))))]
            COL+=[v[5],v[6],v[7]]; VA.append(v[8] if len(v)>8 else 255)
        IDX=[]
        for f in F: IDX+=[rm[f[0]],rm[f[1]],rm[f[2]]]
        grp={"ti":ti,"p":b64i16(P),"uv":b64i16(UV),"col":b64u8(COL),"idx":b64u16(IDX)}
        if VA and min(VA)<250: grp["va"]=b64u8(VA); grp["vat"]=1   # per-vertex ALPHA -> real translucency (glass etc.)
        if ti>=0 and TEX[ti].get("a"): grp["al"]=1     # texture has an alpha channel
        if g.get("ac"): grp["ac"]=1                     # alpha test active -> allow cutout (else render opaque)
        ws=g.get("ws",0); wt=g.get("wt",0)              # wrap: 1=mirror, 2=clamp (0=repeat default)
        if UV:                                          # clamp only makes sense within [0,1]; if the surface
            us=UV[0::2]; vs=UV[1::2]                     # actually TILES, clamping smears the edge -> force repeat
            if ws==2 and not g.get("dec") and us and (max(us)-min(us))/512.0>1.5: ws=0   # keep CLAMP on decals
            if wt==2 and not g.get("dec") and vs and (max(vs)-min(vs))/512.0>1.5: wt=0   # (blood splats, signs)
        if ws: grp["ws"]=ws
        if wt: grp["wt"]=wt
        if rt_frames:                                  # runtime caustic water -> animated, shown opaque
            grp["anim"]=rt_frames; grp["rt"]=1; grp["aspd"]=4   # caustic set hold=1 (fastest) -> flowing water
        else:
            if g.get("dec"): grp["dec"]=1              # ZMODE_DECAL -> polygon offset (fix z-fighting)
            if g.get("blend"): grp["bl"]=1             # translucent render mode -> alpha blend (light shafts)
            if grp.get("vat") and g.get("fbl"): grp["bl"]=1   # per-vertex alpha fade + blender-uses-alpha -> translucent haze/cloud (0x729)
            # Sky/backdrop -> toggleable in viewer, BUT only for genuine sky SHELLS. An enclosure PART often
            # bundles the skybox WITH ground/floor geometry; those floors use heavily-TILED detail textures
            # (UVmax >=~8) while real sky shells stretch/degenerate their texture (UVmax <=2). Tagging the whole
            # part sky made the Sky toggle wrongly HIDE real ground (Lv1 0xa88/0xd03, Lv11 0xd05/0xd06). Gate on
            # UV tiling so only the shell is toggleable.
            if g.get("sky") or (ti>=0 and ti<len(TEXMETA) and TEXMETA[ti][0] in BACKDROP_TEXIDS):
                uu=UV[0::2] if UV else []; vv=UV[1::2] if UV else []
                uvmax=max((max(uu)-min(uu))/512.0 if uu else 0.0, (max(vv)-min(vv))/512.0 if vv else 0.0)
                if uvmax<4.0: grp["sky"]=1              # genuine sky shell; tiled ground stays normal geometry
            if g.get("mod"): grp["mod"]=1              # TEXEL*SHADE -> modulate texture by vertex colour
            pr=g.get("prim",(255,255,255))
            if pr!=(255,255,255): grp["tint"]=list(pr) # prim color tint for intensity/animated textures
            if animmap and ti in animmap: grp["anim"]=animmap[ti]
        out.append(grp); tot+=len(F)
    if not out or tot<8 or hopeless: return None
    item={"name":name,"src":src,"kind":kind,"groups":out,"ntri":tot,"_soup":round(frac,3),"_coh":round(coh,3)}
    return item
def pack_part(groups, animmap=None):
    """Pack a placed PART's LOCAL geometry into viewer group format, for the instanced level-props /
       state-controller system. Returns (list_of_grp, ntri). CULLS sentinel/outlier verts (INT16_MIN
       block-start markers) the same way pack_item does — else props render as GIANT SPIKES across the
       level (verts at +-32768)."""
    allv=[]
    for g in groups.values(): allv+=[v[:3] for v in g["V"] if abs(v[0])<32760 and abs(v[1])<32760 and abs(v[2])<32760]
    if len(allv)<3: return [],0
    xs=sorted(v[0] for v in allv); ys=sorted(v[1] for v in allv); zs=sorted(v[2] for v in allv); n=len(xs)
    def band(a): p=a[int(n*0.02)]; q=a[int(n*0.98)]; r=(q-p) or 1; return (p-6*r,q+6*r)
    bx,by,bz=band(xs),band(ys),band(zs)
    def okv(v): return bx[0]<=v[0]<=bx[1] and by[0]<=v[1]<=by[1] and bz[0]<=v[2]<=bz[1] and abs(v[0])<32760 and abs(v[1])<32760 and abs(v[2])<32760
    out=[]; tot=0
    for g in groups.values():
        V=g["V"]; ti=g["ti"]
        F=[f for f in g["F"] if okv(V[f[0]]) and okv(V[f[1]]) and okv(V[f[2]])]   # drop faces touching a sentinel/outlier
        if not F: continue
        used=sorted({i for f in F for i in f}); rm={o:k for k,o in enumerate(used)}
        P=[];UV=[];COL=[];VA=[]
        tw=TEX[ti]["w"] if ti>=0 else 1; th=TEX[ti]["h"] if ti>=0 else 1
        guls=g.get("uls",0)/4.0 if g.get("ws")==2 else 0.0; gult=g.get("ult",0)/4.0 if g.get("wt")==2 else 0.0
        for oi in used:
            v=V[oi]
            P+=[max(-32768,min(32767,int(round(v[0])))),max(-32768,min(32767,int(round(v[1])))),max(-32768,min(32767,int(round(v[2])))) ]
            u=(v[3]/32.0-guls)/tw; vv=(v[4]/32.0-gult)/th
            UV+=[max(-32000,min(32000,int(round(u*512)))),max(-32000,min(32000,int(round(vv*512))))]
            COL+=[v[5],v[6],v[7]]; VA.append(v[8] if len(v)>8 else 255)
        IDX=[]
        for f in F: IDX+=[rm[f[0]],rm[f[1]],rm[f[2]]]
        if not IDX: continue
        grp={"ti":ti,"p":b64i16(P),"uv":b64i16(UV),"col":b64u8(COL),"idx":b64u16(IDX)}
        if VA and min(VA)<250: grp["va"]=b64u8(VA); grp["vat"]=1
        if ti>=0 and TEX[ti].get("a"): grp["al"]=1
        if g.get("ac"): grp["ac"]=1
        ws=g.get("ws",0); wt=g.get("wt",0)
        if UV:
            us=UV[0::2]; vs=UV[1::2]
            if ws==2 and not g.get("dec") and us and (max(us)-min(us))/512.0>1.5: ws=0   # keep CLAMP on decals
            if wt==2 and not g.get("dec") and vs and (max(vs)-min(vs))/512.0>1.5: wt=0   # (blood splats, signs)
        if ws: grp["ws"]=ws
        if wt: grp["wt"]=wt
        if g.get("dec"): grp["dec"]=1
        if g.get("blend"): grp["bl"]=1     # only true XLU (zmode==2) blends for placed props
        # NB: do NOT promote vat+fbl -> bl here (unlike terrain/pack_item). Placed objects (dino jaw, doors)
        # carry the same per-vertex-alpha + FORCE_BL pattern as atmosphere haze, but they are SOLID objects;
        # blending them renders faint "ghost" overlays (esp. untextured ti=-1 sub-parts). Props stay opaque.
        if g.get("mod"): grp["mod"]=1
        if animmap and ti in animmap: grp["anim"]=animmap[ti]
        out.append(grp); tot+=len(F)
    return out, tot
def _is_map_plane(groups):
    """A FLAT, map-spanning surface referenced as a placed object = a void/kill/clip plane (or a level
       bounding quad), NOT a real prop. Rendered opaque it's a 'giant square cutting through the map'.
       Detect: huge in its largest axis, near-zero in its smallest (a thin sheet spanning the level)."""
    xs=[];ys=[];zs=[]
    for g in groups.values():
        for v in g["V"]:
            if abs(v[0])<32000 and abs(v[1])<32000 and abs(v[2])<32000:
                xs.append(v[0]);ys.append(v[1]);zs.append(v[2])
    if len(xs)<3: return False
    sp=sorted([max(xs)-min(xs),max(ys)-min(ys),max(zs)-min(zs)])
    return sp[2]>30000 and sp[0]<2000
# ---------- OBJECT builder ----------
def build_object(blob):
    if len(blob)<0x30: return None,False
    head=u32(blob,0)
    if not (0x28<=head<len(blob)): return None,False
    skel=read_skeleton(blob)
    if blob[head]!=0: dls=[head]
    else:
        cnt=u32(blob,4)>>2
        if cnt==0 or cnt>256: return None,False
        dls=[u32(blob,head+4*i) for i in range(cnt)]
    groups={}
    tstate={}
    for dl in dls:
        if not (0x28<=dl<len(blob)): continue
        walk_dl_groups(blob, dl, 0x28, head, groups, skel=skel, state=tstate, rt_inherit=True)
    _rt_fallback(groups)
    return groups, (skel is not None)
# ---------- assets01 external models (kind-0 world placements: characters/props) ----------
_A01=None; _PD01=None
def get_a01(id):
    global _A01,_PD01
    if _A01 is None:
        _A01=rom.group_bytes(0x01); _PD01=parse_dir(_A01)
    if not _PD01 or id>=len(_PD01): return None
    o,s,c=_PD01[id]; blob=_A01[o:o+s]
    dec=runzip(blob) if c else None; return dec if dec else blob
_A01KNOWN=set([0x00,0x01,0x05,0x06,0xda,0xdb,0xdc,0xd7,0xd9,0xde,0xdf,0xe6,0xe7,0xe8,0xe2,0xe3,0xef,0xf0,0xf2,0xf3,0xf4,0xf5,0xf8,0xf9,0xfa,0xfb,0xfc,0xfd]+list(range(0x10,0x20)))
def _a01_find_dl(data, vend):
    best=None; i=vend; n=len(data)
    while i+8<=n:
        if data[i] in _A01KNOWN:
            j=i; ops=0
            while j+8<=n:
                if data[j]==0xDF: ops+=1; j+=8; break
                if data[j] in _A01KNOWN: ops+=1; j+=8
                else: break
            if ops>=12 and (best is None or ops>best[1]): best=(i,ops)
            i=max(j,i+8)
        else: i+=8
    return best[0] if best else None
def _a01_skel(data):
    so=u32(data,0x10); sl=u32(data,0x14)
    if so==0 or sl==0 or sl%16 or so+sl>len(data): return None
    bc=sl//16
    if bc<1 or bc>200: return None
    bones=[(data[so+i*16],data[so+i*16+1],f32(data,so+i*16+4),f32(data,so+i*16+8),f32(data,so+i*16+12)) for i in range(bc)]
    slot2idx={b[1]:i for i,b in enumerate(bones)}
    wt=[None]*bc
    def resolve(i,d=0):
        if wt[i] is not None: return wt[i]
        if d>bc: return (bones[i][2],bones[i][3],bones[i][4])
        par,slot,rx,ry,rz=bones[i]; pj=slot2idx.get(par)
        if par==0xFF or pj is None or pj==i: wt[i]=(rx,ry,rz)
        else: pw=resolve(pj,d+1); wt[i]=(pw[0]+rx,pw[1]+ry,pw[2]+rz)
        return wt[i]
    for i in range(bc): resolve(i)
    return {bones[i][1]:wt[i] for i in range(bc)}
def _a01_first_run(data, hint):
    """first ENDDL-terminated opcode run at/after hint (aligns dl_start to a real opcode)."""
    i=hint; n=len(data)
    while i+8<=n:
        if data[i] in _A01KNOWN:
            j=i; ops=0; ended=False
            while j+8<=n:
                if data[j]==0xDF: ops+=1; j+=8; ended=True; break
                if data[j] in _A01KNOWN: ops+=1; j+=8
                else: break
            if ended and ops>=6: return i
            i=max(j,i+8)
        else: i+=8
    return None
def build_a01_object(id):
    """Build one assets01 world model (Conker, creatures, bosses, props) for the Characters gallery.
       A model's DL block holds MULTIPLE sub-DLs (body, head, eyes, hands, detail overlays) drawn
       back-to-back; walk the whole block so faces/eyes aren't dropped. Block = [skel_end, sectionC)."""
    data=get_a01(id)
    if not data or len(data)<0x40: return None,False
    vend=u32(data,0x08) or 0x1000
    skel=_a01_skel(data)
    skel_off=u32(data,0x10); skel_len=u32(data,0x14)
    hint=(skel_off+skel_len) if (skel_off and skel_off+skel_len<=len(data)) else min(vend,len(data))
    dl_start=_a01_first_run(data, hint)
    if dl_start is None:
        dl_start=_a01_find_dl(data, min(vend,len(data)))
    if dl_start is None: return None,False
    secC=u32(data,0x20)                                   # trailing section (normals/anim) = end of DL block
    dl_end=secC if (dl_start<secC<=len(data)) else len(data)
    groups={}
    walk_dl_groups(data, dl_start, 0, len(data), groups, skel=skel, run_end=dl_end, rt_inherit=True)
    _rt_fallback(groups)
    return groups, (skel is not None)
def build_a01_posable(id):
    """Export a character for LIVE skinning/posing: skeleton + BONE-LOCAL verts tagged with the G_MTX
       matrix slot that drives them (positions are NOT baked into bind pose). The viewer computes each
       bone's world matrix from angles every frame and skins on the fly. Reuses the same tile/othermode
       state machine as walk_dl_groups so textures/wrap/alpha match the static Characters view."""
    data=get_a01(id)
    if not data or len(data)<0x40: return None
    so=u32(data,0x10); sl=u32(data,0x14); bc=sl//16
    if so==0 or bc==0 or bc>200 or so+bc*16>len(data): return None
    bones=[]
    for i in range(bc):
        o=so+i*16
        bones.append([data[o],data[o+1],data[o+2],   # parentSlot, slot, rotIndex
                      round(f32(data,o+4),3),round(f32(data,o+8),3),round(f32(data,o+12),3)])  # rest XYZ
    vend=u32(data,0x08) or 0x1000
    hint=(so+sl) if (so and so+sl<=len(data)) else min(vend,len(data))
    dl_start=_a01_first_run(data,hint)
    if dl_start is None: dl_start=_a01_find_dl(data,min(vend,len(data)))
    if dl_start is None: return None
    secC=u32(data,0x20); dl_end=secC if (dl_start<secC<=len(data)) else len(data)
    groups={}; slot={}; vslot={}; curslot=0
    curtex=None;curW=0;curH=0;curfmt=None;cursiz=None;curflag=0;expsize=False
    curomode=0;omode_set=False;curcomb0=0;curseg=0;curcmS=0;curcmT=0;curgeo=[0]; lastpool=[None]
    def gettarget():
        rt=curseg if curseg>=2 else 0
        if rt:
            ti=-1   # runtime-bound (eyes/face/hands): NOT a recoverable pool id -> render flat vtx colour
                    # (NEVER inherit the last pool texture; that painted the blue hoodie onto the face/hand)
        else:
            ti=tex_index(curtex,curW,curH,curfmt,cursiz,curflag) if curtex else -1
            if ti>=0: lastpool[0]=(curtex,curW,curH,curfmt,cursiz,curflag)
        zmode=(curomode>>10)&3
        dec=1 if zmode==3 else 0; blend=1 if zmode==2 else 0
        mod=1 if 4 in (((curcomb0>>20)&0xF),((curcomb0>>15)&0x1F),((curcomb0>>5)&0xF),(curcomb0&0x1F)) else 0  # SHADE in any RGB slot
        if curgeo[0]&0x40000: mod=0   # G_TEXTURE_GEN: vertex bytes are NORMALS not shade-colour -> don't modulate (chrome models)
        ac=1 if (not omode_set or (curomode&3)!=0 or ((curomode>>12)&1)) else 0
        wrapS=2 if (curcmS&2) else (1 if (curcmS&1) else 0)
        wrapT=2 if (curcmT&2) else (1 if (curcmT&1) else 0)
        key=(ti,dec,blend,mod,rt,ac,wrapS,wrapT)
        g=groups.get(key)
        if g is None:
            g={"V":[],"map":{},"kk":{},"F":[],"ti":ti,"dec":dec,"bl":blend,"mod":mod,"rt":rt,"ac":ac,"ws":wrapS,"wt":wrapT}
            groups[key]=g
        return g
    i=dl_start
    while i+8<=dl_end:
        w0=u32(data,i); w1=u32(data,i+4); op=w0>>24
        if op==0xDF: i+=8; continue
        if op==0xDA:
            curslot=(w1&0xFFFFFF)//0x40
        elif op==0x01:
            n=(w0>>12)&0xFF; end=(w0>>1)&0x7F; start=end-n; off=w1&0xFFFFFF
            for k in range(n):
                vo=off+k*16
                if 0x28<=vo and vo+16<=vend:
                    slot[start+k]=(s16(data,vo),s16(data,vo+2),s16(data,vo+4),
                                   s16(data,vo+8),s16(data,vo+10), data[vo+12],data[vo+13],data[vo+14], data[vo+15])
                    vslot[start+k]=curslot
                else: slot.pop(start+k,None)
        elif op==0xEF: curomode=w1; omode_set=True
        elif op==0xFC: curcomb0=w0
        elif op==0xD9: curgeo[0]=(curgeo[0]&(w0&0xFFFFFF))|w1   # G_GEOMETRYMODE (track texgen bit 0x40000)
        elif op==0xE2:
            shf=(w0>>8)&0xFF; length=(w0&0xFF)+1; sft=32-length-shf
            if 0<=sft<=32:
                mask=(((1<<length)-1)<<sft)&0xFFFFFFFF; curomode=(curomode&~mask)|(w1&mask); omode_set=True
        elif op==0xFD:
            off=w1&0xFFFFFF; curflag=off&0xC00000; curtex=off&0x3FFFFF; expsize=True
            curseg=(w1>>24)&0xF; curfmt=(w0>>21)&7; cursiz=(w0>>19)&3
        elif op==0xF5:
            curfmt=(w0>>21)&7; cursiz=(w0>>19)&3; curcmS=(w1>>8)&3; curcmT=(w1>>18)&3
        elif op==0xF2:
            if expsize:
                uls=(w0>>12)&0xFFF; ult=w0&0xFFF; lrs=(w1>>12)&0xFFF; lrt=w1&0xFFF
                curW=((lrs-uls)>>2)+1; curH=((lrt-ult)>>2)+1; expsize=False
        elif op==0x05 or op==0x06 or 0x10<=op<=0x1F:
            g=gettarget()
            for (a,b,c) in tri_of(op,w0,w1):
                if a in slot and b in slot and c in slot and a!=b and b!=c and a!=c:
                    idx=[]
                    for s in (a,b,c):
                        v=slot[s]; sl_=vslot.get(s,0); kv=(sl_,)+v[:3]
                        if g["kk"].get(s)!=kv:
                            g["map"][s]=len(g["V"]); g["V"].append((sl_,)+v); g["kk"][s]=kv
                        idx.append(g["map"][s])
                    g["F"].append(tuple(idx))
        i+=8
    # NOTE: no _rt_fallback here — runtime surfaces stay ti=-1 (flat vtx colour) so the dominant body
    # texture never bleeds onto the eyes/face/hands. Eyes are re-textured with a synthetic forward eye below.
    return _pack_posable(id, bones, groups)
_EYE_DBG=None
def _eye_cands(groups):
    """Runtime, untextured, near-white candidate groups with their centroid + X-extent."""
    cands=[]
    for g in groups.values():
        if not g.get("rt") or g["ti"]>=0: continue
        F=g["F"]
        if not F or len(F)>44: continue
        used=sorted({i for f in F for i in f})
        if len(used)<3: continue
        V=g["V"]; n=len(used)
        mr=sum(V[i][6] for i in used)/n; mg=sum(V[i][7] for i in used)/n; mb=sum(V[i][8] for i in used)/n
        if not (mr>=185 and mg>=185 and mb>=180): continue   # white sclera; a face/mouth strip is white on
        xs=[V[i][1] for i in used]                            # only ONE side of a pair (r>>g>>b) -> won't pair
        cands.append({"g":g,"x":sum(xs)/n,"y":sum(V[i][2] for i in used)/n,"z":sum(V[i][3] for i in used)/n,
                      "xext":max(xs)-min(xs),"ntri":len(F)})
    return cands
def _detect_eye_groups(groups):
    """Character eyes = a MIRRORED PAIR of near-white runtime quads across X (left+right eye on segs 6/7
       etc.): opposite-sign, off-centre, similar |x|, at the same height & depth. This is the reliable
       signal a single-quad test lacked -- it catches detailed 20-30-tri eyes (models 23/34/44) AND rejects
       centred lone decorations like model 22's helmet emblem (no mirror). Fallback: one lone WIDE, FORWARD
       group = both eyes baked together (model 43)."""
    cands=_eye_cands(groups); eyes=set()
    for i in range(len(cands)):
        for j in range(i+1,len(cands)):
            a=cands[i]; b=cands[j]
            if a["x"]*b["x"]<0 and min(abs(a["x"]),abs(b["x"]))>=2 and \
               abs(abs(a["x"])-abs(b["x"]))<=0.55*max(abs(a["x"]),abs(b["x"]))+3 and \
               abs(a["y"]-b["y"])<=12 and abs(a["z"]-b["z"])<=16:
                eyes.add(id(a["g"])); eyes.add(id(b["g"]))
    if not eyes:
        zmax=max((c["z"] for c in cands),default=-1e9)
        for c in cands:
            if c["xext"]>=40 and c["z"]>=8 and c["z"]>=zmax-4 and abs(c["x"])<=14 and c["ntri"]<=16:
                eyes.add(id(c["g"]))
    return eyes
def _pack_posable(id, bones, groups):
    """Compact the posable groups into base64 arrays. Positions stay BONE-LOCAL (s16); the viewer skins
       them. Vertex = (slot,x,y,z,s,t,r,g,b). Drops degenerate/oversized groups."""
    out_groups=[]; ntri=0; allxyz=[]
    eyeset=_detect_eye_groups(groups)
    for g in groups.values():
        V=g["V"]; F=g["F"]; ti=g["ti"]
        if not F: continue
        eye=_objid(g) in eyeset
        if _EYE_DBG is not None and g.get("rt"):
            uu=sorted({i for f in F for i in f})
            if uu:
                n=len(uu)
                xs=[V[i][1] for i in uu]
                _EYE_DBG.append((g.get("rt"),len(F),round(sum(V[i][6] for i in uu)/n),round(sum(V[i][7] for i in uu)/n),round(sum(V[i][8] for i in uu)/n),
                                 sum(V[i][1] for i in uu)//n,sum(V[i][2] for i in uu)//n,sum(V[i][3] for i in uu)//n,eye,max(xs)-min(xs)))
        if eye: ti=g["ti"]=eye_tex_index(); g["mod"]=1; g["bl"]=0   # white verts + mod => unshaded texel; force OPAQUE (else luminance-blend eats the dark pupil)
        used=sorted({i for f in F for i in f}); rm={o:k for k,o in enumerate(used)}
        SLOT=[]; POS=[]; UV=[]; COL=[]; VA=[]
        tw=TEX[ti]["w"] if ti>=0 else 1; th=TEX[ti]["h"] if ti>=0 else 1
        # eye quads: renormalise the quad's own UV bbox onto the full synthetic eye (dims-independent,
        # centres the pupil forward) and force verts white so texel*shade doesn't tint the eye
        if eye:
            ss=[V[i][4] for i in used]; ts=[V[i][5] for i in used]
            smin,smax=min(ss),max(ss); tmin,tmax=min(ts),max(ts)
            sr=(smax-smin) or 1; tr=(tmax-tmin) or 1
        for oi in used:
            v=V[oi]  # (slot,x,y,z,s,t,r,g,b,a)
            SLOT.append(v[0]&0xFF)
            POS+=[max(-32768,min(32767,v[1])),max(-32768,min(32767,v[2])),max(-32768,min(32767,v[3]))]
            if eye:
                u=(v[4]-smin)/sr; vv=(v[5]-tmin)/tr
                UV+=[int(round(u*512)),int(round(vv*512))]; COL+=[255,255,255]
            else:
                u=v[4]/32.0/tw; vv=v[5]/32.0/th
                UV+=[max(-32000,min(32000,int(round(u*512)))),max(-32000,min(32000,int(round(vv*512))))]
                COL+=[v[6],v[7],v[8]]
            VA.append(v[9] if len(v)>9 else 255)
        IDX=[]
        for f in F: IDX+=[rm[f[0]],rm[f[1]],rm[f[2]]]
        if not IDX: continue
        ntri+=len(IDX)//3
        al=1 if (ti>=0 and TEX[ti].get("a")) else 0
        gg={"ti":ti,"al":al,"ac":g["ac"],"bl":g["bl"],"dec":g["dec"],"mod":g["mod"],
            "ws":g["ws"],"wt":g["wt"],"n":len(IDX),
            "slot":b64u8(SLOT),"pos":b64i16(POS),"uv":b64i16(UV),"col":b64u8(COL),"idx":b64u16(IDX)}
        if VA and min(VA)<250: gg["va"]=b64u8(VA); gg["vat"]=1   # per-vertex ALPHA -> real translucency (glass helmet etc.)
        out_groups.append(gg)
    if ntri<12 or not out_groups: return None
    return {"id":id,"bones":bones,"groups":out_groups,"ntri":ntri}
# ---------- LEVEL builder ----------
def subdata(blob, idx):
    d=rom.group_bytes(int(blob,16)); top=parse_dir(d)
    if not top or idx>=len(top): return None
    o,s,c=top[idx]; data=d[o:o+s]
    if c:
        dec=runzip(data); data=dec if dec else data
    return data
def records(b):
    """0x44 placement record (layout confirmed via func_150039E0 asm trace): pos, rot(deg), kind@0xC,
       id@0x10, behaviorType@0x14 (index into D_80088C90; 0xFFFFFFFF=static), initAngle@0x18 (hinge
       closed/seed), scale, stateByte@0x34 (u8; 1=external/streamed actor), flagsByte@0x3C (bit0=dynamic)."""
    if b is None: return []
    out=[]
    for i in range(len(b)//0x44):
        r=b[i*0x44:(i+1)*0x44]
        out.append({"pos":(s16(r,0),s16(r,2),s16(r,4)),"rot":(s16(r,6),s16(r,8),s16(r,0xA)),
                    "kind":u32(r,0xC),"id":u32(r,0x10),"beh":u32(r,0x14),"init":u32(r,0x18),
                    "scale":(f32(r,0x20),f32(r,0x24),f32(r,0x28)),
                    "state":r[0x34],"flags":r[0x3C]})
    return out
def filter_state(recs):
    """Conker maps store multiple game-state versions of a prop stacked at the same position.
       Render only the default state (@0x34==0) at each position, so alternates don't overlap."""
    from collections import defaultdict
    bypos=defaultdict(list)
    for r in recs: bypos[r["pos"]].append(r)
    out=[]
    for pos,g in bypos.items():
        d=[r for r in g if r["state"]==0]
        out += d if d else g   # keep defaults; if a spot has none, keep all (fallback)
    return out
def rot_matrix(ax,ay,az):
    ax=math.radians(ax);ay=math.radians(ay);az=math.radians(az)
    cx,sx=math.cos(ax),math.sin(ax);cy,sy=math.cos(ay),math.sin(ay);cz,sz=math.cos(az),math.sin(az)
    return [[cy*cz,cy*sz,-sy],[sx*sy*cz-cx*sz,sx*sy*sz+cx*cz,sx*cy],[cx*sy*cz+sx*sz,cx*sy*sz-sx*cz,cx*cy]]
def make_xform(sc,R,T):
    def f(v):
        svx,svy,svz=v[0]*sc[0],v[1]*sc[1],v[2]*sc[2]
        return (svx*R[0][0]+svy*R[1][0]+svz*R[2][0]+T[0], svx*R[0][1]+svy*R[1][1]+svz*R[2][1]+T[1], svx*R[0][2]+svy*R[1][2]+svz*R[2][2]+T[2])
    return f
def part_extent(data,po,ps):
    dl_rel=u32(data,po); vb=po+0x28; ve=po+dl_rel
    xs=[];ys=[];zs=[]
    i=vb
    while i+16<=ve:
        xs.append(s16(data,i));ys.append(s16(data,i+2));zs.append(s16(data,i+4));i+=16
    if not xs: return 0,0,0
    ex=max(xs)-min(xs);ey=max(ys)-min(ys);ez=max(zs)-min(zs)
    return max(ex,ey,ez), min(ex,ey,ez), (ve-vb)//16   # maxaxis, minaxis, nvtx
def is_enclosure(ext,mn,nv):
    # true skybox/enclosure = large in ALL axes (a surrounding box), few verts.
    # flat floors/walls (min axis ~0) are NOT enclosures even if large.
    return ext>7000 and mn>2500 and nv<250
# ---- kind-0 EXTERNAL placed objects: geometry = assets03[id] (traced from func_150039E0: the placement
#      reader, on kind==0, resolves geometry via nested archive descent D_AB1950 -> [3] -> [id], i.e. the
#      record id is a DIRECT index into assets03; no indirection table). This is the dock, crates, doors, etc.
_A03=None; _PD03=None
def get_a03(oid):
    global _A03,_PD03
    if _A03 is None:
        _A03=rom.group_bytes(0x03); _PD03=parse_dir(_A03)
    if not _PD03 or oid<0 or oid>=len(_PD03): return None
    o,s,c=_PD03[oid]
    if s==0: return None
    blob=_A03[o:o+s]
    dec=runzip(blob) if c else None
    return dec if dec else blob
def a03_groups(blob):
    """Decode an assets03 object blob into walk_dl_groups format (header word0 -> DL or DL-table)."""
    if not blob or len(blob)<0x30: return None
    head=u32(blob,0)
    if not (0x28<=head<len(blob)): return None
    if blob[head]!=0: dls=[head]
    else:
        cnt=u32(blob,4)>>2
        if cnt==0 or cnt>256: return None
        dls=[u32(blob,head+4*i) for i in range(cnt)]
    groups={}; tstate={}
    for dl in dls:
        if not (0x28<=dl<len(blob)): continue
        walk_dl_groups(blob, dl, 0x28, head, groups, state=tstate, rt_inherit=False)
    return groups
def build_level(level, animmap):
    a04=subdata('04',level); pd=parse_dir(a04)
    if not pd: return None
    recs=records(subdata('0B',level))
    tBc=subdata('0C',level); pdB=parse_dir(tBc) if tBc else None
    if pdB and len(pdB)>2:
        o,s,c=pdB[2]; tB=tBc[o:o+s]
        if c:
            dec=runzip(tB); tB=dec if dec else tB
        recs=recs+records(tB)
    # STATE CONTROLLER: placed objects (kind 1/2 records) become INSTANCED PROPS the viewer can toggle
    # (state variants) and rotate (hinges: dino jaw / doors). Referenced parts are pulled out of the baked
    # terrain into a shared partpool (LOCAL geometry, one copy per part id); each record is a lightweight
    # instance {pp,pos,rot,sc,grp,st,beh,init,fl,vis}. Default-visible mirrors the old filter_state.
    refparts=set(r["id"] for r in recs if r["kind"] in (1,2))
    groups={}
    tstate={}   # RDP tile state persists across terrain parts (in ROM/draw order) -> inherited "stacked" textures
    for pi,(po,ps,pc) in enumerate(pd):
        if ps<0x40 or pi in refparts: continue
        dl_rel=u32(a04,po)
        if not (0x28<=dl_rel<ps): continue
        ext,mn,nv=part_extent(a04,po,ps)
        sky=1 if is_enclosure(ext,mn,nv) else 0     # keep skyboxes, tagged so viewer can toggle them
        walk_dl_groups(a04,po+dl_rel,po+0x28,po+dl_rel,groups,xform=None,sky=sky,state=tstate,extkey=pi,rt_inherit=False)
    # partpool: unique referenced parts, LOCAL geometry (shared across instances).
    # Some object sub-parts (e.g. the dino's inner-mouth/jaw pieces) carry NO SETTIMG of their own — on real
    # HW they inherit the texture the object bound a draw earlier (RDP state persists). Walked in isolation they
    # come out untextured -> flat GREY faces. Fix: seed a textureless part's walk with the final RDP tile state
    # of the NEAREST self-textured referenced part (same object cluster), so it inherits that texture.
    partpos={}
    for r in recs:
        if r["kind"] in (1,2): partpos.setdefault(r["id"], r["pos"])
    valid=[]
    for pi in sorted(refparts):
        if pi>=len(pd): continue
        po,ps,pc=pd[pi]
        if ps<0x40: continue
        dl_rel=u32(a04,po)
        if not (0x28<=dl_rel<ps): continue
        if is_enclosure(*part_extent(a04,po,ps)): continue
        valid.append(pi)
    def refwalk(pi, seed):
        po,ps,pc=pd[pi]; dl_rel=u32(a04,po); pg={}; st=dict(seed) if seed else {}
        walk_dl_groups(a04,po+dl_rel,po+0x28,po+dl_rel,pg,xform=None,extkey=('p',pi),state=st,rt_inherit=False)
        return pg,st
    finalst={}; selftex={}
    for pi in valid:
        pg,st=refwalk(pi,None); finalst[pi]=st; selftex[pi]=any(g["ti"]>=0 for g in pg.values())
    def d2(a,b): return (a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2
    SEED_CAP2=3500*3500   # inherit from nearest textured part within a large multi-part object's reach
                          # (e.g. the dino: mouth-front teeth at X5785 inherit from the jaw at X8600, ~2860u)
    partpool=[]; partidx={}
    for pi in valid:
        seed=None
        if not selftex[pi] and pi in partpos:
            cands=[(d2(partpos[pi],partpos[q]),q) for q in valid if selftex.get(q) and q in partpos and q!=pi]
            if cands:
                dd,q=min(cands)
                if dd<=SEED_CAP2: seed=finalst[q]
        pg,st=refwalk(pi,seed)
        if _is_map_plane(pg): continue   # flat map-spanning void/clip plane -> the 'giant square' cutting the map
        pk,nt=pack_part(pg,animmap)
        if pk and nt>=1:
            partidx[('04',pi)]=len(partpool); partpool.append({"part":pi,"ext":0,"g":pk,"nt":nt})
    # kind-0 EXTERNAL objects -> geometry from assets03[id] (the dock's two states = id44/id45, crates, etc.)
    for eid in sorted(set(r["id"] for r in recs if r["kind"]==0)):
        blob=get_a03(eid)
        if not blob: continue
        try: g=a03_groups(blob)
        except Exception: g=None
        if not g or _is_map_plane(g): continue
        pk,nt=pack_part(g,animmap)
        # skip external objects with NO decodable texture (e.g. id51 = 2-tri runtime-textured water/collision
        # plane) -> they'd render as flat grey slabs; better omitted than shown wrong.
        if pk and nt>=1 and any(gg.get("ti",-1)>=0 for gg in pk):
            partidx[('03',eid)]=len(partpool); partpool.append({"part":eid,"ext":1,"g":pk,"nt":nt})
    # props: one instance per placement record. Co-located records (same world pos) = state variants of one
    # object (a swap). BUT pos==(0,0,0) is a SENTINEL for runtime-positioned objects (their world pos comes
    # from a behavior/script) -> those are NOT really co-located; give each its own group so distinct objects
    # aren't lumped as fake "states" of each other.
    def reckey(r):
        if r["kind"] in (1,2): return ('04',r["id"])
        if r["kind"]==0: return ('03',r["id"])
        return None
    # beh-0x19 is NOT "flashing panel" -- it's the generic RUNTIME-ANIMATED-TEXTURE-SURFACE behavior. The game
    # binds a texture set to an RSP segment at spawn; WHICH set depends on the level. Confirmed cases:
    #   chunk 23  -> the flashing screen panels: 3-frame set 0x102/3/4, tinted per-panel by vertex colour.
    #   water chunks (6/7/18/41/59/65) -> the caustic ripple set (same one the terrain water uses). These
    #     parts are large HORIZONTAL untextured pools/rivers; painting the panel set on them was the bug
    #     that made Conker's water look like white noise (part 11 texid 0x102).
    # Any other chunk's beh-0x19 parts bind a set we can't recover -> leave them inherited/untextured (never
    # the panel noise). Chunk 23 is also in WATER_CHUNKS, so the panel branch is checked first.
    b19=[r for r in recs if (r["beh"]&0xffffffff)==0x19]
    if b19 and level==23:
        pf=panel_frames()
        if pf:
            for r in b19:
                k=reckey(r)
                if k is None or k not in partidx: continue
                for g in partpool[partidx[k]]["g"]:
                    if g.get("ti",-1)<0:
                        g["ti"]=pf[0]; g["anim"]=pf; g["aspd"]=3; g["mod"]=1
    elif b19 and level in WATER_CHUNKS:
        wf=rt_water()
        if wf:
            for r in b19:
                k=reckey(r)
                if k is None or k not in partidx: continue
                for g in partpool[partidx[k]]["g"]:
                    # caustic water on EVERY untextured beh-0x19 surface. In a water chunk these are all water:
                    # horizontal pools/rivers AND vertical waterfalls/sheets (probe: their vertex colour is
                    # white/cyan/green -- water-tinted, never rock-brown). Shown opaque + flowing (aspd 4).
                    if g.get("ti",-1)<0:
                        g["ti"]=wf[0]; g["anim"]=wf; g["aspd"]=4; g["rt"]=1
    from collections import defaultdict
    bypos=defaultdict(list); solo=0
    for ri,r in enumerate(recs):
        k=reckey(r)
        if k is None or k not in partidx: continue
        if tuple(r["pos"])==(0,0,0): solo+=1; bypos[("solo",solo)].append(r)
        else: bypos[tuple(r["pos"])].append(r)
    props=[]; proptris=0
    for gi,(pos,rs) in enumerate(bypos.items()):
        has0=any(r["state"]==0 for r in rs)
        for r in rs:
            # Show state-0 (or all, if no state-0 here). Do NOT hide pos==(0,0,0) props: many levels bake their
            # main geometry into (0,0,0)-placed parts whose vertices already carry world coords, so hiding them
            # made "most of Level 21 disappear". They render at origin either way; showing is correct.
            vis=1 if (r["state"]==0 or not has0) else 0
            pp=partidx[reckey(r)]
            props.append({"pp":pp,"pos":list(r["pos"]),"rot":list(r["rot"]),
                          "sc":[round(x,3) for x in r["scale"]],"grp":gi,"st":int(r["state"]),"id":int(r["id"]),
                          "ext":partpool[pp]["ext"],"beh":r["beh"],"init":r["init"],"fl":int(r["flags"]),"vis":vis})
            if vis: proptris+=partpool[pp]["nt"]
    return {"groups":groups,"partpool":partpool,"props":props,"proptris":proptris}
# ---------- animated textures ----------
def load_animmap():
    """D_80089324: framePtr records -> each points to a NUL/terminated array of frame texids.
       Levels reference ANY frame in a sequence (not just frame0), and the game cycles the whole
       set at runtime, so map EVERY frame texid -> the full ordered frame list."""
    gd=rom.game_data()
    VRAM=0x80082B20; m={}; base=0x6804
    for k in range(24):
        o=base+k*0xC
        if o+0xC>len(gd): break
        fp=u32(gd,o); f1=u32(gd,o+4)
        if fp<VRAM or fp-VRAM+4>len(gd): continue
        cnt=(f1>>24)&0xFF               # frame count = high byte of f1 (was over-reading before)
        if cnt<2 or cnt>32: continue
        fo=fp-VRAM
        if fo+cnt*4>len(gd): continue
        frames=[u32(gd,fo+j*4) for j in range(cnt)]
        if all(0<t<0x2000 for t in frames):
            for f in frames:
                if f not in m: m[f]=frames   # any frame -> whole set
    return m
def anim_group_map(groups, animmap):
    out={}
    idx2key={v:k for k,v in TEXKEY.items() if v>=0}
    for g in groups.values():
        ti=g["ti"]
        if ti<0 or ti not in idx2key or ti in out: continue
        texid,W,H=idx2key[ti]
        if texid in animmap:
            frames=[]
            for ftid in animmap[texid]:
                fi=tex_index(ftid,W,H)
                if fi>=0: frames.append(fi)
            if len(frames)>=2: out[ti]=frames
    return out
# ---------- character ATTACHMENT / socketing system ----------
# D_80086CC4 (game.data.bin) = attachment-definition table: per attachable-object-id, {records_ptr, count<<24}.
# Each 0x10-byte record @ D_8009Cxxx = {u8 model, u8 bone(slot), u8 slot, u8 type, ..., s16 offX@8/Y@A/Z@C,
# u8 chainParent@E, u8 chainBone@F}. The `model` id indexes assets01 (same pool as characters); the part is
# mounted on the PARENT character's bone[bone] world matrix + offset. (Traced 2026-07-24; which object attaches
# to whom is runtime, but the DEFINITIONS here are static -> a viewer "attach any part to any bone" system.)
def build_attachments():
    gd=rom.game_data()
    VB=0x80082B20; TABLE=0x80086CC4-VB
    def gs16(o): return struct.unpack('>h',gd[o:o+2])[0]
    out=[]; cache={}
    for i in range(120):
        e=TABLE+i*8
        if e+8>len(gd): break
        ptr=u32(gd,e); cw=u32(gd,e+4); count=cw>>24
        if not (0x80090000<=ptr<0x800A2000) or count<1 or count>16: break
        parts=[]
        for r in range(count):
            b=(ptr-VB)+r*0x10
            if b+0x10>len(gd): continue
            model=gd[b]; bone=gd[b+1]; off=[gs16(b+8),gs16(b+0xA),gs16(b+0xC)]
            if model not in cache:
                try: g,sk=build_a01_object(model)
                except Exception: g=None
                it=pack_item(f"attach·a01·{model}", f"assets01 model {model}", "attach", g, allow_cull=True) if g else None
                cache[model]=it["groups"] if it else None
            grps=cache[model]
            if not grps: continue
            parts.append({"model":model,"bone":bone,"off":off,"g":grps})
        if parts: out.append({"oid":i+1,"parts":parts})
    return out
# ---------- main ----------
def main():
    animmap=load_animmap()
    print(f"anim texture sets: {len(animmap)}")
    characters=[]; objects=[]; levels=[]; posable=[]
    # CHARACTERS = assets01 world models (Conker, creatures, bosses) — these render cleanly (bind pose works)
    for id in range(187):
        try: g,is_skel=build_a01_object(id)
        except Exception: g=None
        if not g: continue
        item=pack_item(f"a01·{id:03d}", f"assets01 · model {id}", "character", g, allow_cull=True)
        if not item or item["ntri"]<12: continue
        if item["_coh"]<0.45: continue   # validate the model renders clean (garbage rigs excluded)
        # Baked 'characters' gallery DROPPED — the Pose/Rig tab supersedes it (same characters, rigged +
        # textured + animated), freeing ~1.6MB for more animation clips. Item above is only a quality gate.
        # POSABLE = skeleton + bone-local verts for the live Pose / Rig tab
        try: pm=build_a01_posable(id)
        except Exception: pm=None
        if pm and len(pm["bones"])>=2:
            pm["name"]=f"model {id:03d}"; posable.append(pm)
    # OBJECTS = assets03 + assets09 props/items/heads
    objfiles=[('03',n,b) for n,b in rom.subfiles(0x03)]+[('09',n,b) for n,b in rom.subfiles(0x09)]
    for tag,base,blob in objfiles:
        try: g,is_skel=build_object(blob)
        except Exception: g,is_skel=None,False
        if not g: continue
        item=pack_item(f"a{tag}·{base}", f"assets{tag} · {base}", "object", g, allow_cull=True)
        if not item or item["ntri"]<12: continue
        coh=item["_coh"]
        if coh<0.50: continue
        if is_skel and coh<0.68: continue   # tangled rigid-skinned rigs (assets09) need animation to pose
        item.pop("_soup",None)
        objects.append(item)
    # levels: ALL of them
    top=parse_dir(rom.group_bytes(0x04))
    lvlcand=[]
    for sub in range(len(top)):
        try: lv=build_level(sub,animmap)
        except Exception: lv=None
        if not lv: continue
        g=lv["groups"]
        am=anim_group_map(g,animmap)
        item=pack_item(f"sub{sub}",f"assets04 chunk {sub}","level",g,am)
        # terrain may now be sparse (placed parts moved to props); accept if terrain+visible-props >=300
        total=(item["ntri"] if item else 0)+lv["proptris"]
        if not item and total>=300:   # terrain too small for pack_item but props carry it -> minimal item
            item={"name":f"sub{sub}","src":"","kind":"level","groups":[],"ntri":0,"_soup":0,"_coh":1.0}
        if item and total>=300:
            item.pop("_soup",None); item.pop("_coh",None); item["_sub"]=sub
            item["partpool"]=lv["partpool"]; item["props"]=lv["props"]; item["ntri"]=total
            lvlcand.append(item)
    lvlcand.sort(key=lambda m:m["_sub"])
    for i,m in enumerate(lvlcand):
        m["name"]=f"Level {i+1:02d}"; m["src"]=f"assets04 chunk {m['_sub']:02d} · {m['ntri']:,} tris"; del m["_sub"]; levels.append(m)
    # clean-and-detailed first; soupy ones (low coherence) sink to the bottom of the list
    def sortkey(m): return (0 if m["_coh"]>=0.70 else 1, -m["ntri"])
    objects.sort(key=sortkey); characters.sort(key=sortkey)
    for m in objects+characters: m.pop("_coh",None)
    # sort posable to match the visible Characters ordering feel (most detailed first)
    posable.sort(key=lambda m:-m["ntri"])
    # texmeta per texture, shaped EXACTLY as the viewer reads it: [texid, fmt, siz, flag, assetBytes]
    # (TEXMETA stores (texid,W,H,fmt,siz,flag,len,fname)). Drives the inspector's id/format/bytes rows AND
    # the smooth-alpha (RGBA32/IA) blend path in decodeGroup/procGroup. Was missing -> inspector showed 0x0.
    texmeta=[[m[0],m[3],m[4],m[5],m[6]] for m in TEXMETA]
    try: attachments=build_attachments()
    except Exception as e: print("attachments err",e); attachments=[]
    print(f"attachments: {len(attachments)} objects")
    data={"textures":TEX,"texmeta":texmeta,"characters":characters,"objects":objects,"levels":levels,"posable":posable,"attachments":attachments}
    json.dump(data,open('textured.json','w'),separators=(',',':'))
    json.dump(TEXMETA,open('texmeta.json','w'))
    print(f"textures={len(TEX)} characters={len(characters)} objects={len(objects)} levels={len(levels)} posable={len(posable)} file={os.path.getsize('textured.json')//1024}KB")
    print("tex outcomes:",TXFAIL)
if __name__=='__main__': main()
