"""Post-process textured.json: attach REAL extracted animation clips to posable characters.
   Dedupes by assets02 clip pack (shared-skeleton characters reference one pack). Pre-filters clip
   length BEFORE decoding so a pathologically long clip can't stall the whole run.
   Mapping rule (validated by offline render): a model with B bones uses the pack with ec in {B,B+1}
   and the MOST animations; angles[rotIndex] = tracks[rotIndex]."""
import json, base64, struct, os
import conker_anim_extract as X
CAP=10**9; SCAN=10**9; MAXKF=600; KFMAX=18  # DUMP ALL animations (no top-N cap, scan every clip in the pack),
                                            # subsample only very long clips to <=KFMAX keyframes for storage
def b64i16(v): return base64.b64encode(struct.pack('<%dh'%len(v),*v)).decode()
def s16(a): a&=0xFFFF; return a-0x10000 if a>=0x8000 else a

print("loading textured.json...",flush=True)
d=json.load(open('textured.json'))
posable=d.get('posable',[])
packs=X.list_packs(2)                       # {entry:(ec,numAnims,romBase)}
byec={}
for entry,(ec,na,base) in packs.items():
    if ec not in byec or na>byec[ec][1]: byec[ec]=(entry,na)

used=set()
for m in posable:
    B=len(m['bones'])
    options=[(ec,byec[ec]) for ec in (B,B+1) if ec in byec]   # (ec,(entry,na))
    if not options: continue
    ec_ch,(entry,na)=max(options,key=lambda o:o[1][1])         # pack with MOST anims = character's main set
    m['pack']=entry; m['aoff']=ec_ch-B; used.add(entry)        # aoff = leading-root offset (0 or 1)
print(f"models assigned; distinct packs used: {len(used)}",flush=True)

animpacks={}
for gi,entry in enumerate(sorted(used)):
    base,_,_=X.pack_entry(2,entry)
    anims=X.animations(base)
    cand=[]; rej_len=0; rej_static=0; rej_garbage=0
    for aid,(ho,so,sl) in enumerate(anims[:SCAN]):       # aid = RAW pack index = the game's animId (D_800D1588 idx)
        h=X.parse_header(ho); stride=h['stride']
        nkf=1 if stride==0 else max(1,sl//stride)
        if nkf<2 or nkf>MAXKF: rej_len+=1; continue      # pre-filter: empty/1-frame or pathologically long
        r=X.decode_anim(ho,so,sl); nel=r['nelem']; nkf=r['nkf']
        if nel<1: rej_len+=1; continue
        nz=[e for e in range(nel) if any((r['frames'][k][e][a]&0xFFFF) for k in range(nkf) for a in range(3))]
        if len(nz)<2: rej_static+=1; continue            # fully-static (not an animation)
        # smoothness gate: reject ONLY decode garbage (random ~180deg angle-wrap spikes); keep fast real anims
        jumps=[]
        for e in nz:
            for a in range(3):
                for k in range(1,nkf):
                    jumps.append(abs(((r['frames'][k][e][a]-r['frames'][k-1][e][a]+0x8000)&0xFFFF)-0x8000)*360.0/65536.0)
        mean=sum(jumps)/len(jumps); mx=max(jumps)
        if mx>180 or mean>18: rej_garbage+=1; continue   # loosened: only truly-broken decodes drop out
        step=1 if nkf<=KFMAX else (nkf+KFMAX-1)//KFMAX   # subsample long clips for storage
        kept=list(range(0,nkf,step))
        cand.append((len(nz),mean,r,kept,nz,max(1,h['interval']*step),aid))
    cand.sort(key=lambda x:(-x[0],x[1]))                 # most full-body first, then smoothest
    clips=[]
    for (score,mean,r,kept,nz,iv,aid) in cand[:CAP]:
        flat=[]
        for k in kept:
            for e in nz:
                ax,ay,az=r['frames'][k][e]; flat+=[s16(ax),s16(ay),s16(az)]
        clips.append({'n':len(kept),'iv':iv,'idx':nz,'d':b64i16(flat),'aid':aid})   # aid = game animId (raw pack idx)
    if clips: animpacks[str(entry)]=clips
    print(f"  [{gi+1}/{len(used)}] pack {entry}: {len(clips)} clips  (of {len(anims)} raw; "
          f"dropped len={rej_len} static={rej_static} garbage={rej_garbage})",flush=True)

d['animpacks']=animpacks
posable.sort(key=lambda m:m.get('id',9999))   # order the Characters list by model # (ascending)
json.dump(d,open('textured.json','w'),separators=(',',':'))
nposed=sum(1 for m in posable if str(m.get('pack')) in animpacks)
print(f"DONE packs={len(animpacks)} clips={sum(len(v) for v in animpacks.values())} "
      f"posable-with-anims={nposed}/{len(posable)} size={os.path.getsize('textured.json')//1024}KB",flush=True)
