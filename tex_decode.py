import struct, zlib, sys
from rom import get_asset
# ---------- helpers ----------
def rgba16_px(v):
    r=((v>>11)&0x1F); g=((v>>6)&0x1F); b=((v>>1)&0x1F); a=v&1
    return (r*255//31, g*255//31, b*255//31, 255 if a else 0)
def deswizzle(data,w,h,bpp_bytes):
    # N64 LoadBlock: odd rows have their two 32-bit halves swapped within each 64-bit word
    rowbytes=int(round(w*bpp_bytes)); out=bytearray(rowbytes*h)
    for y in range(h):
        s=y*rowbytes; row=bytearray(data[s:s+rowbytes])
        if y%2==1:
            for b in range(0,rowbytes,8):
                if b+8<=rowbytes:
                    row[b:b+4],row[b+4:b+8]=bytes(data[s+b+4:s+b+8]),bytes(data[s+b:s+b+4])
        out[s:s+rowbytes]=row
    return out
def _guard_opaque(out,n):
    # if almost everything is transparent, the alpha bit isn't real coverage -> force opaque
    trans=sum(1 for i in range(n) if out[i*4+3]<128)
    if trans> n*0.90:
        for i in range(n): out[i*4+3]=255
    return out
# ---------- explicit format decoders (with real alpha) ----------
def dec_rgba16(data,w,h):
    d=deswizzle(data[:w*h*2],w,h,2); n=w*h; out=bytearray(n*4)
    for i in range(n):
        if i*2+2>len(d): break
        v=struct.unpack('>H',d[i*2:i*2+2])[0]; r,g,b,a=rgba16_px(v)
        out[i*4]=r;out[i*4+1]=g;out[i*4+2]=b;out[i*4+3]=a
    return _guard_opaque(out,n)
def dec_rgba32(data,w,h):
    n=w*h; d=data[:n*4]; out=bytearray(n*4)
    for i in range(min(n,len(d)//4)):
        out[i*4]=d[i*4];out[i*4+1]=d[i*4+1];out[i*4+2]=d[i*4+2];out[i*4+3]=d[i*4+3]
    return out
def dec_ci8(data,w,h):
    n=w*h; tlut=data[-512:]   # TLUT is the LAST 512 bytes (after indices + any mip levels)
    sw=((w+7)//8)*8           # N64 TMEM rows are 8-byte aligned (CI8=1 byte/texel) -> NPOT widths pad up
    if sw*h > len(data)-512: sw=w   # data isn't padded (tight/mip) -> fall back to tight rows
    idx=deswizzle(data[:sw*h],sw,h,1)
    pal=[rgba16_px(struct.unpack('>H',tlut[i*2:i*2+2])[0]) if i*2+2<=len(tlut) else (0,0,0,0) for i in range(256)]
    out=bytearray(n*4)
    for y in range(h):
        for x in range(w):
            si=y*sw+x; oi=(y*w+x)*4; p=pal[idx[si]] if si<len(idx) else (0,0,0,0)
            out[oi]=p[0];out[oi+1]=p[1];out[oi+2]=p[2];out[oi+3]=p[3]
    return _guard_opaque(out,n)
def dec_ci4(data,w,h):
    n=w*h; tlut=data[-32:]   # TLUT is the LAST 32 bytes (after indices + any mip levels)
    rb=(w+1)//2; sb=((rb+7)//8)*8; sw=sb*2   # 8-byte-aligned rows (CI4=0.5 byte/texel) -> padded pixel width
    if sb*h > len(data)-32: sw=w; sb=(w+1)//2   # not padded -> tight
    idxb=deswizzle(data[:sb*h],sw,h,0.5)
    pal=[rgba16_px(struct.unpack('>H',tlut[i*2:i*2+2])[0]) if i*2+2<=len(tlut) else (0,0,0,0) for i in range(16)]
    out=bytearray(n*4)
    for y in range(h):
        for x in range(w):
            i=y*sw+x; bi=i//2
            if bi>=len(idxb): continue
            b=idxb[bi]; ix=(b>>4) if (i%2==0) else (b&0xF); p=pal[ix]; oi=(y*w+x)*4
            out[oi]=p[0];out[oi+1]=p[1];out[oi+2]=p[2];out[oi+3]=p[3]
    return _guard_opaque(out,n)
def dec_ia16(data,w,h):
    n=w*h; d=deswizzle(data[:n*2],w,h,2); out=bytearray(n*4)
    for i in range(n):
        if i*2+2>len(d): break
        g=d[i*2]; a=d[i*2+1]; out[i*4]=out[i*4+1]=out[i*4+2]=g; out[i*4+3]=a
    return out
def dec_ia8(data,w,h):
    n=w*h; d=deswizzle(data[:n],w,h,1); out=bytearray(n*4)
    for i in range(min(n,len(d))):
        v=d[i]; g=(v>>4)*17; a=(v&0xF)*17; out[i*4]=out[i*4+1]=out[i*4+2]=g; out[i*4+3]=a
    return out
def dec_ia4(data,w,h):
    n=w*h; d=deswizzle(data[:n//2],w,h,0.5); out=bytearray(n*4)
    for i in range(n):
        if i//2>=len(d): break
        b=d[i//2]; nyb=(b>>4) if (i%2==0) else (b&0xF)
        I=((nyb>>1)&7)*36; a=255 if (nyb&1) else 0
        out[i*4]=out[i*4+1]=out[i*4+2]=I; out[i*4+3]=a
    return out
def dec_i8(data,w,h):
    n=w*h; d=deswizzle(data[:n],w,h,1); out=bytearray(n*4)
    for i in range(min(n,len(d))):
        g=d[i]; out[i*4]=out[i*4+1]=out[i*4+2]=g; out[i*4+3]=255
    return out
def dec_i4(data,w,h):
    n=w*h; d=deswizzle(data[:n//2],w,h,0.5); out=bytearray(n*4)
    for i in range(n):
        if i//2>=len(d): break
        b=d[i//2]; nyb=(b>>4) if (i%2==0) else (b&0xF); g=nyb*17
        out[i*4]=out[i*4+1]=out[i*4+2]=g; out[i*4+3]=255
    return out
# fmt: 0 RGBA,2 CI,3 IA,4 I ; siz: 0 4b,1 8b,2 16b,3 32b
def decode_fmt(data,w,h,fmt,siz):
    if not data or w<=0 or h<=0: return None,None
    try:
        if fmt==0 and siz==2: return dec_rgba16(data,w,h),'RGBA16'
        if fmt==0 and siz==3: return dec_rgba32(data,w,h),'RGBA32'
        if fmt==2 and siz==1: return dec_ci8(data,w,h),'CI8'
        if fmt==2 and siz==0: return dec_ci4(data,w,h),'CI4'
        if fmt==3 and siz==2: return dec_ia16(data,w,h),'IA16'
        if fmt==3 and siz==1: return dec_ia8(data,w,h),'IA8'
        if fmt==3 and siz==0: return dec_ia4(data,w,h),'IA4'
        if fmt==4 and siz==1: return dec_i8(data,w,h),'I8'
        if fmt==4 and siz==0: return dec_i4(data,w,h),'I4'
    except Exception: return None,None
    return None,None
def decode_texture(data,w,h,fmt=None,siz=None,flag=0):
    """Decode an N64 texture. CI-ness comes from the SETTIMG flag (authoritative in Conker);
       bit-depth is chosen by asset byte-size (robust to mipmapped assets, where the base
       level is the first n*bpp bytes and the palette/mips trail after). SETTILE fmt only
       disambiguates same-size formats (RGBA16 vs IA16, I vs IA). Returns (rgba,fmtname)."""
    if not data or w<=0 or h<=0: return None,None
    n=w*h; L=len(data)
    try:
        # CI: flag is authoritative; TLUT lives at the asset end
        if flag==0x400000: return dec_ci8(data,w,h),'CI8'
        if flag==0x800000: return dec_ci4(data,w,h),'CI4'
        if fmt==2 and siz==1: return dec_ci8(data,w,h),'CI8'
        if fmt==2 and siz==0: return dec_ci4(data,w,h),'CI4'
        # non-CI: pick the largest base bit-depth whose base level fits the asset
        #  (asset = base + optional mip chain, so L is between base and ~1.5*base). Lower bound 0.90 (not 0.94)
        #  so a texture stored a couple of trailing rows short still lands in its real band instead of the
        #  rgba16? rainbow fallback (e.g. 0x6a1 = IA8 16x32 = 480 bytes = 0.9375*512; the missing 32 bytes /
        #  bottom 2 rows decode transparent). Bands stay non-overlapping at 0.90 (verified: 4b<=0.775n<0.9n).
        for base,depth in ((n*4,32),(n*2,16),(n,8),(n//2,4)):
            if base>0 and 0.90*base<=L<=1.55*base:
                if depth==32: return dec_rgba32(data,w,h),'RGBA32'
                if depth==16: return (dec_ia16(data,w,h),'IA16') if fmt==3 else (dec_rgba16(data,w,h),'RGBA16')
                if depth==8:  return (dec_ia8(data,w,h),'IA8') if fmt==3 else (dec_i8(data,w,h),'I8')
                if depth==4:  return (dec_ia4(data,w,h),'IA4') if fmt==3 else (dec_i4(data,w,h),'I4')
        # last resort: rgba16 on whatever we have
        return dec_rgba16(data,w,h),'rgba16?'
    except Exception: return None,None
def write_png_rgba(path,w,h,rgba):
    def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    raw=bytearray()
    for y in range(h): raw.append(0); raw+=rgba[y*w*4:(y+1)*w*4]
    open(path,'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+ch(b'IDAT',zlib.compress(bytes(raw),9))+ch(b'IEND',b''))
