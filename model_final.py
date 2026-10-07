import sys, zlib, struct, json
def runzip(d):
    try: return zlib.decompressobj(wbits=-15).decompress(d[4:])
    except: return None
def u32(d,o): return struct.unpack('>I',d[o:o+4])[0]
def s16(d,o): return struct.unpack('>h',d[o:o+2])[0]
def parse_dir(b):
    if len(b)<8: return None
    fo=u32(b,0)
    if fo==0 or fo%8 or fo>len(b) or fo>0x8000: return None
    return [(u32(b,i*8),u32(b,i*8+4)&0xFFFFFFF,(u32(b,i*8+4)>>28)&0xF) for i in range(fo//8)]
def tri_of(op,w0,w1):
    if op==0x05: return [(((w0>>16)&0xFF)>>1,((w0>>8)&0xFF)>>1,(w0&0xFF)>>1)]
    if op==0x06: return [((w0>>17)&0x1F,(w0>>9)&0x1F,(w0>>1)&0x1F),((w1>>17)&0x1F,(w1>>9)&0x1F,(w1>>1)&0x1F)]
    return [((w1>>25)&0x1F,(w1>>20)&0x1F,(w1>>15)&0x1F),((w1>>10)&0x1F,(w1>>5)&0x1F,w1&0x1F),
            ((w0>>10)&0x1F,(w0>>5)&0x1F,w0&0x1F),((w0>>23)&0x1F,(w0>>18)&0x1F,((w1>>30)&0x3)|((w0>>13)&0x1C))]
# extract one LEVEL-format part: [0x28 hdr][verts][DL]
def extract_part(data, part_off, part_size):
    if part_size < 0x40: return None
    dl_rel = u32(data, part_off)
    if not (0x28 <= dl_rel < part_size): return None
    dl_start = part_off + dl_rel
    vtx_base = part_off + 0x28
    part_end = part_off + part_size
    # walk DL
    V=[]; F=[]; slot={}; grp=0; i=dl_start; nc=0; sawvtx=False
    while i+8 <= part_end:
        w0=u32(data,i); w1=u32(data,i+4); op=w0>>24
        if op==0xDF:
            break
        if op==0x01:
            n=(w0>>12)&0xFF; end=(w0>>1)&0x7F; start=end-n
            if n==0 or n>32 or start<0 or end>32: return None  # invalid -> not this format
            voff=w1&0xFFFFFF
            sawvtx=True
            for k in range(n):
                vo=vtx_base+voff+k*16
                if vo+6<=len(data):
                    V.append((s16(data,vo),s16(data,vo+2),s16(data,vo+4))); slot[start+k]=len(V)-1
            grp+=1
        elif op==0x05 or op==0x06 or 0x10<=op<=0x1F:
            for (a,b,c) in tri_of(op,w0,w1):
                if a in slot and b in slot and c in slot and a!=b and b!=c and a!=c:
                    F.append((slot[a],slot[b],slot[c],grp))
        i+=8; nc+=1
        if nc>20000: return None
    if not sawvtx or len(F)<2: return None
    return V,F,grp,dl_start
def build_model(data, part_off, part_size, name, src):
    r=extract_part(data,part_off,part_size)
    if not r: return None
    V,F,ngrp,dl_start=r
    # drop INT16_MIN sentinel verts
    def bad(vi):
        x,y,z=V[vi]; return abs(x)>=32760 or abs(y)>=32760 or abs(z)>=32760
    F=[f for f in F if not(bad(f[0])or bad(f[1])or bad(f[2]))]
    if len(F)<2: return None
    used=set()
    for a,b,c,g in F: used.update((a,b,c))
    rm={}; NV=[]
    for idx in sorted(used): rm[idx]=len(NV); NV.append(V[idx])
    NF=[]
    for a,b,c,g in F: NF+= [rm[a],rm[b],rm[c],g]
    flatV=[]
    for v in NV: flatV+= [v[0],v[1],v[2]]
    return {"name":name,"src":src,"off":f"{dl_start:#x}","ngroups":ngrp,"verts":flatV,"faces":NF}
def main():
    path=sys.argv[1]; out=sys.argv[2]
    blob=open(path,'rb').read(); top=parse_dir(blob)
    tag=path.split('/')[-1].replace('.bin','')
    models=[]
    subs = range(len(top)) if len(sys.argv)<=3 else [int(x) for x in sys.argv[3:]]
    for sub in subs:
        o,s,c=top[sub]; data=blob[o:o+s]
        if c:
            dec=runzip(data); data=dec if dec else data
        pd=parse_dir(data)
        if not pd: continue
        for pi,(po,ps,pc) in enumerate(pd):
            if ps==0: continue
            m=build_model(data,po,ps,f"{tag}_s{sub:02d}_p{pi:02d}",f"assets{tag[-2:]} sub{sub} part{pi}")
            if m and len(m["faces"])//4 >= 20:
                models.append(m)
    json.dump(models,open(out,'w'))
    tris=sum(len(m["faces"])//4 for m in models)
    print(f"{tag}: {len(models)} objects, {tris} tris total -> {out}")
if __name__=='__main__':
    main()
