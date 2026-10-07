"""
Conker (N64) animation keyframe EXTRACTOR — end to end from the ROM.

Data location (resolved from func_1502AF04 / D_AB1950 archive @ ROM 0xAB1950):
  assets_offsets_table.bin == the 0xAB1950 root dir (group -> ROM {off,len}).
  Group assets02 (ROM 0x0BB1BA0) holds the bit-packed animation CLIP PACKS,
  UNCOMPRESSED. Each non-empty assets02 dir entry = ONE character's clip pack:
      [ clip directory : {u32 off, u32 len} * numClips ]   (numClips = dir[0].off/8)
      [ clip 0 ][ clip 1 ] ...     (each clip self-contained: header + keyframe stream)
  Clip elementCount (header[1]) == that character's animated element count
  (Conker model 3 == 28 -> assets02 entry 5).

Decoder == the locked func_150A8A18 format (header + MSB bitstream, verbatim, no
transcode). This module reads directly from baserom.us.z64.
"""
import struct, os
from rom import ROM as d
u32=lambda o: struct.unpack('>I',d[o:o+4])[0]
u16=lambda o:(d[o]<<8)|d[o+1]
s8 =lambda o: struct.unpack('b',d[o:o+1])[0]
ASSETS_TABLE=0xAB1950   # ROM base of the root archive directory

def group_rom(idx):
    """ROM (base,len) of assets group idx from the 0xAB1950 root dir."""
    off=u32(ASSETS_TABLE+idx*8); ln=u32(ASSETS_TABLE+idx*8+4)
    return ASSETS_TABLE+off, ln

def pack_entry(group_idx, entry_idx):
    """ROM base+len of one dir entry (a character clip pack) within a group."""
    gbase,_=group_rom(group_idx)
    fo=u32(gbase); assert entry_idx< fo//8
    off=u32(gbase+entry_idx*8); szc=u32(gbase+entry_idx*8+4)
    return gbase+off, szc&0xFFFFFFF, szc>>28

def clip_dir(pack_base):
    """List of (clipOff_abs, clipLen) for all clips in a pack."""
    n=u32(pack_base)//8
    out=[]
    for i in range(n):
        off=u32(pack_base+i*8); ln=u32(pack_base+i*8+4)
        out.append((pack_base+off, ln))
    return out

# ---- decoder ----
def parse_header(off):
    ec=d[off+1]; stride=d[off+5]; w6=d[off+6]; w7=d[off+7]; flags=w7&0xF0
    Xw=w6>>4;Yw=w6&0xF;Zw=w7&0xF
    slots=[(Xw,(s8(off)<<12)&0xFFFF,'m'),(Yw,(s8(off+2)<<12)&0xFFFF,'m'),(Zw,(s8(off+4)<<12)&0xFFFF,'m')]
    cw=off+0xA
    if flags&0x40: cw+=2
    if flags&0x20: cw+=2
    mask=0
    if flags&0x80: mask=((ec-1)+15)//16; cw+=mask*2
    for _ in range(3*(ec-1)):
        c=u16(cw); cw+=2; slots.append((c&0xF,c&0xFFF0,'m'))
        if c&0x10:
            c2=u16(cw); cw+=2; slots.append((c2&0xF,c2&0xFFF0,'s'))
    return dict(ec=ec,stride=stride,flags=flags,interval=d[off+8]+1,slots=slots,cwEnd=cw,maskwords=mask)

class BR:
    def __init__(s,off): s.p=off; s.acc=0; s.n=0
    def read(s,k):
        if k==0:return 0
        while s.n<k: s.acc=(s.acc<<8)|d[s.p]; s.p+=1; s.n+=8
        s.n-=k; return (s.acc>>s.n)&((1<<k)-1)

def sext(v,b): m=1<<(b-1); return (v^m)-m

def animations(pack_base):
    """Pair the {header,stream} directory entries -> list of (hdrOff, streamOff, streamLen)."""
    dirs=clip_dir(pack_base)
    anims=[]
    for i in range(0, len(dirs)-1, 2):
        (hoff,hlen)=dirs[i]; (soff,slen)=dirs[i+1]
        anims.append((hoff, soff, slen))
    return anims

def decode_anim(hdr_off, stream_off, stream_len):
    """Decode a full animation: header block + separate keyframe stream block."""
    h=parse_header(hdr_off)
    stride=h['stride']
    nkf = 1 if stride==0 else max(1, stream_len//stride)
    frames=[]
    so=stream_off
    for k in range(nkf):
        r=BR(so+k*stride); main=[]
        for (w,base,ch) in h['slots']:
            A=r.read(w); ang=(base+(A<<5))&0xFFFF
            if ch=='m': main.append(ang)
        frames.append([tuple(main[i:i+3]) for i in range(0,len(main)-2,3)])
    return dict(header=h, nkf=nkf, frames=frames, nelem=len(frames[0]) if frames else 0)

def sdeg(a): v=(a+32768)%65536-32768; return v*360.0/65536.0

# ---- clean reusable API for the viewer's Pose/Rig tab ----
def list_packs(group_idx=2):
    """Return {packEntry: (ec, numAnims, romBase)} for every non-empty clip pack."""
    gbase,_=group_rom(group_idx); n=u32(gbase)//8; out={}
    for i in range(n):
        off=u32(gbase+i*8); szc=u32(gbase+i*8+4)
        if (szc&0xFFFFFFF)==0 or (szc>>28)!=0: continue
        base=gbase+off; d0=u32(base)
        if d0<8 or d0%8 or d0>0x8000: continue
        try: ec=d[base+d0+1]
        except: continue
        out[i]=(ec, (d0//8)//2, base)
    return out

def extract(pack_entry, anim_index, group_idx=2):
    """Return {'nbones','nkeyframes','tracks'} where tracks[bone] = list over
       keyframes of (ax,ay,az) as 16-bit BAM (theta = bam*2*pi/65536)."""
    base,_,_=pack_entry_(group_idx, pack_entry)
    an=animations(base)
    ho,so,sl=an[anim_index]
    r=decode_anim(ho,so,sl)
    tracks=[[r['frames'][k][b] for k in range(r['nkf'])] for b in range(r['nelem'])]
    return dict(nbones=r['nelem'], nkeyframes=r['nkf'], stride=r['header']['stride'],
                interval=r['header']['interval'], flags=r['header']['flags'], tracks=tracks)

def pack_entry_(group_idx, entry_idx):
    return pack_entry(group_idx, entry_idx)

if __name__=='__main__':
    import statistics
    GROUP=2
    for ENTRY,label in [(5,'Conker/model3 (ec28)')]:
        base,ln,comp=pack_entry(GROUP,ENTRY)
        anims=animations(base)
        print(f"=== assets{GROUP:02X} entry{ENTRY} {label}: ROM {base:#x} : {len(anims)} animations ===")
        for ai,(ho,so,sl) in enumerate(anims):
            h=parse_header(ho); nkf=1 if h['stride']==0 else max(1,sl//h['stride'])
            print(f"  anim{ai}: hdr@{ho:#x} stream@{so:#x} slen={sl:#x} ec={h['ec']} stride={h['stride']} flags={h['flags']:#x} keyframes={nkf} (cwEnd={h['cwEnd']:#x} matches stream? {h['cwEnd']==so})")
        print("\n--- Conker ANIMATION 0 decoded ---")
        r=decode_anim(*anims[0])
        print(f"elements={r['nelem']} keyframes={r['nkf']} stride={r['header']['stride']} flags={r['header']['flags']:#x}")
        N=r['nkf']; fr=r['frames']
        def cur(el,ax): return [round(sdeg(fr[k][el][ax])) for k in range(N)]
        for el in range(r['nelem']):
            xs,ys,zs=cur(el,0),cur(el,1),cur(el,2)
            if any(xs) or any(ys) or any(zs):
                print(f"  bone{el:2}: X={xs}")
                print(f"          Y={ys}")
                print(f"          Z={zs}")
        jumps=[]
        for el in range(r['nelem']):
            for ax in range(3):
                c=[sdeg(fr[k][el][ax]) for k in range(N)]
                for k in range(1,N): jumps.append(abs(((c[k]-c[k-1]+180)%360)-180))
        if jumps:
            print(f"\nframe-to-frame jump (deg): median={statistics.median(jumps):.1f} mean={statistics.mean(jumps):.1f} p90={sorted(jumps)[int(0.9*len(jumps))]:.1f} max={max(jumps):.1f}")
