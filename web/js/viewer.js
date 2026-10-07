
"use strict";
const V3={sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],scale:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];}};
const M4={mul:(a,b)=>{const o=new Array(16);for(let r=0;r<4;r++)for(let c=0;c<4;c++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;},persp:(f,a,n,fr)=>{const t=1/Math.tan(f/2);return[t/a,0,0,0,0,t,0,0,0,0,(fr+n)/(n-fr),-1,0,0,(2*fr*n)/(n-fr),0];},lookAt:(e,c,u)=>{const f=V3.norm(V3.sub(c,e)),s=V3.norm(V3.cross(f,u)),uu=V3.cross(s,f);return[s[0],uu[0],-f[0],0,s[1],uu[1],-f[1],0,s[2],uu[2],-f[2],0,-V3.dot(s,e),-V3.dot(uu,e),V3.dot(f,e),1];}};
// Data is extracted in-browser from the visitor's own ROM (js/app.js) and handed over here.
let DATA=window.CONKER_DATA||{textures:[],characters:[],objects:[],levels:[]};
let AUDIO=(window.CONKER_AUDIO&&window.CONKER_AUDIO.samples&&window.CONKER_AUDIO.samples.length)?window.CONKER_AUDIO:null;
let ANIMTAB=(window.CONKER_ANIMTAB&&window.CONKER_ANIMTAB.moves&&window.CONKER_ANIMTAB.moves.length)?window.CONKER_ANIMTAB:null;
const CATS=[{id:'posable',label:'Characters'},{id:'objects',label:'Objects'},{id:'levels',label:'Levels'}];
if(DATA.textures&&DATA.textures.length)CATS.push({id:'textures',label:'Textures'});
if(AUDIO)CATS.push({id:'audio',label:'Audio'});
const ANIMSETS=DATA.animsets||[];   // [{frames:[texIdx...], hold, name}] — ground-truth animation sequences
const $=s=>document.querySelector(s);const fmt=n=>n.toLocaleString('en-US');
function b64(b,T){if(typeof b!=='string')return b instanceof T?b:new T(b.buffer,b.byteOffset,b.byteLength/T.BYTES_PER_ELEMENT);const s=atob(b),n=s.length,a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=s.charCodeAt(i);return new T(a.buffer);}
// build renderable arrays from a group (compute smooth normals)
function decodeGroup(g){const col=b64(g.col,Uint8Array);
  // INVISIBLE TRIGGER / ZONE volumes (force-fields, camera & load triggers, kill-planes): untextured geometry
  // painted flat pure-white. The game NEVER draws these (collision/logic only); a naive "draw every placed
  // part" viewer shows them as white blobs on ~24 maps. Tag them so they can be hidden by default. Signature =
  // ti<0 (no texture bound in the DL) + uniformly white vertex colour. Coloured untextured geometry that IS
  // meant to be seen (green dino mouth, blue Level-54 path, teal surfaces) has non-white verts -> NOT tagged.
  let trig=0; if((g.ti==null||g.ti<0)&&col.length){trig=1;for(let i=0;i<col.length;i++){if(col[i]<250){trig=0;break;}}}
  return {ti:g.ti,anim:g.anim||null,aspd:g.aspd||0,aph:g.aph||0,wob:(g.wob==null?null:g.wob),scroll:g.scroll||null,dec:g.dec||0,bl:g.bl||0,al:g.al||0,ac:g.ac||0,ws:g.ws||0,wt:g.wt||0,sky:g.sky||0,mod:g.mod||0,vat:g.vat||0,tg:g.tg||0,trig,va:g.va?b64(g.va,Uint8Array):null,nr:g.nrm?b64(g.nrm,Int8Array):null,tint:g.tint||null,p:b64(g.p,Int16Array),uv:b64(g.uv,Int16Array),col,idx:b64(g.idx,Uint16Array)};}
// Process one decoded group into GPU-ready arrays. local=true keeps LOCAL (part-space) positions so a
// per-prop model matrix can transform them live (state controller); local=false bakes centered/scaled pos.
function procGroup(g,cx,cy,cz,s,local,isLevel){
  const np=g.p.length/3, pos=new Float32Array(np*3), nrm=new Float32Array(np*3), uvf=new Float32Array(np*2), colf=new Float32Array(np*3), vaf=new Float32Array(np);
  for(let i=0;i<np;i++)vaf[i]=g.va?g.va[i]/255:1.0;
  let umin=1e9,umax=-1e9,vmin=1e9,vmax=-1e9;
  for(let i=0;i<np;i++){
    if(local){pos[i*3]=g.p[i*3];pos[i*3+1]=g.p[i*3+1];pos[i*3+2]=g.p[i*3+2];}
    else{pos[i*3]=(g.p[i*3]-cx)*s;pos[i*3+1]=(g.p[i*3+1]-cy)*s;pos[i*3+2]=(g.p[i*3+2]-cz)*s;}
    const u=g.uv[i*2]/512,v=g.uv[i*2+1]/512; uvf[i*2]=u;uvf[i*2+1]=v;
    if(u<umin)umin=u;if(u>umax)umax=u;if(v<vmin)vmin=v;if(v>vmax)vmax=v;
    colf[i*3]=g.col[i*3]/255;colf[i*3+1]=g.col[i*3+1]/255;colf[i*3+2]=g.col[i*3+2]/255;}
  // clamp->repeat when UVs sample outside [0,1]. FAR outside (>1.5)=tiling -> repeat even for alpha surfaces.
  // The "slightly-out -> repeat" rule is for tiled LEVEL geometry; CHARACTERS use slightly-out clamp on purpose
  // (body panels clamp to a texture border) so it must NOT fire on them, or their border wraps to the interior.
  let ws2=g.ws, wt2=g.wt; const _lvl=isLevel;
  if(_lvl && ws2===2 && !g.dec && (umax>1.5||umin<-0.5 || (!g.al && (umax>1.01 || umin<-0.01)))) ws2=0;
  if(_lvl && wt2===2 && !g.dec && (vmax>1.5||vmin<-0.5 || (!g.al && (vmax>1.01 || vmin<-0.01)))) wt2=0;
  // Smooth-alpha formats (RGBA32, IA*) blend instead of hard-cutout.
  let bl3=g.bl; const tm=(DATA.texmeta&&g.ti>=0)?DATA.texmeta[g.ti]:null;
  if(tm && g.al){ const fmt=tm[1],siz=tm[2],flag=tm[3];
    const isCI=(flag===0x400000||flag===0x800000||fmt===2);
    if(!isCI && ((fmt===0&&siz===3)||fmt===3)) bl3=1; }
  // NORMALS: prefer the REAL per-vertex normals from the ROM (assets09 MOVEMEM 0x0E stream; s8 nx,ny,nz). These
  // drive chrome texgen UVs AND lighting (verts are white -> all form comes from these). Fall back to synthesized
  // face normals for geometry that carries none (level terrain, older props).
  if(g.nr){ for(let i=0;i<np;i++){ nrm[i*3]=g.nr[i*3]/127; nrm[i*3+1]=g.nr[i*3+1]/127; nrm[i*3+2]=g.nr[i*3+2]/127; } }
  else{
    for(let t=0;t<g.idx.length;t+=3){const a=g.idx[t],b=g.idx[t+1],c=g.idx[t+2];
      const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2],bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2],cx2=pos[c*3],cy2=pos[c*3+1],cz2=pos[c*3+2];
      let nx=(by-ay)*(cz2-az)-(bz-az)*(cy2-ay),ny=(bz-az)*(cx2-ax)-(bx-ax)*(cz2-az),nz=(bx-ax)*(cy2-ay)-(by-ay)*(cx2-ax);
      for(const vi of [a,b,c]){nrm[vi*3]+=nx;nrm[vi*3+1]+=ny;nrm[vi*3+2]+=nz;}}
  }
  return {ti:g.ti,anim:g.anim,aspd:g.aspd,aph:g.aph,wob:g.wob,scroll:g.scroll,dec:g.dec,bl:bl3,al:g.al,ac:g.ac,ws:ws2,wt:wt2,sky:g.sky,mod:g.mod,vat:g.vat,tg:g.tg,trig:g.trig,litnrm:g.nr?1:0,tint:g.tint,pos,nrm,uv:uvf,col:colf,va:vaf,idx:g.idx,n:g.idx.length};
}
function prep(m){
  if(m._g)return m; m._g=[];
  let cx=0,cy=0,cz=0,nv=0,rad=1e-6;
  const gs=m.groups.map(decodeGroup);
  for(const g of gs){for(let i=0;i<g.p.length;i+=3){cx+=g.p[i];cy+=g.p[i+1];cz+=g.p[i+2];nv++;}}
  if(m.props){for(const pr of m.props){cx+=pr.pos[0];cy+=pr.pos[1];cz+=pr.pos[2];nv++;}}   // frame props too
  nv=Math.max(nv,1); cx/=nv;cy/=nv;cz/=nv;
  for(const g of gs){for(let i=0;i<g.p.length;i+=3){rad=Math.max(rad,Math.hypot(g.p[i]-cx,g.p[i+1]-cy,g.p[i+2]-cz));}}
  if(m.props){for(const pr of m.props){rad=Math.max(rad,Math.hypot(pr.pos[0]-cx,pr.pos[1]-cy,pr.pos[2]-cz));}}
  const s=1.7/rad; m._scale=s; m._cx=cx;m._cy=cy;m._cz=cz;m._s=s;
  for(const g of gs) m._g.push(procGroup(g,cx,cy,cz,s,false,m.kind==='level'));
  if(m.partpool&&m.props){try{prepProps(m,cx,cy,cz,s);}catch(e){console.error('prepProps',e);m._props=null;}}
  return m;
}
// ---- skeletal skinning (Pose / Rig tab) ----
// Row-vector 4x4 math (row-major flat), matching the proven anim_pose pipeline (world = local . parentWorld).
const IDENT=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function rmul(A,B){const R=new Array(16);for(let r=0;r<4;r++)for(let c=0;c<4;c++){let s=0;for(let k=0;k<4;k++)s+=A[r*4+k]*B[k*4+c];R[r*4+c]=s;}return R;}
function bamCS(bam){const a=((bam&0xFFFF)/65536)*6.283185307179586;return [Math.cos(a),Math.sin(a)];}
// Rotation follows the GAME's quaternion pipeline (asm func_150A8918 / func_150A81D0): build Q = qz*qy*qx
// from the three BAM half-angles, interpolate between keyframes by normalized shortest-path lerp (nlerp),
// then Q->matrix. This is euler order Rx*Ry*Rz in our row-vector convention; the old localMat used the
// REVERSED order (Rz*Ry*Rx), which mis-oriented every bone that rotates on 2+ axes.
const IDENTQ=[0,0,0,1];
function bamToQuat(ax,ay,az){           // -> [x,y,z,w]
  const hx=((ax&0xFFFF)/65536)*Math.PI,hy=((ay&0xFFFF)/65536)*Math.PI,hz=((az&0xFFFF)/65536)*Math.PI;
  const cx=Math.cos(hx),sx=Math.sin(hx),cy=Math.cos(hy),sy=Math.sin(hy),cz=Math.cos(hz),sz=Math.sin(hz);
  return [sx*cy*cz-cx*sy*sz, cx*sy*cz+sx*cy*sz, cx*cy*sz-sx*sy*cz, cx*cy*cz+sx*sy*sz];
}
function nlerpQ(a,b,f){                  // game: if dot<0 negate b (shortest path), then lerp + normalize
  const s=(a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3])<0?-1:1;
  let x=a[0]*(1-f)+s*b[0]*f,y=a[1]*(1-f)+s*b[1]*f,z=a[2]*(1-f)+s*b[2]*f,w=a[3]*(1-f)+s*b[3]*f;
  const L=Math.sqrt(x*x+y*y+z*z+w*w)||1; return [x/L,y/L,z/L,w/L];
}
function quatMat(q,tx,ty,tz){            // row-vector rotation matrix + translation (row-major flat)
  const x=q[0],y=q[1],z=q[2],w=q[3];
  return [1-2*(y*y+z*z), 2*(x*y+w*z), 2*(x*z-w*y), 0,
          2*(x*y-w*z), 1-2*(x*x+z*z), 2*(y*z+w*x), 0,
          2*(x*z+w*y), 2*(y*z-w*x), 1-2*(x*x+y*y), 0,
          tx,ty,tz,1];
}
function eulerQuat(x,y,z){               // radians -> [x,y,z,w], SAME XYZ half-angle convention as bamToQuat
  const cx=Math.cos(x/2),sx=Math.sin(x/2),cy=Math.cos(y/2),sy=Math.sin(y/2),cz=Math.cos(z/2),sz=Math.sin(z/2);
  return [sx*cy*cz-cx*sy*sz, cx*sy*cz+sx*cy*sz, cx*cy*sz-sx*sy*cz, cx*cy*cz+sx*sy*sz];
}
function qmul(a,b){ return [             // Hamilton product [x,y,z,w]
  a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
  a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
  a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
  a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2] ]; }
function poseWorld(bones,slot2idx,angles){
  const bc=bones.length,local=new Array(bc),world=new Array(bc).fill(null);
  for(let i=0;i<bc;i++){const b=bones[i],a=angles[b.rot];
    local[i]=(a&&a.q)?quatMat(a.q, b.rx+a.t[0], b.ry+a.t[1], b.rz+a.t[2]):quatMat(IDENTQ, b.rx,b.ry,b.rz);}
  function res(i,d){if(world[i])return world[i];if(d>bc){world[i]=local[i];return world[i];}
    const par=bones[i].par,pj=slot2idx[par];
    world[i]=(par===0xFF||pj===undefined||pj===i)?local[i]:rmul(local[i],res(pj,d+1));return world[i];}
  for(let i=0;i<bc;i++)res(i,0);
  const bySlot={};for(let i=0;i<bc;i++)bySlot[bones[i].slot]=world[i];return bySlot;
}
function preparePosable(m){
  if(m._pose)return m;
  const bones=m.bones.map(b=>({par:b[0],slot:b[1],rot:b[2],rx:b[3],ry:b[4],rz:b[5]}));
  const slot2idx={};bones.forEach((b,i)=>{slot2idx[b.slot]=i;});
  const depth={};
  function dep(slot,g){if(depth[slot]!==undefined)return depth[slot];if(g>bones.length){return depth[slot]=1;}
    const b=bones[slot2idx[slot]];depth[slot]=(!b||b.par===0xFF||slot2idx[b.par]===undefined)?1:1+dep(b.par,g+1);return depth[slot];}
  bones.forEach(b=>dep(b.slot,0));
  const groups=m.groups.map(g=>({ti:g.ti,al:g.al||0,ac:g.ac||0,bl:g.bl||0,dec:g.dec||0,mod:g.mod||0,ws:g.ws||0,wt:g.wt||0,vat:g.vat||0,va:g.va?b64(g.va,Uint8Array):null,n:g.n,
    scroll:g.scroll||null,   // Mechanism C: per-object tile scroll (waterfall/ooze/force-field actor models)
    variant:(g.variant!=null?g.variant:null),   // texture-variant tag (e.g. shirt colour); null = always drawn
    blink:(g.blink||null),   // sclera lid-frame GTEX indices [open,blink,shut] — swapped on the ROM auto-blink cadence
    frown:(g.frown!=null?g.frown:null), frownIris:(g.frownIris!=null?g.frownIris:null),   // Conker moving-face: narrowed frown sclera (0x798) / bloodshot iris (0xe49), ROM expr 0x2A while xz_velocity>thresh
    tg:g.tg||0, lnrm:g.nrm?b64(g.nrm,Int8Array):null,   // G_TEXTURE_GEN chrome flag + bone-LOCAL per-vertex normals (skinned live)
    slot:b64(g.slot,Uint8Array),pos:b64(g.pos,Int16Array),uv:b64(g.uv,Int16Array),col:b64(g.col,Uint8Array),idx:b64(g.idx,Uint16Array)}));
  // bind pose -> centre + scale (fit to view like prep())
  const bind=poseWorld(bones,slot2idx,{});
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
  for(const g of groups){const np=g.slot.length;let bx0=1e9,by0=1e9,bz0=1e9,bx1=-1e9,by1=-1e9,bz1=-1e9;
    for(let i=0;i<np;i++){const M=bind[g.slot[i]]||IDENT,x=g.pos[i*3],y=g.pos[i*3+1],z=g.pos[i*3+2];
    const wx=x*M[0]+y*M[4]+z*M[8]+M[12],wy=x*M[1]+y*M[5]+z*M[9]+M[13],wz=x*M[2]+y*M[6]+z*M[10]+M[14];
    if(wx<mnx)mnx=wx;if(wy<mny)mny=wy;if(wz<mnz)mnz=wz;if(wx>mxx)mxx=wx;if(wy>mxy)mxy=wy;if(wz>mxz)mxz=wz;
    if(wx<bx0)bx0=wx;if(wy<by0)by0=wy;if(wz<bz0)bz0=wz;if(wx>bx1)bx1=wx;if(wy>by1)by1=wy;if(wz>bz1)bz1=wz;}
    g._bb=[bx0,by0,bz0,bx1,by1,bz1];}
  // CHROME SHEEN detection: a texgen chrome group that OVERLAPS a non-chrome base (co-located body geometry) is a
  // reflective OVERLAY, not opaque coverage. The ROM draws the base then this chrome pass with FORCE_BL (from the
  // seg-8 render-mode bank the builders don't follow), so it blends -> a shiny sheen, NOT a solid chrome that hides
  // the body (that was Berri rendering as a white/dark blob). Standalone chrome shells (no base under them) have no
  // overlap -> stay opaque. sheen groups render ADDITIVELY over the base in drawPosable.
  const bbov=(a,b)=>{const ix=Math.max(0,Math.min(a[3],b[3])-Math.max(a[0],b[0])),iy=Math.max(0,Math.min(a[4],b[4])-Math.max(a[1],b[1])),iz=Math.max(0,Math.min(a[5],b[5])-Math.max(a[2],b[2]));const av=Math.max(1e-6,(a[3]-a[0])*(a[4]-a[1])*(a[5]-a[2]));return (ix*iy*iz)/av;};
  for(const g of groups){ g.sheen=0; if(!g.tg)continue; let ov=0; for(const h of groups){ if(h===g||h.tg)continue; ov=Math.max(ov,bbov(g._bb,h._bb)); } g.sheen = ov>0.25?1:0; }
  const cx=(mnx+mxx)/2,cy=(mny+mxy)/2,cz=(mnz+mxz)/2,rad=Math.max(1e-6,Math.hypot(mxx-cx,mxy-cy,mxz-cz)),s=1.7/rad;
  for(const g of groups){const np=g.slot.length;const uvf=new Float32Array(np*2),colf=new Float32Array(np*3);
    let umin=1e9,umax=-1e9,vmin=1e9,vmax=-1e9,cwhite=true;
    for(let i=0;i<np;i++){const u=g.uv[i*2]/512,v=g.uv[i*2+1]/512; uvf[i*2]=u;uvf[i*2+1]=v;
      if(u<umin)umin=u;if(u>umax)umax=u;if(v<vmin)vmin=v;if(v>vmax)vmax=v;
      if(g.col[i*3]<250||g.col[i*3+1]<250||g.col[i*3+2]<250)cwhite=false;
      colf[i*3]=g.col[i*3]/255;colf[i*3+1]=g.col[i*3+1]/255;colf[i*3+2]=g.col[i*3+2]/255;}
    // BAKED-SHADE detection: Conker posable characters render with G_LIGHTING OFF -> the ROM combiner is
    // SHADE*TEXEL where SHADE = the per-vertex COLOUR (baked shade/AO), not hardware lighting. So any group whose
    // verts carry real colour (NOT pure white) must be shaded by that vertex colour ALONE -- applying the viewer's
    // synthetic directional light on top double-darkens the whole character (Berri's grey face/hair/suit). Only
    // WHITE-vert groups (which have no baked shade) fall back to the geometric light for form. This matches the
    // flat-face rule the eye/muzzle path already uses (vC*(mod?1:sh)); it just extends it to textured faces.
    g.baked=cwhite?0:1;
    g.cbake=(g.tg&&!cwhite)?1:0;   // chrome subset of baked: env-map * vtxColour (see drawPosable)
    // Skinned CHARACTER: honour the ROM's cmS/cmT clamp flag VERBATIM -- no override. Body panels push
    // texcoords FAR past the edge on purpose (e.g. 0xc17 is 32 tall, v down to ~-0.9) so CLAMP samples the
    // ORANGE fur border. ANY "out-of-range -> repeat" heuristic wraps them onto the blue interior = the
    // pelvis/tail blue specks. The tile flag is authoritative for skinned characters; do not second-guess it.
    const tm=(DATA.texmeta&&g.ti>=0)?DATA.texmeta[g.ti]:null;
    if(tm && g.al){const fmt=tm[1],siz=tm[2],flag=tm[3],isCI=(flag===0x400000||flag===0x800000||fmt===2);
      if(!isCI && ((fmt===0&&siz===3)||fmt===3)) g.bl=1;}
    const vaf=new Float32Array(np);for(let i=0;i<np;i++)vaf[i]=g.va?g.va[i]/255:1.0;
    g.np=np;g.uvBuf=glBuf(uvf,gl.ARRAY_BUFFER);g.colBuf=glBuf(colf,gl.ARRAY_BUFFER);g.vaBuf=glBuf(vaf,gl.ARRAY_BUFFER);g.idxBuf=glBuf(g.idx,gl.ELEMENT_ARRAY_BUFFER);
    g.posBuf=gl.createBuffer();g.nrmBuf=gl.createBuffer();g.posArr=new Float32Array(np*3);g.nrmArr=new Float32Array(np*3);}
  // real in-game animation clips (extracted from the assets02 keyframe pack this model maps to)
  const clips=[];
  const ap=(DATA.animpacks&&m.pack!=null)?DATA.animpacks[String(m.pack)]:null;
  if(ap)for(const c of ap){const map={};(c.idx||[]).forEach((e,i)=>{map[e]=i;});
    const trcol={};(c.ti_||[]).forEach((e,i)=>{trcol[e]=i;});
    clips.push({n:c.n,iv:c.iv,ncol:(c.idx||[]).length,map,d:b64(c.d,Int16Array),aid:(c.aid!=null?c.aid:null),
      trcol,trn:(c.ti_||[]).length,td:(c.td?b64(c.td,Int16Array):null)});}
  m._pose={bones,slot2idx,depth,groups,cx,cy,cz,s,clips,aoff:(m.aoff||0)};m.ntri=m.ntri||0;
  return m;
}
// build GL buffers for one socketed attachment PART (assets01 geometry mounted at a parent bone). One-time.
function prepAttachPart(part){
  if(part._prep)return part._prep;
  part._prep=part.g.map(g=>{
    const pos=b64(g.p,Int16Array),uv=b64(g.uv,Int16Array),col=b64(g.col,Uint8Array),idx=b64(g.idx,Uint16Array),np=pos.length/3;
    const uvf=new Float32Array(np*2),colf=new Float32Array(np*3),vaf=new Float32Array(np);vaf.fill(1);
    for(let i=0;i<np;i++){uvf[i*2]=uv[i*2]/512;uvf[i*2+1]=uv[i*2+1]/512;colf[i*3]=col[i*3]/255;colf[i*3+1]=col[i*3+1]/255;colf[i*3+2]=col[i*3+2]/255;}
    return {ti:g.ti,bl:g.bl||0,al:g.al||0,ac:g.ac||0,dec:g.dec||0,mod:g.mod||0,ws:g.ws||0,wt:g.wt||0,vat:g.vat||0,np,pos,idx,n:idx.length,
      uvBuf:glBuf(uvf,gl.ARRAY_BUFFER),colBuf:glBuf(colf,gl.ARRAY_BUFFER),vaBuf:glBuf(vaf,gl.ARRAY_BUFFER),idxBuf:glBuf(idx,gl.ELEMENT_ARRAY_BUFFER),
      posBuf:gl.createBuffer(),nrmBuf:gl.createBuffer(),posArr:new Float32Array(np*3),nrmArr:new Float32Array(np*3)};
  });
  return part._prep;
}
function lerpBam(a0,a1,f){a0&=0xFFFF;a1&=0xFFFF;let dd=((a1-a0+0x8000)&0xFFFF)-0x8000;return (a0+Math.round(dd*f))&0xFFFF;}
// ANIMATION MIXER (ROM func_1505E650 blend arg -> func_1505E0C4 crossfade -> func_150A81D0 per-bone blend).
// clipAngles = per-bone {q,t} for ONE real clip at phase t; blendAngles = crossfade two clips per-bone (NLERP).
function clipAngles(m,idx,t){
  const P=m._pose, ang={};
  if(typeof idx!=='number'||!P.clips||!P.clips[idx])return ang;
  const c=P.clips[idx],nkf=c.n,ncol=c.ncol,data=c.d,map=c.map,trcol=c.trcol,trn=c.trn,trd=c.td;
  const kp=t/Math.max(1,c.iv); let k0=Math.floor(kp)%nkf; if(k0<0)k0+=nkf; const frac=kp-Math.floor(kp), k1=(k0+1)%nkf;
  const aoff=P.aoff||0;                                 // clip element index = bone rotIndex + aoff (ec==B+1 packs have a LEADING root element)
  for(const b of P.bones){const re=b.rot+aoff, col=map[re]; if(col===undefined)continue;
    const o0=(k0*ncol+col)*3, o1=(k1*ncol+col)*3;
    const q=nlerpQ(bamToQuat(data[o0],data[o0+1],data[o0+2]), bamToQuat(data[o1],data[o1+1],data[o1+2]), frac);
    let tx=0,ty=0,tz=0;
    if(trd&&trcol[re]!==undefined){const tc=trcol[re],p0=(k0*trn+tc)*3,p1=(k1*trn+tc)*3;
      tx=(trd[p0]+(trd[p1]-trd[p0])*frac)/16; ty=(trd[p0+1]+(trd[p1+1]-trd[p0+1])*frac)/16; tz=(trd[p0+2]+(trd[p1+2]-trd[p0+2])*frac)/16;}
    ang[b.rot]={q,t:[tx,ty,tz]};}
  // (v31 element-0 root channel REVERTED in v32 — applying it as a whole-body rotation made Conker WOBBLE at idle and go
  // HORIZONTAL on clips carrying a large element-0 value: wrong pivot/magnitude at the root. Needs a correct feet-pivot
  // + per-clip handling before re-enabling; the tail elevation/breathing will be revisited that way.)
  return ang;
}
const _IDN={q:[0,0,0,1],t:[0,0,0]};                    // a bone absent from a clip = bind (identity relative rotation)
function blendAngles(a,b,w){                            // crossfade a->b by weight w in [0,1], per-bone NLERP
  if(!(w>0))return a; if(w>=1)return b;
  const out={},keys={};
  for(const k in a)keys[k]=1; for(const k in b)keys[k]=1;
  for(const k in keys){const A=a[k]||_IDN,B=b[k]||_IDN;
    out[k]={q:nlerpQ(A.q,B.q,w),t:[A.t[0]+(B.t[0]-A.t[0])*w,A.t[1]+(B.t[1]-A.t[1])*w,A.t[2]+(B.t[2]-A.t[2])*w]};}
  return out;
}
function poseAngles(m,t){
  const P=m._pose;
  // REAL in-game clip: STATE.poseAnim is the clip index (integer)
  if(typeof STATE.poseAnim==='number'&&P.clips&&P.clips[STATE.poseAnim]){
    const c=P.clips[STATE.poseAnim],nkf=c.n,ncol=c.ncol,data=c.d,map=c.map;
    const trcol=c.trcol,trn=c.trn,trd=c.td;
    const kp=t/Math.max(1,c.iv);                       // 1 keyframe every `iv` render frames (~in-game rate)
    let k0=Math.floor(kp)%nkf; if(k0<0)k0+=nkf; const frac=kp-Math.floor(kp), k1=(k0+1)%nkf;
    const ang={},aoff=P.aoff||0;                        // clip element index = bone rotIndex + aoff (ec==B+1 packs have a LEADING root element -> aoff=1; verified: aoff=0 explodes full-body clips)
    for(const b of P.bones){const re=b.rot+aoff, col=map[re]; if(col===undefined)continue;
      const o0=(k0*ncol+col)*3, o1=(k1*ncol+col)*3;
      const q=nlerpQ(bamToQuat(data[o0],data[o0+1],data[o0+2]), bamToQuat(data[o1],data[o1+1],data[o1+2]), frac);
      let tx=0,ty=0,tz=0;                               // per-bone mask translation (bind + raw16/16), keyframe-interpolated
      if(trd&&trcol[re]!==undefined){const tc=trcol[re],p0=(k0*trn+tc)*3,p1=(k1*trn+tc)*3;
        tx=(trd[p0]+(trd[p1]-trd[p0])*frac)/16; ty=(trd[p0+1]+(trd[p1+1]-trd[p0+1])*frac)/16; tz=(trd[p0+2]+(trd[p1+2]-trd[p0+2])*frac)/16;}
      ang[b.rot]={q,t:[tx,ty,tz]};}
    return ang;
  }
  if(STATE.poseAnim==='bind')return {};
  const ang={};   // model-agnostic synthetic idle: gentle sway, amplitude grows toward the extremities
  for(const b of P.bones){if(b.par===0xFF)continue;const d=P.depth[b.slot]||1,amp=Math.min(1200,200*d),ph=b.slot*0.7;
    const x=Math.round(Math.sin(t*0.030+ph)*amp*0.45),y=Math.round(Math.sin(t*0.021+ph*1.3)*amp),z=Math.round(Math.cos(t*0.026+ph)*amp*0.4);
    ang[b.rot]={q:bamToQuat(x,y,z),t:[0,0,0]};}
  return ang;
}
function skinPose(m,native,anglesOverride){
  // native=true -> skin to the model's RAW local coords (no view-centering/scale), for placing the
  // character at a WORLD transform inside a level (Conker + NPCs). Default = browser-centred/scaled.
  // anglesOverride -> use pre-computed (e.g. mixer-blended) per-bone angles instead of the single-clip poseAngles.
  const P=m._pose,world=poseWorld(P.bones,P.slot2idx,anglesOverride||poseAngles(m,poseT)),s=P.s,cx=P.cx,cy=P.cy,cz=P.cz;
  P._world=world;   // per-bone (by slot) world matrices this frame -> used to mount socketed attachments
  for(const g of P.groups){const np=g.np,pos=g.posArr,nrm=g.nrmArr,sl=g.slot,lp=g.pos,ln=g.lnrm;
    for(let i=0;i<np;i++){const M=world[sl[i]]||IDENT,x=lp[i*3],y=lp[i*3+1],z=lp[i*3+2];
      if(native){pos[i*3]=x*M[0]+y*M[4]+z*M[8]+M[12];pos[i*3+1]=x*M[1]+y*M[5]+z*M[9]+M[13];pos[i*3+2]=x*M[2]+y*M[6]+z*M[10]+M[14];}
      else{pos[i*3]=(x*M[0]+y*M[4]+z*M[8]+M[12]-cx)*s;pos[i*3+1]=(x*M[1]+y*M[5]+z*M[9]+M[13]-cy)*s;pos[i*3+2]=(x*M[2]+y*M[6]+z*M[10]+M[14]-cz)*s;}
      if(ln){ // skin the REAL per-vertex normal by the bone rotation (chrome/texgen + lighting reflect correctly as it poses)
        const lx=ln[i*3]/127,ly=ln[i*3+1]/127,lz=ln[i*3+2]/127;
        nrm[i*3]=lx*M[0]+ly*M[4]+lz*M[8];nrm[i*3+1]=lx*M[1]+ly*M[5]+lz*M[9];nrm[i*3+2]=lx*M[2]+ly*M[6]+lz*M[10];}
      else{nrm[i*3]=0;nrm[i*3+1]=0;nrm[i*3+2]=0;}}
    if(!ln){const idx=g.idx;   // no ROM normals -> synthesize smooth normals from the skinned faces (as before)
      for(let t=0;t<idx.length;t+=3){const a=idx[t],b=idx[t+1],c=idx[t+2];
        const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2],bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2],ux=pos[c*3],uy=pos[c*3+1],uz=pos[c*3+2];
        const nx=(by-ay)*(uz-az)-(bz-az)*(uy-ay),ny=(bz-az)*(ux-ax)-(bx-ax)*(uz-az),nz=(bx-ax)*(uy-ay)-(by-ay)*(ux-ax);
        nrm[a*3]+=nx;nrm[a*3+1]+=ny;nrm[a*3+2]+=nz;nrm[b*3]+=nx;nrm[b*3+1]+=ny;nrm[b*3+2]+=nz;nrm[c*3]+=nx;nrm[c*3+1]+=ny;nrm[c*3+2]+=nz;}}
    gl.bindBuffer(gl.ARRAY_BUFFER,g.posBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,g.nrmBuf);gl.bufferData(gl.ARRAY_BUFFER,nrm,gl.DYNAMIC_DRAW);}
}
function drawPosable(m,opts){
  const P=m._pose,asp=cvs.width/cvs.height,near=Math.max(0.004,STATE.dist*0.006),far=STATE.dist*8+60;
  const Pm=M4.persp(0.92,asp,near,far),{e}=camBasis(),Vv=M4.lookAt(e,STATE.target,[0,1,0]);
  // WORLD-PLACED mode (opts.mvp given): skin to native coords and draw at opts.worldMat inside the
  // caller's level MVP (a character standing IN the level), instead of centred in the browser view.
  const world=!!(opts&&opts.mvp), MVP=world?(opts.worldMat?M4.mul(opts.mvp,opts.worldMat):opts.mvp):M4.mul(Pm,Vv);
  const Vn=(world&&opts.view)?opts.view:Vv;
  let savedPose;
  if(opts&&opts.clip!==undefined){savedPose=STATE.poseAnim;STATE.poseAnim=opts.clip;}
  gl.uniformMatrix4fv(uMVP,false,new Float32Array(MVP));gl.uniform3f(uLight,0.45,0.75,0.55);
  if(uNMat)gl.uniformMatrix3fv(uNMat,false,new Float32Array([Vn[0],Vn[1],Vn[2],Vn[4],Vn[5],Vn[6],Vn[8],Vn[9],Vn[10]]));   // eye-space normal matrix for chrome texgen
  skinPose(m,world,opts&&opts.angles);   // opts.angles = mixer-blended pose (player); else single-clip poseAngles
  if(opts&&opts.clip!==undefined)STATE.poseAnim=savedPose;
  const tex0=STATE.cmode===0;
  function dg(g){
    if(g.variant!=null&&g.variant!==STATE.shirt)return;   // only the selected texture variant (e.g. shirt colour)
    // Mechanism C tile scroll (waterfall/ooze/force-field actor models): drive uScroll from the ground-truth rate.
    if(uScroll){if(g.scroll)gl.uniform2f(uScroll,(g.scroll[0]*animT)%1,(g.scroll[1]*animT)%1);else gl.uniform2f(uScroll,0,0);}
    if(uTexgen)gl.uniform1f(uTexgen, g.tg?1.0:0.0);       // G_TEXTURE_GEN chrome/metal shell -> UVs from eye normal
    // BAKED-SHADE (lighting-off characters): colour-vert groups shade by VERTEX COLOUR only (uLitNrm=0 -> shade
    // term 1.0), NOT the synthetic directional light. ONLY white-vert groups (no baked shade) use the geometric
    // light for form. cbake chrome likewise draws env-map*vtxColour. Un-double-darkens Berri etc.; white-vert
    // models unchanged. (Matches the flat-face vC*(mod?1:sh) rule, now extended to textured faces.)
    if(uLitNrm)gl.uniform1f(uLitNrm, (g.lnrm&&!g.baked)?1.0:0.0);   // real ROM normals + WHITE verts -> geometric light
    let _gti=g.ti;                                                                 // eye texture selection (idle blink vs moving frown)
    if(PLAYER.on){
      if(PLAYER._faceMove && g.frown!=null) _gti=g.frown;                          // MOVING: narrowed FROWN sclera ONLY (ROM expr 0x2A sclera 0x798). NOT the bloodshot iris (0xe49) — per user, bloodshot is a separate hungover state, running just NARROWS. Iris stays neutral 0xe41.
      else if(g.blink && PLAYER.eye) _gti=g.blink[PLAYER.eye.lid|0];               // IDLE: auto-blink lid frame
    }
    if(STATE.cmode===0){
      if(_gti>=0&&GTEX[_gti]){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,GTEX[_gti]);gl.uniform1i(uTex,0);gl.uniform1f(uMode,0.0);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);   // characters stay crisp
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,g.tg?gl.CLAMP_TO_EDGE:(g.scroll?gl.REPEAT:(g.ws===2?gl.CLAMP_TO_EDGE:(g.ws===1?gl.MIRRORED_REPEAT:gl.REPEAT))));
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,g.tg?gl.CLAMP_TO_EDGE:(g.scroll?gl.REPEAT:(g.wt===2?gl.CLAMP_TO_EDGE:(g.wt===1?gl.MIRRORED_REPEAT:gl.REPEAT))));
        gl.uniform3f(uTint,1,1,1);gl.uniform1f(uAlphaMode,g.bl?(g.al?1.0:(g.vat?3.0:2.0)):0.0);gl.uniform1f(uMod,(g.mod||g.cbake)?1.0:0.0);}
      else{gl.uniform1f(uMode,1.0);gl.uniform1f(uAlphaMode,(g.bl&&g.vat)?3.0:0.0);gl.uniform1f(uMod,g.mod?1.0:0.0);}   // flat-shaded UV0 faces keep baked shade; bl+vat -> honour per-vertex alpha (glass dome / invisible flash overlay)
    }else if(STATE.cmode===1){gl.uniform1f(uMode,1.0);gl.uniform1f(uAlphaMode,0.0);}
    else{gl.uniform1f(uMode,2.0);gl.uniform1f(uAlphaMode,0.0);const pc=hex2rgb(cssvar('--accent')||'#e0873c');gl.uniform3f(uFlatCol,pc[0],pc[1],pc[2]);}
    if(g.dec){gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1.2,-2.0);}else{gl.disable(gl.POLYGON_OFFSET_FILL);}
    bindA(aPos,g.posBuf,3);bindA(aNrm,g.nrmBuf,3);bindA(aUV,g.uvBuf,2);bindA(aCol,g.colBuf,3);bindA(aVA,g.vaBuf,1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.idxBuf);gl.drawElements(gl.TRIANGLES,g.n,gl.UNSIGNED_SHORT,0);
  }
  gl.disable(gl.BLEND);gl.depthMask(true);
  for(const g of P.groups){if(tex0&&(g.bl||g.sheen))continue;dg(g);}   // opaque base (defer bl + chrome sheen in tex mode)
  if(tex0){gl.enable(gl.BLEND);gl.depthMask(false);
    for(const g of P.groups){if(!g.bl||g.sheen)continue;
      // CHARACTERS have no light-shafts, so their XLU surfaces (e.g. model 24 ice-cube body 0x3d9,
      // opaque texture, no alpha) must OVER-BLEND semi-opaque, NOT additive-glow (which made them a
      // glassy see-through box). Additive is a level-only thing for actual light shafts.
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      dg(g);}
    // CHROME SHEEN pass: reflective overlay drawn ADDITIVELY over the already-drawn base body (env-map*vtxColour;
    // dark env adds ~nothing, bright streaks add a moving gloss highlight = shiny latex/PVC). Depth-test, no write.
    gl.blendFunc(gl.ONE, gl.ONE);
    for(const g of P.groups){if(g.sheen)dg(g);}
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(true);gl.disable(gl.BLEND);}
  gl.disable(gl.POLYGON_OFFSET_FILL);
  // SOCKETED ATTACHMENT: mount part(s) onto the character's posed bone matrices (D_80086CC4). Source = opts.attach
  // (player fidget props, a pre-built [{g,bone,off},...]) OR STATE.attach (the manual dropdown picker).
  let attachParts=null;
  if(opts&&opts.attach)attachParts=opts.attach;
  else if(STATE.attach!=null && DATA.attachments){const at=DATA.attachments.find(o=>o.oid===STATE.attach); if(at)attachParts=at.parts;}
  if(attachParts && P._world){
    for(const part of attachParts){if(!part)continue; const M=P._world[part.bone]; if(!M)continue;
      if(part.animated && part.mesh && part.mesh._pose){
        // ARTICULATED PROP: pose its OWN sub-skeleton (assets0A clip 0, looping on the pose clock) -> prop-space,
        // then mount that on Conker's hand bone matrix M. Native scale (1:1, same as the static prop fix). This
        // folds the cross-bone triangles into shape (no bind-pose stretch) AND animates it (watch swing / yo-yo).
        const pm=part.mesh, PP=pm._pose;
        const hasClip=(PP.clips&&PP.clips.length>0);
        const pt=hasClip?(poseT % Math.max(1,clipLen(pm,0))):0;
        const pang=hasClip?clipAngles(pm,0,pt):{};
        const pworld=poseWorld(PP.bones,PP.slot2idx,pang);
        for(const g of PP.groups){const np=g.np,pos=g.posArr,nrm=g.nrmArr,lp=g.pos,sl=g.slot;
          for(let i=0;i<np;i++){const Wp=pworld[sl[i]]||IDENT,x=lp[i*3],y=lp[i*3+1],z=lp[i*3+2];
            const sx=x*Wp[0]+y*Wp[4]+z*Wp[8]+Wp[12],sy=x*Wp[1]+y*Wp[5]+z*Wp[9]+Wp[13],sz=x*Wp[2]+y*Wp[6]+z*Wp[10]+Wp[14];
            const wx=sx*M[0]+sy*M[4]+sz*M[8]+M[12],wy=sx*M[1]+sy*M[5]+sz*M[9]+M[13],wz=sx*M[2]+sy*M[6]+sz*M[10]+M[14];
            if(world){pos[i*3]=wx;pos[i*3+1]=wy;pos[i*3+2]=wz;}
            else{pos[i*3]=(wx-P.cx)*P.s;pos[i*3+1]=(wy-P.cy)*P.s;pos[i*3+2]=(wz-P.cz)*P.s;}
            nrm[i*3]=0;nrm[i*3+1]=0;nrm[i*3+2]=0;}
          const idx=g.idx;
          for(let t=0;t<idx.length;t+=3){const a=idx[t],b=idx[t+1],c=idx[t+2];
            const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2],bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2],ux=pos[c*3],uy=pos[c*3+1],uz=pos[c*3+2];
            const nx=(by-ay)*(uz-az)-(bz-az)*(uy-ay),ny=(bz-az)*(ux-ax)-(bx-ax)*(uz-az),nz=(bx-ax)*(uy-ay)-(by-ay)*(ux-ax);
            nrm[a*3]+=nx;nrm[a*3+1]+=ny;nrm[a*3+2]+=nz;nrm[b*3]+=nx;nrm[b*3+1]+=ny;nrm[b*3+2]+=nz;nrm[c*3]+=nx;nrm[c*3+1]+=ny;nrm[c*3+2]+=nz;}
          gl.bindBuffer(gl.ARRAY_BUFFER,g.posBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER,g.nrmBuf);gl.bufferData(gl.ARRAY_BUFFER,nrm,gl.DYNAMIC_DRAW);
          dg(g);}
        continue;
      }
      const off=part.off||[0,0,0], psc=(part.scale!=null?part.scale:1), gs=prepAttachPart(part);
      for(const g of gs){const np=g.np,pos=g.posArr,nrm=g.nrmArr,lp=g.pos;
        for(let i=0;i<np;i++){const x=lp[i*3]*psc+off[0],y=lp[i*3+1]*psc+off[1],z=lp[i*3+2]*psc+off[2];   // vert*scale+offset in bone-local, then bone world matrix
          const wx=x*M[0]+y*M[4]+z*M[8]+M[12],wy=x*M[1]+y*M[5]+z*M[9]+M[13],wz=x*M[2]+y*M[6]+z*M[10]+M[14];
          // world-placed player = raw native coords (skinPose native branch); static viewer = browser-centred/scaled
          if(world){pos[i*3]=wx;pos[i*3+1]=wy;pos[i*3+2]=wz;}
          else{pos[i*3]=(wx-P.cx)*P.s;pos[i*3+1]=(wy-P.cy)*P.s;pos[i*3+2]=(wz-P.cz)*P.s;}
          nrm[i*3]=0;nrm[i*3+1]=0;nrm[i*3+2]=0;}
        const idx=g.idx;
        for(let t=0;t<idx.length;t+=3){const a=idx[t],b=idx[t+1],c=idx[t+2];
          const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2],bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2],ux=pos[c*3],uy=pos[c*3+1],uz=pos[c*3+2];
          const nx=(by-ay)*(uz-az)-(bz-az)*(uy-ay),ny=(bz-az)*(ux-ax)-(bx-ax)*(uz-az),nz=(bx-ax)*(uy-ay)-(by-ay)*(ux-ax);
          nrm[a*3]+=nx;nrm[a*3+1]+=ny;nrm[a*3+2]+=nz;nrm[b*3]+=nx;nrm[b*3+1]+=ny;nrm[b*3+2]+=nz;nrm[c*3]+=nx;nrm[c*3+1]+=ny;nrm[c*3+2]+=nz;}
        gl.bindBuffer(gl.ARRAY_BUFFER,g.posBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER,g.nrmBuf);gl.bufferData(gl.ARRAY_BUFFER,nrm,gl.DYNAMIC_DRAW);
        dg(g);}}
  }
  if(STATE.wire){gl.uniform1f(uMode,3.0);gl.uniform1f(uAlphaMode,0.0);const wc=hex2rgb(cssvar('--line')||'#262b36');gl.uniform3f(uFlatCol,wc[0],wc[1],wc[2]);
    for(const g of P.groups){bindA(aPos,g.posBuf,3);bindA(aNrm,g.nrmBuf,3);bindA(aUV,g.uvBuf,2);bindA(aCol,g.colBuf,3);bindA(aVA,g.vaBuf,1);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.idxBuf);gl.drawElements(gl.LINES,g.n,gl.UNSIGNED_SHORT,0);}}
}
// ---- GL ----
const cvs=$('#gl');
let gl=cvs.getContext("webgl",{antialias:true,alpha:false})||cvs.getContext("experimental-webgl");
let prog,aPos,aNrm,aUV,aCol,aVA,uMVP,uLight,uMode,uTex,uFlatCol,uAlphaMode,uTint,uMod,uScroll,uNMat,uTexgen,uLitNrm,GTEX=[],WHITE=null;
const STATE={cmode:0,shade:true,wire:false,spin:false,sky:true,triggers:false,cat:'posable',idx:0,target:[0,0,0],yaw:0.7,pitch:0.5,dist:4.4,poseAnim:'idle',animSpeed:1.0,attach:null,shirt:0,audioReg:null,audioLoop:false,audioVol:0.9,audioAuto:false,texFilter:'all',texSel:-1,texZoom:108,texPage:0,collide:true,walls:false};
const keys={};let mesh=null;
function initGL(){
  if(!gl){$('#loading').textContent="WebGL unavailable";return false;}
  // uTexgen: G_TEXTURE_GEN chrome/env surfaces (assets09) generate UVs from the EYE-SPACE normal (uNMat = view
  // rotation) as a sphere-map -> their baked UVs are placeholders. uNMat transforms the model normal to eye space.
  const vs=`attribute vec3 aPos;attribute vec3 aNrm;attribute vec2 aUV;attribute vec3 aCol;attribute float aVA;uniform mat4 uMVP;uniform vec2 uScroll;uniform mat3 uNMat;uniform float uTexgen;varying vec3 vN;varying vec2 vUV;varying vec3 vC;varying float vA;void main(){vN=aNrm;if(uTexgen>0.5){vec3 ne=normalize(uNMat*aNrm);vUV=vec2(ne.x*0.5+0.5,-ne.y*0.5+0.5);}else{vUV=aUV-uScroll;}vC=aCol;vA=aVA;gl_Position=uMVP*vec4(aPos,1.0);}`;
  const fs=`precision mediump float;varying vec3 vN;varying vec2 vUV;varying vec3 vC;varying float vA;
    uniform vec3 uLight;uniform float uMode;uniform sampler2D uTex;uniform vec3 uFlatCol;uniform float uAlphaMode;uniform vec3 uTint;uniform float uMod;uniform float uLitNrm;
    void main(){vec3 N=normalize(vN);float d=abs(dot(N,normalize(uLight)));float sh=0.55+0.45*d;
    if(uMode<0.5){
      vec4 t=texture2D(uTex,vUV); vec3 rgb=t.rgb*uTint; float shade=sh;
      // TEXEL*SHADE: normally the vertex colour IS the baked shade. But assets09 objects carry WHITE verts + real
      // per-vertex NORMALS (uLitNrm) and rely on hardware lighting -> keep the lit shade instead of flattening to 1.
      if(uMod>0.5){ rgb*=vC; shade=(uLitNrm>0.5)?sh:1.0; }
      if(uAlphaMode<0.5){ if(t.a<0.5) discard; gl_FragColor=vec4(rgb*shade,1.0); }          // opaque cutout (alpha-compare on)
      else if(uAlphaMode<1.5){ if(t.a<0.02) discard; gl_FragColor=vec4(rgb*shade,t.a*vA); }  // blend by texture alpha x vtx alpha
      else if(uAlphaMode<2.5){ float a=max(max(t.r,t.g),t.b); gl_FragColor=vec4(rgb*shade,a); } // blend by luminance (light shafts)
      else { gl_FragColor=vec4(rgb*shade,vA); }                                              // per-vertex ALPHA (glass / vtx-alpha translucency)
      return;}
    if(uMode<1.5){float oa=(uAlphaMode>2.5)?vA:1.0; gl_FragColor=vec4(vC*(uMod>0.5?1.0:sh),oa); return;}  // mod=1: vC IS baked shade (flat-shaded UV0 faces); uAlphaMode>2.5 -> honour per-vertex alpha (untextured glass/overlay)
    if(uMode<2.5){gl_FragColor=vec4(uFlatCol*sh,1.0); return;}
    gl_FragColor=vec4(uFlatCol,1.0);}`;
  function sh(t,s){const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))$('#loading').textContent="Shader: "+gl.getShaderInfoLog(o);return o;}
  prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs));gl.linkProgram(prog);gl.useProgram(prog);
  aPos=gl.getAttribLocation(prog,"aPos");aNrm=gl.getAttribLocation(prog,"aNrm");aUV=gl.getAttribLocation(prog,"aUV");aCol=gl.getAttribLocation(prog,"aCol");aVA=gl.getAttribLocation(prog,"aVA");
  uMVP=gl.getUniformLocation(prog,"uMVP");uLight=gl.getUniformLocation(prog,"uLight");uMode=gl.getUniformLocation(prog,"uMode");uTex=gl.getUniformLocation(prog,"uTex");uFlatCol=gl.getUniformLocation(prog,"uFlatCol");
  uAlphaMode=gl.getUniformLocation(prog,"uAlphaMode");uTint=gl.getUniformLocation(prog,"uTint");uMod=gl.getUniformLocation(prog,"uMod");uScroll=gl.getUniformLocation(prog,"uScroll");
  uNMat=gl.getUniformLocation(prog,"uNMat");uTexgen=gl.getUniformLocation(prog,"uTexgen");uLitNrm=gl.getUniformLocation(prog,"uLitNrm");
  gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
  WHITE=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,WHITE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,1,1,0,gl.RGB,gl.UNSIGNED_BYTE,new Uint8Array([200,200,200]));
  return true;
}
function loadTextures(cb){
  const n=DATA.textures.length;GTEX=new Array(n).fill(WHITE);let done=0;
  const ANISO=gl.getExtension('EXT_texture_filter_anisotropic')||gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')||gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
  if(n===0){cb();return;}
  const upload=(t,i)=>{const tx=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tx);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,t.pw,t.ph,0,gl.RGBA,gl.UNSIGNED_BYTE,t.px);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    // MIPMAPS: densely-tiled surfaces (walls/floors mapping the texture 15-20x) minify without mipmaps into a
    // solid aliased average -> the recurring "solid colour" complaint. Textures are stored power-of-two, so
    // generateMipmap is safe. MIN=trilinear-mipmap smooths distance; MAG=NEAREST keeps close-up texels crisp;
    // max anisotropy keeps grazing-angle surfaces (long floors) sharp instead of over-blurred.
    // Only mipmap power-of-two textures — generateMipmap on NPOT silently yields an INCOMPLETE texture that
    // renders invisible. (Build stores POT, but guard defensively so a stray NPOT never blanks geometry.)
    const isPOT=n=>n>0&&(n&(n-1))===0; let ok=false;
    if(isPOT(t.pw)&&isPOT(t.ph)){try{gl.generateMipmap(gl.TEXTURE_2D);ok=true;}catch(e){ok=false;}}
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,ok?gl.LINEAR_MIPMAP_LINEAR:gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    if(ANISO){gl.texParameterf(gl.TEXTURE_2D,ANISO.TEXTURE_MAX_ANISOTROPY_EXT,gl.getParameter(ANISO.MAX_TEXTURE_MAX_ANISOTROPY_EXT));}
    GTEX[i]=tx;done++;};
  const step=()=>{const end=Math.min(n,done+256);for(let i=done;i<end;)upload(DATA.textures[i],i++);
    $('#loading').textContent='uploading textures… '+Math.round(100*done/n)+'%';
    if(done<n)requestAnimationFrame(step);else cb();};
  step();
}
// <img> sources for the texture gallery / inspector, rendered on demand from the decoded pixels
const _texURL=[];
function texURL(i){if(_texURL[i])return _texURL[i];const t=DATA.textures[i];if(!t)return '';
  const c=document.createElement('canvas');c.width=t.pw;c.height=t.ph;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.px.buffer,t.px.byteOffset,t.px.byteLength),t.pw,t.ph),0,0);
  return _texURL[i]=c.toDataURL();}
let buffers=new Map();
function glBuf(arr,type){let b=gl.createBuffer();gl.bindBuffer(type,b);gl.bufferData(type,arr,gl.STATIC_DRAW);return b;}
// ---- STATE CONTROLLER: instanced placed props (state variants + hinge scrub) ----
function prepProps(m,cx,cy,cz,s){
  // partpool = unique referenced parts, LOCAL geometry (shared by instances)
  m._pp=m.partpool.map(part=>part.g.map(g=>procGroup(decodeGroup(g),cx,cy,cz,s,true,m.kind==='level')));
  // props = instances; urot = live user rotation delta (hinge scrub)
  m._props=m.props.map(pr=>({pp:pr.pp,pos:pr.pos,rot:pr.rot,sc:pr.sc||[1,1,1],grp:pr.grp,st:pr.st,id:pr.id,ext:pr.ext,
    beh:pr.beh>>>0,init:pr.init>>>0,fl:pr.fl,vis:pr.vis,urot:[0,0,0]}));
}
function rotMat3(ax,ay,az){ // degrees; row-vector convention identical to build_textured.rot_matrix
  ax*=Math.PI/180;ay*=Math.PI/180;az*=Math.PI/180;
  const cx=Math.cos(ax),sx=Math.sin(ax),cy=Math.cos(ay),sy=Math.sin(ay),cz=Math.cos(az),sz=Math.sin(az);
  return [[cy*cz,cy*sz,-sy],[sx*sy*cz-cx*sz,sx*sy*sz+cx*cz,sx*cy],[cx*sy*cz+sx*sz,cx*sy*sz-sx*cz,cx*cy]];
}
function mat3mul(A,B){ // row-vector: (A·B)[i][j]=Σk A[i][k]B[k][j]
  const C=[[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)C[i][j]=A[i][0]*B[0][j]+A[i][1]*B[1][j]+A[i][2]*B[2][j];
  return C;
}
// ========================= ACTOR CONTROL SYSTEM (behaviour dispatch) =========================
// Each placed actor carries a `beh` byte. The ROM's per-frame actor loop (func_150039E0) looks up
// D_80088C90[beh] (12-byte records; word0 = the update handler fn) and calls it on the live actor.
// We replicate the handlers that produce IDLE, deterministic, self-contained visible motion (no
// player / RNG / world-state deps), computed EXACTLY as the ROM handler does. Actor transform fields
// (decoded from the verified choc handler func_15119FC0): +0x0/4/8 (f32)=rot X/Y/Z deg,
// +0x10/12/14 (s16)=pos X/Y/Z, +0x7C=phase/state. Per-frame delta dt = D_800BE9E4 = 2 in normal play
// (a cutscene timeline can override it; not modelled here). D_800A32F4 = 2*pi/65536 = BAU->radians.
// Triage of the top behaviours (from the asm): 0x4a=positional SOUND, 0x19=animated TEXTURE (own path),
// 0x16=no-op, 0x11=effect sequencer, 0x18=runtime ballistic projectile, 0x45=mostly triggered hinge.
// The real IDLE geometric movers are 0x10 (float) and 0x28 (spin+wobble).
const BAU=2*Math.PI/65536;

// beh 0x10 = collectible "chocolate" pickup (external object 3, texid 0xbb) -> func_15119FC0.
// Fully hardcoded deterministic float+spin (NO RNG, NOT init-seeded, so every chocolate is in sync):
//   phase(rad) += (pi/36)*dt, wraps at 6*pi   -> in viewer 30fps-frame units: phase = (pi/36)*animT
//   yaw  (rotY) = phase*(60/pi) deg           -> net 60/36 = 1.6667 deg/frame (one spin ~= 216f / 7.2s)
//   tilt (rotX) = sinf(phase)*15 deg,  (rotZ) = cosf(phase)*15 deg   (a gentle 2.4s conical wobble)
//   bob  (Y)    = trunc(cosf(2*phase)*10) + baseY + 10  world units  (double-freq; floats 0..20 above)
function chocFloat(T){
  const phase=(Math.PI/36)*animT;
  return { rx:Math.sin(phase)*15, ry:(phase*(60/Math.PI))%360, rz:Math.cos(phase)*15,
           ty:T[1]+Math.trunc(Math.cos(2*phase)*10)+10 };
}
// beh 0x28 = spinning interactive object (a contiguous ext-1 model class, ids ~57..87: switches /
// pads / pickups) -> func_1511DF6C. IDLE component of its main path (.L1511E04C), which runs for all
// model ids EXCEPT 0x59/0x5A (those branch straight to the rise state machine):
//   rotY (+0x4) += 1.52*dt      -> +3.04 deg/frame  (continuous yaw; one spin ~= 118f / 3.9s)
//   rotX (+0x0)  = 8.0*cosf(A*BAU),  A += 507*dt     (~2.15s conical sway about X)
// The handler also writes 12*cosf(B) to +0x18 (a field outside the rendered rot triple) and, when the
// PLAYER steps near, plays a rise/bounce on +0x2C/30/34 — both omitted (no player present -> at rest).
function beh28(pr){
  const dt=2;
  return { rx:8.0*Math.cos((507*dt*animT)*BAU),
           ry:(pr.rot[1]+1.52*dt*animT)%360, rz:pr.rot[2] };
}
// Dispatch a placed actor's per-frame idle transform, or null if it has no self-animating motion.
// NOTE beh 0x28 (beh28) is HELD OFF: func_1511DF6C is really a PLAYER-PROXIMITY-triggered spawner/popup,
// and its placed set includes full skeletal NPCs (id 84 = 56 bones, 58/61 = 46, 94 = 52) — a blanket
// top-spin on those is almost certainly wrong, and whether they even render/spin while dormant needs
// live-ROM confirmation. Re-enable once verified. Only the fully-verified beh 0x10 float is applied.
function behXform(pr,T){
  if(pr.beh===0x10)return chocFloat(T);
  return null;
}
// ============================ PLAY MODE (driveable Conker) ============================
// Spawn the real Conker model standing IN the level. v1 = spawn + idle animation + tunable world scale,
// proving the world-space skinning keystone (shared by the player and the NPCs). Toggle 'P'; scale '['/']'.
// ROM ground truth wired in the next pass (movement/control): input D_800BE710 (held buttons) /
// D_800BE748 (raw pad, stick s8 @+2/+3); walk 267 / run 530, accel 400, turn 2.8; gravity ~4-5, jump ~45;
// pos+=vel*1.0/frame; anim idle=15, walk=unk244 (speed-scaled), jump=55 (see conker-player-movement).
// size = a friendly multiplier on the level's own geometry scale (mesh._s) -> Conker auto-fits the level
// on spawn (size 1.0), and [ / ] nudge it. Absolute world scale = mesh._s * size (see playerWorldMat).
const BUILD='2026-07-28 · v48 ANIMATED HELD PROPS - the real fix for the "spiky / messed-up props" + the yo-yo not animating. ROOT CAUSE (corrected - my earlier "triangle decoder bug" theory was WRONG): the triangle decode is CORRECT (verified - Conker\'s custom 0x10-0x1F commands = "Tri4", always 4 independent tris; CRC-matched to the ROM microcode dispatch @0x3C124 AND GLideN64 F3DEX2CBFD; our bit-extraction already right). The articulated held props (pocket-watch CHAIN, yo-yo, obj136 strip) are skinned to their OWN little sub-skeleton, and were drawn in raw BIND pose - which spreads the bones apart so every triangle that bridges two bone-segments STRETCHES into a spike, with gaps between (watch = 29%, obj136 = 83% cross-segment tris). That is identical to why the yo-yo would not go up/down: its own animation was never applied. FIX (fully ROM-sourced across 4 asm-tracing agents): each animated prop = assets09[objId] mesh + assets0A[packId] animation clip (packId = D_80086CC4 attach-record byte@6, type==2, via func_15083568). Now exported as a POSABLE (bone-LOCAL verts tagged by G_MTX slot) and the viewer skins + poses its sub-skeleton with the prop\'s OWN clip 0 on a fixed 30fps loop (clipAngles/poseWorld - the same engine as Conker), mounted on Conker\'s hand bone at native 1:1 scale -> the mesh folds into its real shape AND animates (watch chain swings, yo-yo goes up/down). Animated props: 141 watch(9 bones/pack7), 136(7/pack5), 131(4/pack0), 137(4/pack9), 142(8/pack6); aoff=1, verified every bone maps to a valid clip element (badbone=0). Also corrected FIDGET obj135->136 (135 was never a real ROM attach id). Rigid props (28,25,31,...) stay static at native scale (the v47 fix). --- v47 HELD-PROP ATTACH FIXED (ROM-sourced, 2-agent asm trace) + mouth smile RESTORED. PROPS: every fidget/held prop was mounted with a NON-ROM auto-fit that shrank the prop to 42 units AND centred it on its own mesh centroid (floating it off its grip origin) - that is the "wrong size / random triangles in wrong spots". The meshes themselves are PERFECT (rendered the pocket-watch, GameBoy strip and mug offline - all coherent). The real ROM op-0x69 attach (func_15030468 render + func_15030AF4 node create, game_5D2C0.c) draws the child at NATIVE 1:1 scale (node.unk40 = 1.0f) with its ROOT ORIGIN seated DIRECTLY on the parent hand-bone world matrix (childMatrix = parent.unk1D4[bone*0x40]; node.unk44 offset null, node.unk22 rot 0 by default). assets09 props are authored in Conker\'s OWN unit system (watch ~130u vs body ~161u) so 1:1 is right. Fix = scale 1.0, offset 0, mesh seated on the bone. CAVEAT: a WHOLE-object attach is drawn RIGID (bind pose); an articulated prop (watch chain / segmented strip) that the ROM would POSE via its own sub-skeleton animation shows its straight bind pose here - posing the child skeleton is a documented refinement. MOUTH: REVERTED the v46 static key14 bake - the head keeps morph key0 (your correct half-open smile) at idle. My v46 bake had a vertex off-by-one (the morph key has 338 verts, I patched 337) which read as WIDE OPEN. The moving-close will be done as a RUNTIME lerp to key14 (ROM expr-0x2A mouthKey confirmed = 0x0e = 14), not a static bake. --- v46 MOUTH morph baked (closed) [REVERTED in v47]. Conker mouth = ROM vertex-MORPH (func_1517AD00): the base head mesh = morph key0 (OPEN, what the viewer showed); the game replaces the FACE submesh with a morph key each frame, and the MOVING expression (0x2A) uses mouthKey 14. Fully sourced the morph data: assets13[config0=model0][submesh0=337-vert face][key14], s16 x/y/z, and VERIFIED the correspondence (base Vtx[496+i] == morph key0[i], 337/337). The build now overwrites those 337 face verts with key14 so the baked head wears the moving/closed mouth. NOTE: this is baked ALWAYS (idle too); key14 is a subtle change from key0 so judge on the real render - if it does not read as closed enough I can bake a different key or do an idle-open/moving-closed swap. --- v45 DUST TUNED (per feedback: untextured / lingered / drifted too high). Texture -> a GRAINY tan soft-puff (was a smooth glowing dot). Dynamics: the ROM integrator accelerates dust UPWARD forever (~3x char-height rise) which looked wrong, so it now rises GENTLY then SETTLES (downward accel), tighter foot cluster, life cut 50-100 -> 14-30 ticks with a fast fade. --- v44 DIRT/SKID DUST + eyes narrow-only (no bloodshot). DUST: ROM particle burst (func_1515B674 + integrator func_1515B994, game_188440) - 10 upward-drifting tan billboards kicked up at the feet, initial vy 0..3, constant UPWARD accel (dust billows up, no gravity), the puff EXPANDS as it rises, 50-100 tick life w/ fade under 20. Fires continuous foot-puffs while running + a heavier trail on a hard skid/reverse + a burst on landing. EYES: removed the bloodshot iris swap - per your note bloodshot is a separate hungover state; running just NARROWS. Kept the narrowed move-sclera (ROM 0x798). KNOWN/WIP: (a) the narrow eyelid SHAPE - you want the inner corner (toward the nose) arched down to the bottom w/ the outer up; 0x798 is the ROM-sourced move frame but reads more symmetric here - refining the exact frame/orientation. (b) MOUTH should CLOSE when moving - it is a ROM vertex-MORPH (func_1517AD00, record[0x134] key); the static head bakes OPEN, so closing it needs the morph-target data (being sourced). --- v43 MOVING FACE (eyes frown + bloodshot). ROM-sourced: when Conker moves (xz_velocity>2.0/tick, func_15065A5C:550-608) the action state sets expression 0x2A (func_1507EB4C->func_1507E5C8), whose assets11 pose descriptor = NARROWED FROWN sclera 0x798 (both eyes) + BLOODSHOT iris 0xe49 (red exertion veins), decoded byte-exact from the descriptor table (base=u32(pose,8), desc=base+0x2A*10). The build now bakes those frames onto Conker eyes and the viewer swaps sclera->0x798 + iris->0xe49 while moving, reverting to the blinking neutral eye at idle. MOUTH: already correct - the ROM mouth is a vertex-morph (func_1517AD00) whose REST/neutral shape reads SHUT; it only OPENS during idle jabber, so a static-head viewer is already mouth-shut while moving (no change needed). --- v42 TAIL IDLE-LIFT (the real fix) + SWAY SCALE. You were right that v41 sat too low + clipped the floor — I was MISSING the ROM idle-amplitude branch. (1) IDLE LIFT: at rest the ROM adds f24 = 60 - 2*velocity, distributed through the ampY table {0.4,5.6,-0.6,-0.64,1.0} across all 5 tail points (func_1503B9BC @1503C294-C420). That +336 on joint 1 is what CURLS THE TAIL UP at idle (~+40deg base / +60deg tip, validated offline) instead of the -11deg droop. My v41 only had the MOVING sway (which is zero at idle), so it drooped. This is the sourced up-tail (no fudge, still on the correct bone-0 anchor so no V-kink). (2) SWAY UNDER-THE-FLOOR: the moving sway input was ~5x too big (I fed per-SECOND speed; the ROM record[0x3C] is per-TICK = velocity/30 = 8.9 walk / 12.3 run). Fixed -> the tail whips within bounds, no floor clipping. (3) Verified the write-back is NOT axis-reversed (it reconstructs the chain exactly). (4) Confirmed via the literal copy-list (D_80098780 through a2p) that idle+walk are PHYSICS (not clip-copy) -> the up-tail must come from the idle-amplitude, which it now does. NEXT (needs a texture bake + full rebuild): the MOVING FACE - eyes FROWN (held sclera expr, record[0x6C]>=0xA, frown frame ~0x792) + mouth-shut (already correct: the static head reads shut; game only opens it at idle). --- v41 TAIL ROM-ACCURATE ANCHOR + HOVER SPIN + LANDING (2 adversarial RE workflows, all ASM-cited). (1) ANCHOR FIX — the tail chain anchors on BONE 0 (posed pelvis-root), NOT the feet (ROM func_1503B9BC @1503BB6C-BB94: D_800C4008 = record[0x1D4] mtx[0] translation). My v40 "feet" anchor (~65deg vertical) was an UNSOURCED FUDGE — and it was the literal CAUSE of the middle V-kink and the running base-collapse (it forced the first segment vertical, hitting the look-at singularity -> NaN -> flat plane). The ROM tail sits LOW/back (~-11deg) at idle and WHIPS UP dramatically when moving (5.6x sway spike on joint 1, ampY D_80098740). You chose ROM-accurate; this is the real thing, and it kills the V-kink + collapse + stiffness at the root. (2) HOVER SPIN FIXED — the tail-spin hover no longer freezes pointing up: during hover the ROM forces COPY mode (physics off) and the hover CLIP (aid20/animId233) spins bone24 324deg about Z (verified in the built clip data). The viewer now skips the dangly write-back during hover so the clip drives the rotor. (3) LOOK-AT degeneracy guard + NaN-proof fallback (safety net for vertical segments). (4) BLINK — extended the closed-hold so the lid actually reaches the SHUT frame and holds ~3 ticks (was a ~1-tick mid-frame flash, too fast to see). (5) STANDING-JUMP LANDING — animId 66 is the MOVING land (ROM func_1504CB98 @1504D894 gates xz_velocity>5/tick); a STANDING jump now plays NO land clip and blends straight to idle (was wrongly ending on the 66 crouch). (6) Exhaustive ASM sweep CONFIRMED func_1503B9BC is the ONLY tail controller for Conker (no missed 2nd spring/IK). COMING v42: the ROM SCALE refactor (single 1:1 unit system, delete CHAR_FIT=0.51 + JUMP_SCALE fudges -> fixes movement/jump/anim TIMING), full standing-jump arc (hop owns the whole airtime), and the skid = momentum facing-arc + body lean(0.75 on reversal) + DUST burst (there is NO skid animation in the ROM). --- v40 CRASH FIX: entering play mode (P) reset PLAYER.tail to the OLD additive-spring struct {x,xv,y,yv} (no .pt chain), so the new solver hit undefined.pt on the first frame. Now resets to tailInit() (+ eye/landTimer), with a guard in tailSolve. --- v39 LANDING clip wired (ROM animId 66/0x42 — verified it fires for the FREE-PLAY player via the generic biped update func_1504CB98:4474, NOT scripted-only like the skid). Conker now plays a brief impact/landing pose on touchdown after a real fall, cancelled the instant you move. --- v38 EYE AUTO-BLINK added (ROM func_1507E2B0 timer + func_1502EEF4/func_1502EE8C lid stepper + func_1502F01C sclera-frame swap). Conker now blinks on the real ROM cadence: a random 10..149-tick hold open, then a ~1-tick flick of the sclera to its blink frame. The blink/shut sclera frames (texids 0x793/0x794) were reversed from the pose LUT, baked into the build (they were missing — only the open frame 0x791 was), and swapped live on the eye groups. Idle-life cue the viewer never had. --- v37 REAL TAIL (ROM func_1503B9BC solver + func_1503CB98 write-back + func_150440A0 look-at — fully reversed and adversarially verified against the asm by an 8-agent workflow). The tail is no longer an offset on the clip: it is the ACTUAL dangly-chain — a 5-point, length-constrained spring chain (segLen 52.26/55.30/50/26, springs XZ 0.30/0.20/0.10/0.05, Y 0.225/0.15/0.75/0.80, 45deg/joint bend clamp) whose per-bone orientation OVERWRITES bones 24-27, exactly as the ROM overwrites the palette. The rest tail now ARCHES NEAR-VERTICAL (~65deg) — the literal ROM geometry, not a fudge: the chain reference point is the GROUND/feet (the ROM object position), which sits far below the tail-base, so the straight rest chain points up. Validated offline (poseWorld reconstructs the chain to 65deg elevation). Idle = the ROM RNG damped-flick LATERAL twitch (intermittent side-to-side, squirrel-like); moving = the speed-scaled vertical sway. Press T to compare against the old clip pose. NEXT: eye/auto-blink + landing clip (both reversed; pending texture/verify deps). --- v35: TAIL AXIS FIX. The v34 diagnostic paid off — pressing Y (which folded the tail out of view) PROVED the render path is live, and told me exactly what was wrong: I was feeding the twitch into PITCH, which pitched the tail-base up ~34deg and TUCKED the whole tail into the body (the "disappear"), while a smaller pitch just looked like it "sat the same". But the ROM twitch is NOT vertical — func_1503B9BC adds a=sin(p40)*p48 (base) and b=5a (tip) to the tail points X/Z, i.e. the HORIZONTAL plane. So the real motion is a SIDE-TO-SIDE flick, ~5x stronger at the tip. v35 drives pure LATERAL YAW (base->tip 0.45/0.66/0.90, spring-lagged) with pitch forced to 0 so it can never tuck/disappear, on the exact RNG damped-flick timing (intermittent squirrel flicks + moving sway). Default = the real state machine; press Y for a big pure-lateral test wag, T to toggle off. TELL ME: (1) is the tail now flicking SIDE TO SIDE at idle? (2) separately, does it still SIT too LOW (rest height)? — those are two different fixes and I want to nail the flick first. --- v34 DIAGNOSTIC: the tail render path checks out on paper (the state machine produces ±34° swings, the tail geometry is on bones 25/26/27 which I DO rotate, and the composed angles reach skinPose) yet you see nothing — so this build removes every variable and FORCES a big, continuous, unmistakable tail WAG. The HUD now shows "TAIL ON [DIAG WAG]  oy_tip=..." with a live number. TEST: standing still, does the tail visibly swing side-to-side / up-down? (1) If YES -> the render path is LIVE and my real state machine just needs its amplitude/rest tuned; press Y to switch to [ROM state machine] and tell me how it differs. (2) If NO, even with DIAG -> the path or the toggle is the bug, and the HUD oy_tip number tells me which (moving number = code runs but render dead; frozen number = code not running). Press T to toggle the tail entirely. Just tell me: does the DIAG wag move, yes or no? --- v33: TAIL now driven by the ROM state machine (fully reversed func_1503B9BC, all 1222 lines, constants verified). The stiffness was because my v31 spring settled to ZERO at idle — but the real solver keeps the tail alive at rest via a separate RNG DAMPED-FLICK state machine (p40 advances ±10..19deg/fr, halves its amplitude each bounce, rests rand%200 fr, re-seeds). That is the "twitchy squirrel" idle. v33 runs that exact state machine + the moving speed-scaled sinusoid, spring-lagged onto tail bones 25/26/27 (pitch/yaw). Real constants: seg 52.26/55.30/50.00/26.00, spring 0.30/0.20/0.10/0.05, 45deg bend clamp. [The drive/timing/damping is exact; it is applied as bone rotations rather than the full length-constrained position chain, so amplitudes are tunable — toggle T, and tell me if the idle flick is too big/small or wrong axis.] Prior "double-sine" label was WRONG (no sin freq consts; those were deg2rad). --- v32: REVERTED the v30/v31 element-0 root channel — applying it as a whole-body rotation made Conker WOBBLE back-and-forth at idle (the ~13deg breathing pitch) and go HORIZONTAL on clips carrying a large element-0 value (wrong pivot + magnitude at the root). Root is stable again. The tail elevation/breathing will be redone with a correct feet-pivot + clamped magnitude, tested, before re-enabling. The TAIL SPRING (dangly-chain lag) is KEPT — it only moves tail bones 25/26/27 and settles to zero at idle, so it cannot cause the body wobble/horizontal (toggle T). --- v31: TAIL SPRING ported (the dangly-chain you were right about). The ROM tail IS a per-bone spring — func_1503B9BC computes a LAGGING spring-chain, func_1503CB98 orients tail bones 24-27 along it (spring-lerp pos+=(target-pos)*k). It lives in game_61490/68C70, NOT the pose pipeline I kept re-checking — that is why 5 prior traces "found nothing." Ported as a per-bone driven damped spring (k=D_80098710=0.30): the body TURN swings the tail laterally + vertical velocity swings it up/down, it LAGS then springs back and cascades down the chain; settles to ZERO at rest so idle life stays the element-0 breathing. [First-pass structural port with the real spring constant; amplitudes/axes to refine to byte-exact once the 1222-line point-solver is fully reversed — toggle with T to compare.] STILL PENDING: the feet-out SKID clip (confirmed to exist via func_15056A00/D_80099A3C but its animId->pair mapping needs pinning: a2p says animId 2 = the WALK clip, conflicting with the agent decode, so NOT wired yet to avoid a wrong-clip mistake). --- v30: TAIL/IDLE — the user was RIGHT, found it. Every animation clip carries an ELEMENT 0 = a whole-body ROOT/base channel (authored breathing / weight-shift / tail-lift) that the ROM applies above bone0 (func_150A81D0) but the viewer was DROPPING (bone loop only reads elems 1..28 = bone.rot+aoff, never 0). That is why idle looked frozen and the tail sat low/flat. Now clipAngles reads element 0 and poseWorld applies it above the skeleton root -> the idle body gently rocks (~1.8s breathing loop, X pitch -17..+10) and the tail base sweeps +22..+49 (the "twitchy squirrel" life + higher rest tail). Applied X(pitch)/Z(roll) ONLY — element-0 Y is the large locomotion/facing yaw (walk +-75, turn +-150) handled by the runtime facing, so skipped to not corrupt walk/turn. STILL TO PORT (found, sourced, next build): (1) the procedural TAIL DANGLY-CHAIN spring func_1503B9BC/func_1503CB98 (game_61490/68C70) = velocity double-sine sway + spring-lag + length constraints on bones 24-27; (2) the feet-out SLIDE/SKID clip (animId 2/3 via turn matrix D_80099A3C, func_15056A00, played speed-scaled on a sharp reversal) + landing-skid 549. Both confirmed to EXIST from source (user was right on both). --- v29: PLAYBACK RATE re-derived from the ROM (func_1507BDB0.s:51/64/275 — phase += rate*D_800BE9A4*actorSpeed, D_800BE9A4=1.0, frame-comp tick sum = 30/sec => keyframes/sec = 30*rate/iv). Global cadence fudge 1.18 -> the SOURCED 1.0 (everything was ~18% off). LOCOMOTION cadence rebuilt from func_1505841C (game_83300.c:372) — velocity-LINEAR with floor 0.1+0.4=0.5 and NO saturation (the old min(1,spd/267) flat-lined the run = the "runs slow" bug); speed cap raised 267->370 (gait D_800A34B0 run tier) so full input actually RUNS (and SLIDE_THRESH = 370*0.81 = 300 = the sourced slide-lock). JUMP: running somersault (animId55) now OWNS the whole airtime and its rate locks to the airtime so it is ONE continuous spin takeoff->land (no more jump-pose/spin/land segmentation). The legs-up FLAIL (fall-distance>450, sourced via the 0x1CA fall-damage counter func_1505B5F8 -> func_1505E874.s:134 clip remap) was re-ordered BELOW the somersault so it only catches Z high-jump / big-ledge descents (~470>450), never a normal running jump. SLIDE + TAIL: re-confirmed from source across 5 traces — NO body slide clip (slide state func_15129934 makes zero anim calls; it is physics + dust VFX) and NO per-bone tail system (pose pipeline is 4 funcs, whole-skeleton crossfade only); tail liveliness = the fidget clips (verified byte-accurate 180/60/30-tick cadence) + whole-body root lean. --- v28: REVERSAL SLIDE-STOP — running one way then reversing now HOLDS the facing and slides straight to a near-stop, THEN turns (latched; no more circular arc). TAP fix — accel gentler (1.5) + momentum RESET on release so a tap moves ~1/4 as far (still eases in ~1.3s). PIVOT clip REMOVED (pack pair 187 was an arm gesture / pocket-grab, not a pivot; the ROM direction-change reaction is the slide-stop physics, no skid clip exists). IDLE FOOT DE-SWAY — feet-midpoint pinned in XZ so the body sways over PLANTED feet (was: feet skating side-to-side). --- v27: MOVEMENT recalibrated — gentle ACCEL (ease-in; a tap = a minimal nudge, not a 5× coast) + crisp STOP (~0.33s) + soft high-speed SLIDE (latched ~0.5s) + responsive turns (tap≈minimal, 90°≈0.27s); fixed the v25 "2-second" over-softness. PIVOT clip wired (ROM animId 0x76 = pair 187) on sharp direction changes — the sourced turn/pivot pose (no dedicated feet-out slide clip exists in the ROM; the engine has no leg-only mask — verified). FOOT-PLANT: lowest posed foot stays on the floor, body bobs off it (was floating from body-centre). (heli min-hover being re-verified from asm.) --- v25 (ALL SOURCED from asm, 4 traces): SLIDE = ROM momentum springs — facing LOCKS above 0.81×top-speed (ROM 300/370, func_15124C38) so at run speed a hard reversal can\'t redirect = slide to a stop THEN turns; speed spring soft-decel (1/2) glides high-speed stops; below threshold = crisp turns (fixes "turning feels slow"). FLAIL-FALL now gated by fall-distance >450 ROM units (func_1505B5F8) — normal jump (~232) never flails, Z-jump (~470) does (removed the zJump/charH heuristic). SOMERSAULT = FIXED 0.8× (D_80099650), not trajectory-tweened (fixes "too fast"). TAIL: removed the procedural pin — now pure keyframe (idle curl + FIDGET whips 45-132° + turn clip) + whole-body root lean, exactly like the ROM (no per-bone spring exists; the pin was the stiffness).';   // bump on every publish so a cached vs fresh build is obvious
try{console.log('%c[conker viewer] build '+BUILD,'color:#7cf');}catch(e){}
// RANDOM IDLE-FIDGETS — ROM-SOURCED (game_AC030.c func_1507F640 = the aiIdx=1 "idle brain" of base idle animId 15).
// Conker's real random idles are PLAYLISTS in D_80086BA0 (each a sequence of fidget descriptors D_8009B8B0
// {animId,speed,blend}); the brain plays a whole sequence, then settles back to base idle. (The OLD D_80099AB4
// codes were the generic-NPC biped-brain STATE table, NOT player animIds — that was the salute/crawl/swim bug.)
// Each item = [pairIndex, speedPct]; sequences are exact from the ROM data (dropped seq3=broken mesh a175,
// seq15=a73 "holding a bomb" weapon-context idle). Prop-mime sequences (Game Boy/magazine/etc.) play the correct
// MOTION; the socketed object mesh (op-0x69 attach -> child object) is a separate step still being wired.
const FIDGET_SEQS=[
  [[104,100]],[[290,100]],[[177,100]],[[176,100]],
  [[154,100],[156,100],[155,100],[155,100],[157,100]],
  [[154,100],[156,100],[155,100],[155,100],[155,100],[155,100],[156,100],[156,100],[155,100],[155,100],[155,100],[155,100],[155,100],[155,100],[156,100],[156,100],[156,100],[156,100],[157,100]],
  [[143,100],[144,100],[153,100]],[[149,100]],[[150,100]],[[131,100]],[[132,100]],
  [[127,100],[128,100],[186,100],[128,100],[129,100]],
  [[108,100],[109,120],[288,100]],
  [[96,100],[97,100],[99,100]],
  [[83,100],[82,100],[82,100],[82,100],[82,100],[82,100],[84,100]],
  [[83,100],[82,100],[82,100],[82,100],[85,100],[82,100],[82,100],[85,100],[82,100],[82,100],[86,100],[82,100],[82,100],[84,100]],
  [[24,100],[24,100],[8,100],[24,100],[7,100]],
  [[90,100],[91,100],[92,100]],[[56,100]],
  [[164,100],[165,100],[7,100]],[[94,100]]];
// brain: idle-time delay before the NEXT fidget SHRINKS as Conker keeps standing (ROM func_1507F4C0, frames):
//   phase0 180+rand60 (~6-8s), phase1 60+rand60 (~2-4s), phase>=2 rand30 (~0-1s) = he gets restless.
function fidgetDelay(ph){return ph<=0?180+(Math.random()*60|0):ph===1?60+(Math.random()*60|0):(Math.random()*30|0);}
// selection = shuffle-bag (ROM func_1507EC38: random, filtered against a recent-use buffer -> no quick repeats).
function pickFidgetSeq(){const F=PLAYER.fidget,n=FIDGET_SEQS.length;let i,t=0;do{i=Math.random()*n|0;t++;}while(F.recent.indexOf(i)>=0&&t<24);F.recent.push(i);if(F.recent.length>7)F.recent.shift();return i;}
// PROP OBJECTS socketed during prop-mime fidgets (ROM clip op 0x69 -> D_80086CC4[param-1] = {objId,bone}).
// Parallel to FIDGET_SEQS by index: {o:objId (mesh = DATA.objects[objId]), b:bone SLOT, i:item to attach from}.
// obj135/136 = Game Boy slab (a03#67/68) @hand bone 9; 25/28/31/141 = magazine/toy props; 131 @bone19. (seq15
// bomb obj137 was dropped from FIDGET_SEQS.) The mesh is mounted on the posed bone by drawPosable (opts.attach).
// obj135 was a wrong id (NOT in the ROM D_80086CC4 attach table) -> corrected to obj136 (the real 7-bone
// animated "GameBoy" strip, attachId 28 / pack5). Animated props (141 watch, 136, 131) now pose+animate; the
// rest (28,25,31) are rigid static meshes at native scale.
const FIDGET_ATTACH=[null,null,{o:141,b:9},null,null,null,null,null,null,null,null,{o:131,b:19},{o:28,b:9},{o:136,b:9},{o:136,b:9},{o:136,b:9},null,{o:25,b:9},null,{o:31,b:9},null];
const _propParts={};
// objId -> objects[] index by ASSET NUMBER (the ROM resolves op-0x69 attach as assets09[objId] via func_1502FE10
// / func_1502B6BC(...,grp 9,objId)). DATA.objects is name-sorted, so we match the a09 item number == objId,
// NOT the array index (validated: objId141 -> a09#141 = the pocket watch).
let _a09idx=null;
function a09Index(){ if(_a09idx)return _a09idx; _a09idx={};
  const O=(typeof DATA!=='undefined'&&DATA.objects)?DATA.objects:[];
  for(let i=0;i<O.length;i++){const m=(O[i].name||'').match(/a09\D*(\d{3,4})/); if(m){const n=+m[1]; if(_a09idx[n]===undefined)_a09idx[n]=i;}}
  return _a09idx; }
// ARTICULATED held props (op-0x69 type==2): objId -> the exported posable prop {objId,bone,pack,bones,groups}.
// These are skinned+posed by their OWN sub-skeleton (assets0A clip) so they fold into shape + animate, instead
// of the stretched static bind mesh. (Sourced: D_80086CC4/func_15083568; watch141/pack7, 136/pack5, 131/pack0,
// 137/pack9, 142/pack6.) Non-animated props fall through to the static native-scale mesh below.
let _propAnimMap=null;
function propAnimEntry(objId){
  if(_propAnimMap===null){ _propAnimMap={}; if(typeof DATA!=='undefined'&&DATA.propanim) for(const p of DATA.propanim) _propAnimMap[p.objId]=p; }
  return _propAnimMap[objId]||null;
}
function getPropPart(objId,bone){
  const k=objId+'@'+bone; if(_propParts[k]!==undefined)return _propParts[k];
  const pe=propAnimEntry(objId);
  // ROM-correct mount bone: the propanim entry carries the D_80086CC4 bone slot for this objId (obj141->9=L hand,
  // obj131->19=R foot/keepie-uppie, obj137->0=pelvis, etc.). Use it verbatim instead of the caller's guessed bone
  // so every held prop sockets exactly where the ROM attaches it, regardless of which fidget triggered it.
  if(pe){ try{ preparePosable(pe); }catch(e){ _propParts[k]=null; return null; } const part={animated:true,mesh:pe,bone:(pe.bone!=null?pe.bone:bone)}; _propParts[k]=part; return part; }
  const idx=a09Index()[objId];
  const o=(idx!=null&&DATA.objects[idx])?DATA.objects[idx]:null;
  if(!o||!o.groups||!o.groups.length){_propParts[k]=null;return null;}
  // ROM-ACCURATE op-0x69 held-object attach (func_15030468 render + func_15030AF4 node create, game_5D2C0.c):
  // the child object is drawn at NATIVE 1:1 scale (node.unk40 = 1.0f) with its ROOT ORIGIN seated DIRECTLY on
  // the parent bone's world matrix — childMatrix = parent.unk1D4[bone*0x40], with node.unk44 (offset) null and
  // node.unk22 (rotation) 0 by default. assets09 props are authored in Conker's OWN unit system (watch ~130u,
  // Conker body ~161u), so the mesh is mounted 1:1, verts run through the same bone palette as his limbs.
  // The OLD auto-fit (42/ext) + centroid-centering was the bug: it shrank every prop to 42u and floated it off
  // its grip origin, so props read as wrong-size / "random triangles in wrong spots". No fit, no centering.
  const part={g:o.groups,bone:bone,off:[0,0,0],scale:1.0};
  _propParts[k]=part; return part;
}
function clipLen(m,idx){const c=(m&&m._pose&&m._pose.clips)?m._pose.clips[idx]:null; return c?c.n*Math.max(1,c.iv):1;}
// ================= CONKER TAIL DANGLY-CHAIN — ROM func_1503B9BC (solver) + func_1503CB98 (write-back) + func_150440A0 (look-at) =================
// The ROM does NOT offset the clip tail — it OVERWRITES bones 24-27 with absolute look-at matrices built from a 5-point,
// length-constrained spring chain. REST = a STRAIGHT chain along normalize(bone24_pos - rootRef); rootRef = the object
// GROUND/feet position (base-matrix translation), which sits far below the tail base -> the chain arches UP (~65deg here,
// verified). NO gravity/curl term. Idle = a lateral RNG damped-flick twitch; moving = a vertical speed-scaled sway.
const TAIL_SEGLEN=[52.26,55.30,50.00,26.00];  // D_800986F0 (== bind bone spacing 24->25->26->27->tip)
const TAIL_SPRXZ =[0.30,0.20,0.10,0.05];      // D_80098710 per-joint XZ lerp
const TAIL_SPRY  =[0.225,0.15,0.75,0.80];     // D_80098720 per-joint Y lerp (stiff at tip)
const TAIL_BEND  =[45,45,45,45];              // D_80098730 max bend/joint/frame (deg)
const TAIL_AMPY  =[0.4,5.6,-0.6,-0.64,1.0];   // D_80098740 moving-sway Y distribution across pt0..pt4
const TD2R=0.017453292, TR2D=57.29578;
const TAIL={enabled:true};
const _R8=()=>Math.floor(Math.random()*256);  // emulate u8 func_150ADA20
const _tsub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const _tdot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const _tcrs=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const _tnrm=a=>{const L=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/L,a[1]/L,a[2]/L];};
const TAIL_BONEOFF={24:[0,-4.531,-23.239],25:[0,-4.894,-52.25],26:[0,0.099,-55.291],27:[0,3.937,-50]};
function tailInit(){return{pt:[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]],p3C:0,p40:0,p44:30.0,p48:0,p4C:_R8()%30,seeded:false};}
function _matToQuat(m){const m0=m[0],m1=m[1],m2=m[2],m4=m[4],m5=m[5],m6=m[6],m8=m[8],m9=m[9],mA=m[10];
  const tr=m0+m5+mA;let x,y,z,w,s;
  if(tr>0){s=Math.sqrt(tr+1)*2;w=s/4;x=(m6-m9)/s;y=(m8-m2)/s;z=(m1-m4)/s;}
  else if(m0>m5&&m0>mA){s=Math.sqrt(1+m0-m5-mA)*2;w=(m6-m9)/s;x=s/4;y=(m1+m4)/s;z=(m8+m2)/s;}
  else if(m5>mA){s=Math.sqrt(1+m5-m0-mA)*2;w=(m8-m2)/s;x=(m1+m4)/s;y=s/4;z=(m9+m6)/s;}
  else{s=Math.sqrt(1+mA-m0-m5)*2;w=(m1-m4)/s;x=(m8+m2)/s;y=(m9+m6)/s;z=s/4;}
  const L=Math.hypot(x,y,z,w)||1;return[x/L,y/L,z/L,w/L];}
function _invRigid(m){const ntx=-(m[12]*m[0]+m[13]*m[1]+m[14]*m[2]),nty=-(m[12]*m[4]+m[13]*m[5]+m[14]*m[6]),ntz=-(m[12]*m[8]+m[13]*m[9]+m[14]*m[10]);
  return[m[0],m[4],m[8],0, m[1],m[5],m[9],0, m[2],m[6],m[10],0, ntx,nty,ntz,1];}
// ONE fixed 30fps ROM update of the chain (func_1503B9BC steady state). Phases advance by 1/tick, NOT scaled by fr —
// the ROM runs at 30 game-updates/sec, and the twitch <15deg threshold + spring rates assume that fixed step.
function _tailTick(st, ctx, rootRef){
  st.pt[0]=ctx.p24.slice();                                          // pt0 = posed bone24 pos, re-slaved every tick
  const off=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
  // BASE SWAY (always, ROM 1503BDF8-BF30): off[0]/off[4] Y oscillate. amp = clamp(record[0x3C],0,60), *0.5 when moving (record[0x28]>3).
  let amp=Math.max(0,Math.min(60,ctx.speed)); if(ctx.speed>3) amp*=0.5;
  const swayA=Math.sin(st.p3C*TD2R)*amp;
  st.p3C+=amp; if(st.p3C>=360) st.p3C-=180;
  const swayB=Math.sin((st.p3C+180)*TD2R)*amp;
  off[0][1]+=swayA; off[4][1]+=swayB;
  const sH=Math.sin(ctx.facingRad||0), cH=Math.cos(ctx.facingRad||0);
  const special=(ctx.animId===0x22||ctx.animId===0x24||ctx.animId===0xD1);
  if(!special && ctx.speed<0.5){                                     // ROM IDLE branch (record[0x28]<0.5, func_1503B9BC @1503C228-C6B0): the amplitude that LIFTS the tail UP + the RNG twitch.
    const f24 = 60 - 2*Math.max(0,Math.min(30,ctx.speed));          // idle amplitude = 60 at rest (@1503C294-C2A8). This was the MISSING piece: distributing it curls the tail to ~+40deg base / +60deg tip (validated), instead of the -11deg droop.
    for(let i=0;i<5;i++) off[i][1] += f24 * TAIL_AMPY[i];            // f24*ampY into all 5 points (@1503C3C0-C420). ampY D_80098740={0.4,5.6,-0.6,-0.64,1.0}. (intensity ramp D_800C35EA/D_800C3C9D omitted = normal case.)
    if(st.p4C!==0){ st.p4C-=2;                                       // IDLE TWITCH (RNG damped-flick, LATERAL X/Z, @1503C428-C6AC)
      if(st.p4C<=0){ st.p40=0; st.p48=_R8()%100; const mag=(_R8()%10)+10; st.p44=(_R8()&1)?mag:-mag; st.p4C=0; } }
    else{ const a=Math.sin(st.p40*TD2R)*st.p48, b=Math.sin((st.p40+30)*TD2R)*st.p48*5;
      off[0][0]+=cH*a; off[0][2]+=-sH*a; off[4][0]+=cH*b; off[4][2]+=-sH*b;   // LATERAL flick (X/Z), never pitch
      st.p40+=st.p44;
      if(st.p40>360||st.p40<15){
        if(Math.abs(st.p44)>15){ st.p44*=0.5; st.p48*=0.5; st.p40+=(st.p40>360?-360:360); }
        else st.p4C=_R8()%200; } }
  }
  // length-constrained spring solver (func_1503C728) + EXACT segLen re-projection (func_1503B9BC 2nd half), i=0..3
  for(let i=0;i<4;i++){
    const prev=st.pt[i], ref=(i===0)?rootRef:st.pt[i-1];
    const cand=[prev[0]+off[i][0], prev[1]+off[i][1], prev[2]+off[i][2]];
    const dir=_tnrm(_tsub(cand,ref)), seg=TAIL_SEGLEN[i];
    const np=[prev[0]+dir[0]*seg, prev[1]+dir[1]*seg, prev[2]+dir[2]*seg];
    const kx=TAIL_SPRXZ[i], ky=TAIL_SPRY[i], p=st.pt[i+1];
    p[0]+=(np[0]-p[0])*kx; p[1]+=(np[1]-p[1])*ky; p[2]+=(np[2]-p[2])*kx;
    let sd=_tnrm(_tsub(p,st.pt[i]));
    const ang=Math.acos(Math.max(-1,Math.min(1,_tdot(dir,sd))))*TR2D;
    if(ang>TAIL_BEND[i]){ const f=1-TAIL_BEND[i]/ang;
      p[0]+=(np[0]-p[0])*f; p[1]+=(np[1]-p[1])*f; p[2]+=(np[2]-p[2])*f; sd=_tnrm(_tsub(p,st.pt[i])); }
    st.pt[i+1]=[st.pt[i][0]+sd[0]*seg, st.pt[i][1]+sd[1]*seg, st.pt[i][2]+sd[2]*seg];   // exact rigid segLen
  }
}
// ctx:{world0, p24, footY, speed, airborne, animId, fr, facingRad}. Returns {24:{q,t},25,26,27} to OVERWRITE in angles.
function tailSolve(st, ctx){
  if(!st.pt){ Object.assign(st, tailInit()); }                       // guard: re-init if a stale/old tail state slipped in
  const rootRef=[ctx.world0[12], ctx.world0[13], ctx.world0[14]];    // ROM anchor = BONE 0 posed world translation (func_1503B9BC @1503BB6C-BB94: D_800C4008 = record[0x1D4] mtx[0] +0x30/34/38). NOT feet. Rest dir = normalize(bone24 - bone0) = the pelvis->tail-base spine axis (~-11deg, low/back; whips up via 5.6x sway when moving). This is what kills the V-kink + plane-collapse (feet-anchor made seg0 vertical -> look-at singularity).
  st.pt[0]=ctx.p24.slice();
  if(!st.seeded){ const d=_tnrm(_tsub(st.pt[0],rootRef));            // seed straight chain up from the tail base
    for(let i=0;i<4;i++) st.pt[i+1]=[st.pt[i][0]+d[0]*TAIL_SEGLEN[i], st.pt[i][1]+d[1]*TAIL_SEGLEN[i], st.pt[i][2]+d[2]*TAIL_SEGLEN[i]];
    st.seeded=true; }
  st.acc=(st.acc||0)+(ctx.fr||1);                                    // run the physics at FIXED 30fps ticks
  let g=0; while(st.acc>=1 && g++<8){ st.acc-=1; _tailTick(st, ctx, rootRef); }
  // write-back (func_1503CB98 + func_150440A0): absolute look-at per bone -> local {q,t} for the parent-composed pipeline
  const out={}; let parentW=ctx.world0;
  for(let i=0;i<4;i++){
    let A=st.pt[i]; const B=st.pt[i+1];
    if(A[0]===B[0] && A[2]===B[2]) A=[A[0]+1, A[1], A[2]];            // ROM degeneracy guard (func_1503CB98 @1503CE2C): vertical segment -> nudge P.x+1 so cross(up,Z) never collapses to 0 (was the "solid plane" NaN)
    let Z=_tnrm(_tsub(A,B));                                          // bone +Z = A-B (up-chain); geometry -Z = segment dir
    let up=[parentW[4],parentW[5],parentW[6]]; let X=_tcrs(up,Z);     // up = normalized parent Y-axis (row 1), exactly as ROM
    let xl=Math.hypot(X[0],X[1],X[2]);
    if(xl<1e-4){ const alt=(Math.abs(Z[1])<0.9)?[0,1,0]:[1,0,0]; X=_tcrs(alt,Z); xl=Math.hypot(X[0],X[1],X[2]); }  // NaN-proof fallback if up still ~parallel to Z
    X=[X[0]/xl,X[1]/xl,X[2]/xl]; const Y=_tnrm(_tcrs(Z,X));
    const Wdes=[X[0],X[1],X[2],0, Y[0],Y[1],Y[2],0, Z[0],Z[1],Z[2],0, A[0],A[1],A[2],1];
    const local=rmul(Wdes, _invRigid(parentW));                      // world = local . parent  ->  local = world . parent^-1
    const bo=TAIL_BONEOFF[24+i];
    out[24+i]={q:_matToQuat(local), t:[local[12]-bo[0], local[13]-bo[1], local[14]-bo[2]]};
    parentW=Wdes;
  }
  return out;
}
// ===== CONKER AUTO-BLINK (ROM func_1507E2B0 timer + func_1502EEF4/func_1502EE8C lid stepper) =====
// Idle blink: the timer (record+0x6E) counts down by dt(=2)/tick; when it drops BELOW dt it toggles the lid bit
// (0x6A/0x6B) and arms a fresh random hold — RNG%0x8C+0xA (=10..149) ticks OPEN, 1 tick CLOSED. The lid stepper walks
// the sclera frame toward the toggle: open(0)->blink(1). Idle only reaches frame 1 (frame 2=shut is scripted). The
// sclera texture swaps between the baked [open,blink,shut] frames on the group's .blink array.
function romEyeTick(E){
  const dt=2;
  if(E.timer < dt){ E.timer=0; E.tgl^=1;                    // expire -> toggle lid (func_1507E2B0.s:44 predicate: <dt)
    if(E.tgl===1) E.timer=6;                                // closing: hold ~3 ticks so the lid can step 0->1->2 (reach SHUT) and hold briefly. ROM idle=1 tick (mid-frame flash only); extended for on-screen visibility per user ("slightly too fast to see").
    else E.timer=(Math.random()*0x8C|0)+0xA; }              // opening: 10..149 ticks
  else E.timer-=dt;                                         // still counting down
  if(E.tgl===0){ if(E.lid>0)E.lid--; } else { if(E.lid<2)E.lid++; }   // lid stepper toward the toggle
}
function updateEyes(fr){ const E=PLAYER.eye; if(!E)return; E.acc=(E.acc||0)+fr; let g=0; while(E.acc>=1&&g++<8){E.acc-=1;romEyeTick(E);} }
// ===== SKID / RUN DIRT DUST — ROM particle burst (func_1515B674 + integrator func_1515B994, game_188440) =====
// 10 upward-drifting billboards kicked up at the feet: initial vy in [0,3.008), a CONSTANT UPWARD accel ay in
// [0.105,0.210) (dust billows UP, no gravity), the puff EXPANDS as it rises (size = base + 0.5*grow*(vy+vy0)),
// lifetime 50-100 ticks with an alpha fade under 20 ticks. ROM fires on ground push-off + a continuous ~1/16fr puff
// while grounded; the viewer fires continuous puffs while running, a heavier burst on a hard skid/stop, + on landing.
let DUST_TEX=null, _dustBufs=null;
function dustTex(){
  if(DUST_TEX)return DUST_TEX;
  const S=48,cv=document.createElement('canvas');cv.width=cv.height=S;const cx=cv.getContext('2d');
  const img=cx.createImageData(S,S), d=img.data;                     // GRAINY soft puff (radial falloff x noise) so it reads as dust, not a glowing dot
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const dx=(x-(S-1)/2)/(S/2), dy=(y-(S-1)/2)/(S/2), r=Math.hypot(dx,dy);
    let a=Math.max(0,1-r); a=a*a*(0.5+0.5*Math.random());            // squared radial falloff + grain
    const o=(y*S+x)*4; d[o]=255;d[o+1]=255;d[o+2]=255;d[o+3]=Math.min(255,a*230)|0;
  }
  cx.putImageData(img,0,0);
  const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,cv);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  DUST_TEX=t;return t;
}
const _dR=()=>Math.random();
function spawnDust(n){
  if(!PLAYER.dust)PLAYER.dust=[];
  const s3=playerBaseScale()*PLAYER.size, P=PLAYER.pos;
  for(let i=0;i<n;i++){
    PLAYER.dust.push({
      x:P[0]+(70*_dR()-35)*s3,  z:P[2]+(70*_dR()-35)*s3,  y:P[1]+(8*_dR())*s3,   // TIGHT foot-level cluster (was ROM +-100 -> too wide)
      vy:(1.6*_dR()+0.3)*s3, ay:-0.06*(_dR()+0.5)*s3,   // gentle UP then a downward SETTLE (the ROM's upward accel flew it ~3x char-height into the air)
      size:(8*_dR()+6)*s3, grow:(2.2*_dR()+1.0)*s3,
      life:((_dR()*16)|0)+14, a:((_dR()*70)|0)+130      // 14-30 ticks (was 50-100 = lingered) , alpha 130-200
    });
  }
  if(PLAYER.dust.length>160)PLAYER.dust.splice(0,PLAYER.dust.length-160);
}
function updateDust(fr){
  const D=PLAYER.dust; if(!D||!D.length)return;
  for(let i=D.length-1;i>=0;i--){const p=D[i];
    p.vy+=fr*p.ay; p.y+=fr*p.vy;                                       // integrate (ay settles vy so it rises a little then eases, not forever)
    p.size+=fr*p.grow*0.5;                                             // steady expansion
    p.life-=fr;
    if(p.life<10)p.a=Math.max(0,p.a*(p.life/10));                      // quick fade over the last ~10 ticks
    if(p.life<=0||p.a<=0)D.splice(i,1);
  }
}
function drawDust(MVP,Vv){
  const D=PLAYER.dust; if(!D||!D.length)return;
  const rx=Vv[0],ry=Vv[4],rz=Vv[8], ux=Vv[1],uy=Vv[5],uz=Vv[9];       // camera right/up in world space (billboard)
  const N=D.length; if(!_dustBufs){_dustBufs={p:gl.createBuffer(),u:gl.createBuffer(),c:gl.createBuffer(),a:gl.createBuffer()};}
  const pos=new Float32Array(N*18),uv=new Float32Array(N*12),col=new Float32Array(N*18),va=new Float32Array(N*6);
  const TRI=[[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]], UVT=[[0,1],[1,1],[1,0],[0,1],[1,0],[0,0]];
  let pi=0,ui=0,ci=0,ai=0;
  for(const p of D){const s=p.size, al=Math.max(0,Math.min(1,p.a/255));
    for(let k=0;k<6;k++){const sx=TRI[k][0],sy=TRI[k][1];
      pos[pi++]=p.x+(rx*sx+ux*sy)*s; pos[pi++]=p.y+(ry*sx+uy*sy)*s; pos[pi++]=p.z+(rz*sx+uz*sy)*s;
      uv[ui++]=UVT[k][0]; uv[ui++]=UVT[k][1]; col[ci++]=1;col[ci++]=1;col[ci++]=1; va[ai++]=al;}
  }
  gl.useProgram(prog); gl.uniformMatrix4fv(uMVP,false,new Float32Array(MVP));
  gl.uniform1f(uMode,0.0); gl.uniform1f(uMod,1.0); if(uLitNrm)gl.uniform1f(uLitNrm,0.0);   // uMode0+uMod1+uLitNrm0 -> shade=1 (flat, no fake light)
  gl.uniform1f(uAlphaMode,1.0); gl.uniform3f(uTint,0.80,0.71,0.55);                        // alpha = tex.a * vA ; tan DIRT tint
  if(uScroll)gl.uniform2f(uScroll,0,0); if(uTexgen)gl.uniform1f(uTexgen,0.0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,dustTex()); gl.uniform1i(uTex,0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.disable(gl.POLYGON_OFFSET_FILL);
  const B=_dustBufs;
  gl.bindBuffer(gl.ARRAY_BUFFER,B.p);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);bindA(aPos,B.p,3);
  gl.bindBuffer(gl.ARRAY_BUFFER,B.u);gl.bufferData(gl.ARRAY_BUFFER,uv,gl.DYNAMIC_DRAW);bindA(aUV,B.u,2);
  gl.bindBuffer(gl.ARRAY_BUFFER,B.c);gl.bufferData(gl.ARRAY_BUFFER,col,gl.DYNAMIC_DRAW);bindA(aCol,B.c,3);
  gl.bindBuffer(gl.ARRAY_BUFFER,B.a);gl.bufferData(gl.ARRAY_BUFFER,va,gl.DYNAMIC_DRAW);bindA(aVA,B.a,1);
  if(aNrm>=0){gl.disableVertexAttribArray(aNrm);gl.vertexAttrib3f(aNrm,0,1,0);}            // normal unused (shade=1)
  gl.drawArrays(gl.TRIANGLES,0,N*6);
  gl.depthMask(true);
}
const PLAYER={on:false,model:null,pos:[0,0,0],yaw:0,size:1.0,clip:'idle',
  eye:{tgl:0,lid:0,timer:30,acc:0},   // ROM eye/blink state (tgl=lid toggle bit, lid=sclera frame 0/1/2)
  vel:[0,0],spd:0.09,faceOff:0,speed:0,angVel:0,spdAcc:0,sliding:false,reversing:false,animRate:1.0,idleClip:null,walkClip:null,turnClip:null,byAid:null,
  skid:0,skidVel:0,skidTmr:0,   // SKID state: skid = phase (0 none / 1 braking / 2 quick-turn), skidVel = turn spring vel, skidTmr = safety. Brake-to-stop then quick turn (per the real game). NO dedicated skid CLIP exists (RE-proven) — plays the locomotion clip.
  fidgetsOn:true,fidget:{seq:-1,pos:0,timer:150,phase:0,recent:[]},   // ROM aiIdx-brain idle-fidget state (seq=-1 idle)
  lean:{pitch:0,roll:0,prevYaw:0,yVel:0,coef:1.3},   // ROM whole-body reactive lean: unkB8 pitch(X)/unkC4 roll(Z) @ func_150A9B0C. coef=13/unk1E5 (anim-dependent divisor; user-tunable ; ')
  yVel:0,onGround:false,footOff:0,jHeld:false,airTime:0,apexY:null,fallDist:0,   // vertical physics (ROM units); footOff = model-origin->feet (model units)
  jumped:false,zJump:false,takeoff:0,postHeli:false,launchYVel:0,   // jump state: jumped=first-jump active (heli gate); zJump=Z high-jump; takeoff=latched anim (ROM unk31: 1 hop / 2 somersault); launchYVel=takeoff impulse (drives the somersault phase)
  tail:tailInit(), _tailFootY:-40.9, _tailSpeed:0, _airborne:0, _fr:1, landClip:null, landTimer:0,   // ROM tail dangly-chain solver state (func_1503B9BC). Write-back OVERWRITES bones 24-27. rootRef=feet -> near-vertical rest arch. Toggle 'T'.
  hover:{active:false,used:false,timer:0},                 // tail-spin helicopter — HELD + TIMED (ROM func_1505F298 L15060100: unk31 timer 3->62)
  anim:{cur:null,curT:0,prev:null,prevT:0,blend:0,blendDur:1}};
// ROM vertical constants — SOURCED (func_1505F298 jump / func_1505A770 integrator, game_83300):
//   gravity 4.0 (ground-jump default), y_velocity impulse 59.0 (normal jump; 40 short / 80 high by unk4E),
//   integrator advances pos by ~0.5·y_vel per frame (10× 0.05 substeps), terminal clamp -500.
//   HELICOPTER (block L15060100): 2nd jump press in air -> y_vel=0, gravity=1.0, xz_velocity*=0.3, tail-spin anim 233,
//   lasts one tail-spin cycle (no fuel, not held). JUMP_SCALE = viewer feel knob over the eyeballed size/move bridge.
const PHYS={GRAV:4.0, JUMP:59.0, ZJUMP:82.6, ZGRAV:3.8, HOVER_GRAV:1.0, HOVER_XZ:0.3, VINT:0.5, TERMINAL:500.0, SLOPE:0.5, JUMP_SCALE:1.0,
  HELI_CAP:62, HELI_CANCEL:19, HELI_LIFT:13, HELI_LIFTV:8.0, HELI_CLAMP:-8.0, HELI_EXPGRAV:4.5,   // tail-spin heli timer(unk31)/velocity (ROM func_1505F298 L15060100)
  HELI_SPIN:5.0, SOMER_RATE:0.8, FLAIL_FALL:450,   // somersault FIXED 0.8x (D_80099650, animId55); flail-fall gate = fall-distance > 450 ROM units (func_1505B5F8 0x43E10000) — Z-jump ~470 flails, normal jump ~232 doesn't
  // ROM momentum springs (func_15049688 heading / func_150495B0 speed): value += vel·dt ; vel += ((target-value)·GAIN - vel)·RATE·dt ; overshoot -> snap to target + zero vel.
  // ASYMMETRIC by regime (the ROM's raw gain/rate don't survive the frame-unit mismatch, so the form+ratios are kept and
  // the time-scale calibrated to the game's feel). ACCEL is gentle = EASE-IN + a tap gives a minimal nudge (not 5× coast);
  // normal DECEL is crisp; a high-speed decel latches to a soft SLIDE glide. Times @30fps below.
  H_GAIN:4.0, H_RATE:10.0,               // HEADING: tap ≈ minimal nudge; sustained 90° ~0.6s / 180° ~0.67s (overshoot-clamp only within 10°)
  SPD_GAIN_UP:1.5, SPD_RATE_UP:8.0,      // ACCEL = gentle EASE-IN (~1.3s to top speed); with the release-reset a 1-frame tap barely moves (~1/4 of before)
  SPD_GAIN_DN:8.0, SPD_RATE_DN:12.0,     // normal DECEL = crisp stop (~0.25s)
  SPD_GAIN_SLIDE:4.0, SPD_RATE_SLIDE:7.0,// SLIDE decel (latched from high speed, no-input release) = a ~0.5s glide-to-stop
  SLIDE_FRAC:0.81, REV_ANGLE:2.09,       // REV_ANGLE=120° = hard-reversal input. SLIDE_FRAC 0.81 (300/370) kept for the no-input release-slide latch.
  // ===== SKID (observed behaviour, per the user driving the real game — this is the AUTHORITATIVE source): a hard reversal at
  // run speed is NOT a curved run-around and NOT a momentum-keeping pivot. It is BRAKE STRAIGHT to a stop (facing HELD so the
  // path is a straight slide, not an arc) -> a QUICK direction change -> run off the other way. Two phases via PLAYER.skid:
  // 1 = braking (facing locked, speed target 0, soft SLIDE decel = visible skid), 2 = quick snap-turn to the new dir, then resume.
  // (This REPLACES the earlier asm-derived "pivot at 300" model from func_15123A54, which produced exactly the wrong circular
  // run-around the user reported — the on-screen game behaviour overrides that asm interpretation.) func_15124C38 = HEIGHT spring.
  SKID_MIN:165, SKID_STOP:34, SKID_TURN_GAIN:8.0, SKID_TURN_RATE:18.0, SKID_TIMEOUT:120};  // enter >165(=MAX*0.45); phase1->2 at speed<34(~stop); phase-2 snap-turn = fast (quicker than the 4/10 normal turn); 120-frame safety
// TAIL is 100% keyframe-driven (idle curl + fidget whips + turn clip) inherited through the whole-body ROOT LEAN — the ROM
// has NO per-bone tail spring (full pose-pipeline trace game_D5650, 5x confirmed). No procedural tail layer.
// Z-JUMP (SOURCED func_1505F298 .L1505FC2C + rodata 23DC00): hold Z (ready stance, horizontal frozen) then jump ->
//   y_velocity *= D_80099664(1.40) => ~82.6, gravity = D_80099668(3.80), anim 235 @ D_80099660(1.08x). Peak ~2.06x normal.
//  JUMP 59 = normal jump (press, unk4E=0). HIGH jump = hold Z then jump (see Z-JUMP above), NOT a hold-of-jump.   // animRate 1.18 = user-tuned; native walk cycle=1.0s@30fps   // anim = mixer state (cur/prev clip + phases + crossfade weight); vel=ROM units/frame; spd=speed-feel mult (0.13)
const CHAR_FIT=0.51;   // empirical character world-fit (Conker eyeballed against level geometry); reused for NPC sizing
function playerBaseScale(){return ((typeof mesh!=='undefined'&&mesh&&mesh._s)?mesh._s:1)*CHAR_FIT;}
function ensurePlayer(){
  if(PLAYER.model)return PLAYER.model;
  const P=DATA.posable||[]; const m=P.find(x=>x.id===0)||P.find(x=>x.id>=0&&x.id<=4);  // model 0 = high-detail Conker (811 tri; shares 28-bone pack 0 with 1-4)
  if(!m)return null; preparePosable(m); PLAYER.model=m;
  // Conker's REAL locomotion clips (pair index = the clip's stored `aid`). USER-VERIFIED against the live
  // game (they know Conker's moves), which corrected an earlier wrong note that had walk=animId3->pair8:
  //   idle = aid 7  (Clip 116) — low-motion stand, verified
  //   walk = aid 1  (Clip 729) — legs scissor / forward-lean gait; the REAL step cycle (USER-IDENTIFIED)
  //   turn = aid 6  (whole-body yaw sweep)
  //   NOTE: aid 8 (animId 3, the "arm-swing gesture") was the wrong "shrug" walk; run (aid 69) still unverified.
  try{ if(m._pose&&m._pose.clips&&m._pose.clips.length){ const byAid={}; m._pose.clips.forEach((c,i)=>{if(c.aid!=null&&byAid[c.aid]===undefined)byAid[c.aid]=i;});
      PLAYER.byAid=byAid;                                            // pair-index -> storage index (for fidget lookup)
      if(byAid[7]!==undefined)PLAYER.idleClip=byAid[7];
      if(byAid[1]!==undefined)PLAYER.walkClip=byAid[1];
      if(byAid[6]!==undefined)PLAYER.turnClip=byAid[6];
      // AIRBORNE clips (ROM jump animIds -> pairs, verified via anim_table a2p):
      if(byAid[11]!==undefined)PLAYER.jumpRunClip=byAid[11];    // run take-off  (ROM animId 55, xz>=9)
      if(byAid[23]!==undefined)PLAYER.jumpStandClip=byAid[23];  // standing jump / spring (ROM animId 50, xz<9)
      if(byAid[4]!==undefined)PLAYER.fallClip=byAid[4];         // fall (ROM animId 56)
      if(byAid[12]!==undefined)PLAYER.highFallClip=byAid[12];   // high fall (ROM animId 59)
      if(byAid[20]!==undefined)PLAYER.hoverClip=byAid[20];      // TAIL-SPIN helicopter (ROM animId 233 = the iconic heli)
      if(byAid[66]!==undefined)PLAYER.landClip=byAid[66];       // touchdown LANDING (ROM animId 66/0x42, func_1504CB98:4474 — plays for free-play on ground contact; verified NOT scripted-only)
      if(byAid[21]!==undefined)PLAYER.zJumpClip=byAid[21];      // Z-held crouch->rise HIGH jump (ROM animId 235, the Z-jump)
      // (pivot clip animId 0x76 -> pack pair 187 is an ARM GESTURE in this extraction, not a pivot; the ROM's direction-change
      //  reaction is the SLIDE-STOP physics, not a body clip — so no pivot clip is wired.)
    } }catch(e){}   // NO run: Conker has ONE ground speed (per user); scene FX aside
  // Character vertical extents from the BIND pose (model units): footOff = model origin -> lowest vertex (feet);
  // charH = total height. Used to place feet on the ground and size the collision capsule.
  try{ const Pp=m._pose, bind=poseWorld(Pp.bones,Pp.slot2idx,{}); let mny=1e9,mxy=-1e9;
    for(const g of Pp.groups){const lp=g.pos,sl=g.slot,np=g.np;
      for(let i=0;i<np;i++){const M=bind[sl[i]]||IDENT,y=lp[i*3]*M[1]+lp[i*3+1]*M[5]+lp[i*3+2]*M[9]+M[13]; if(y<mny)mny=y; if(y>mxy)mxy=y;}}
    PLAYER.footOff=(mny<1e8)?-mny:0; PLAYER.charH=(mxy>mny+1)?(mxy-mny):55;
    PLAYER._tailFootY=(mny<1e8)?mny:-40.9; PLAYER.tail=tailInit();   // native feet/ground Y = tail chain rootRef (arches the rest tail up)
    PLAYER._bindFootY=Math.min(bind[19]?bind[19][13]:0, bind[23]?bind[23][13]:0);   // bind foot-bone Y (model units) for render-time foot planting
    { const fA=bind[19]||IDENT, fB=bind[23]||IDENT; PLAYER._bindFootXZ=[(fA[12]+fB[12])/2,(fA[14]+fB[14])/2]; }   // bind feet-midpoint XZ for idle de-sway
  }catch(e){ PLAYER.footOff=0; PLAYER.charH=55; PLAYER._bindFootY=null; PLAYER._bindFootXZ=null; }
  PLAYER.clip=(PLAYER.idleClip!=null)?PLAYER.idleClip:'idle';
  PLAYER.fidget={seq:-1,pos:0,timer:fidgetDelay(0),phase:0,recent:[]};
  PLAYER.anim={cur:(PLAYER.idleClip!=null?PLAYER.idleClip:null),curT:0,prev:null,prevT:0,blend:0,blendDur:1};   // start in idle
  return m;
}
// ROM actor root-matrix builder func_150A9B0C(ax=pitch/unkB8, ay=yaw/unk40, az=roll/unkC4) in RADIANS, ×scale.
// JS port validated BYTE-EXACT vs asm game_D5650/func_150A9B0C.s (func_150AD780=cos, func_150AD78C=sin per
// game_DAC30.c). Column-major GL: M column k = R row k, so yaw-only reduces to the old translate·rotY·scale exactly.
function romRootRot(M,ax,ay,az,s){
  const cx=Math.cos(ax),sx=Math.sin(ax),cy=Math.cos(ay),sy=Math.sin(ay),cz=Math.cos(az),sz=Math.sin(az);
  M[0]=s*(cz*cy);            M[1]=s*(sz);        M[2]=s*(-cz*sy);
  M[4]=s*(-cx*sz*cy+sx*sy);  M[5]=s*(cx*cz);     M[6]=s*(cx*sz*sy+sx*cy);
  M[8]=s*(sx*sz*cy+cx*sy);   M[9]=s*(-sx*cz);    M[10]=s*(-sx*sz*sy+cx*cy);
}
function playerWorldMat(){   // translate(pos) · ROM root lean(pitch unkB8, yaw, roll unkC4) · scale  (native coords -> level world)
  const s=playerBaseScale()*PLAYER.size,p=PLAYER.pos,L=PLAYER.lean,D2R=0.017453292,M=new Float32Array(16);
  romRootRot(M,(L?L.pitch:0)*D2R,PLAYER.yaw,(L?L.roll:0)*D2R,s);
  M[3]=0;M[7]=0;M[11]=0; M[12]=p[0];M[13]=p[1];M[14]=p[2]; M[15]=1; return M;
}
function drawPlayerInLevel(MVP,Vv){
  const m=ensurePlayer(); if(!m||!m._pose)return;
  const A=PLAYER.anim; let angles;
  if(A.cur==null){ angles=(PLAYER.idleClip!=null)?clipAngles(m,PLAYER.idleClip,poseT):{}; }
  else if(A.prev!=null && A.blend>0){                       // MID-CROSSFADE: blend prev->cur by weight
    angles=blendAngles(clipAngles(m,A.prev,A.prevT), clipAngles(m,A.cur,A.curT), 1-A.blend/A.blendDur);
  } else { angles=clipAngles(m,A.cur,A.curT); }
  // ===== TAIL DANGLY-CHAIN WRITE-BACK (ROM func_1503B9BC solver + func_1503CB98) =====
  // Pre-pose (clip only) to read the tail-base (bone24) + root (bone0) world positions the solver needs, run the
  // length-constrained point chain, then OVERWRITE angles[24..27] with the absolute look-at orientations — exactly as
  // the ROM overwrites the palette tail bones. rootRef = feet/ground (PLAYER._tailFootY) so the rest chain arches
  // near-vertical; idle = lateral RNG damped-flick twitch; moving = speed-scaled vertical sway. (feet 19/23 are
  // unaffected by the tail, so the pre-pose is reused for the foot-plant below.)
  const preW=poseWorld(m._pose.bones,m._pose.slot2idx,angles); PLAYER._poseW=preW;
  // ROM: during the tail-spin HOVER the physics-disable flag (record[0x2FB]&3) forces func_1503B95C -> COPY mode
  // (func_1503B9BC @1503BB90): bones 24-27 come straight from the clip (animId 0xE9=233 = the rotor spin), NOT the
  // dangly solver. So skip the write-back during hover and let hoverClip drive the tail (else it freezes pointing up).
  const _tailByClip = (PLAYER.hover && PLAYER.hover.active);
  if(TAIL.enabled && PLAYER.tail && !_tailByClip){
    const w0=preW[0]||IDENT, w24=preW[24]||IDENT;
    const tang=tailSolve(PLAYER.tail,{ world0:w0, p24:[w24[12],w24[13],w24[14]],
      footY:(PLAYER._tailFootY!=null?PLAYER._tailFootY:-40.9),
      speed:PLAYER._tailSpeed||0, airborne:PLAYER._airborne||0,
      animId:15, fr:PLAYER._fr||1, facingRad:0 });                    // model space -> facing=0 keeps the flick lateral; wm applies world heading
    angles[24]=tang[24]; angles[25]=tang[25]; angles[26]=tang[26]; angles[27]=tang[27];
  }
  // prop object socketed onto the hand during a prop-mime fidget (ROM op-0x69 attach for this sequence)
  let attach=null; const F=PLAYER.fidget;
  if(F&&F.seq>=0){ const fa=FIDGET_ATTACH[F.seq]; if(fa && F.pos>=(fa.i||0)){ const pp=getPropPart(fa.o,fa.b); if(pp)attach=[pp]; } }
  let wm=playerWorldMat();
  // FOOT-PLANT: keep the LOWEST posed foot on the floor so Conker pushes off the ground and the BODY bobs, instead of
  // positioning from the body centre and letting the feet float/sink through the floor. Shift the model DOWN by how far
  // the posed feet rose above the bind pose (the physics already anchors the bind sole to the ground via footOff).
  if(PLAYER.onGround && PLAYER._bindFootY!=null && m._pose){
    const W=PLAYER._poseW||poseWorld(m._pose.bones,m._pose.slot2idx,angles);
    const y19=W[19]?W[19][13]:PLAYER._bindFootY, y23=W[23]?W[23][13]:PLAYER._bindFootY;
    // VERTICAL PLANT: pin the LOWEST posed foot to the bind level (body bobs off the floor). Transform the model-space
    // drift into world via the worldMat rotation (wm[5] ≈ scale for no lean).
    let dY=Math.min(y19,y23)-PLAYER._bindFootY; dY=Math.max(-3,Math.min(30,dY));
    wm[13]-=dY*wm[5];
    // IDLE DE-SWAY: pin the feet-MIDPOINT in XZ so the BODY sways over PLANTED feet (was: feet skating side-to-side while
    // the body stayed put). Fades out as he starts moving (a walk needs the feet to travel).
    if(PLAYER._bindFootXZ){
      const fade=Math.max(0,Math.min(1,1-PLAYER.speed/40));
      if(fade>0){
        const cx=((W[19]?W[19][12]:0)+(W[23]?W[23][12]:0))/2, cz=((W[19]?W[19][14]:0)+(W[23]?W[23][14]:0))/2;
        const dx=(cx-PLAYER._bindFootXZ[0])*fade, dz=(cz-PLAYER._bindFootXZ[1])*fade;   // model-space XZ drift
        wm[12]-=dx*wm[0]+dz*wm[8]; wm[14]-=dx*wm[2]+dz*wm[10];                            // rotate into world (wm rotation incl. scale)
      }
    }
  }
  try{ drawPosable(m,{mvp:MVP,worldMat:wm,view:Vv,angles,attach}); }catch(e){ console.error('player draw',e); }
  try{ drawDust(MVP,Vv); }catch(e){ console.error('dust',e); }   // DIRT/SKID dust billboards (world-space, camera MVP)
  gl.uniformMatrix4fv(uMVP,false,new Float32Array(MVP));   // restore level MVP for the wire pass
}
// on-screen readout of the player's current scale/position (so you can dial in the right size)
function updatePlayerHUD(){
  let h=document.getElementById('playHUD');
  if(!PLAYER.on){ if(h)h.style.display='none'; return; }
  if(!h){ h=document.createElement('div'); h.id='playHUD';
    h.style.cssText='position:fixed;left:14px;bottom:14px;z-index:60;padding:8px 12px;border-radius:8px;font:12px/1.5 ui-monospace,monospace;background:rgba(10,12,16,.66);color:#e8e8e8;pointer-events:none;white-space:pre';
    document.body.appendChild(h); }
  h.style.display='block';
  const st=!PLAYER.onGround?(PLAYER.hover.active?'TAIL-SPIN HOVER':(PLAYER.zJump?'HIGH-JUMP':(PLAYER.yVel>0?'JUMP':'FALL'))):(PLAYER._crouch?'CROUCH (Z)':(PLAYER.fidget&&PLAYER.fidget.seq>=0)?('FIDGET '+PLAYER.fidget.seq):PLAYER.skid===1?'SKID (brake)':PLAYER.skid===2?'SKID-TURN':PLAYER.clip===PLAYER.walkClip?(PLAYER.sliding?'SLIDE':'WALK'):'IDLE');
  const tdbg='\nTAIL '+(TAIL.enabled?'ROM dangly-chain ON':'OFF (clip pose)')+'   [T = toggle]';
  h.textContent='CONKER   '+st+'   size '+PLAYER.size.toFixed(2)+'×   move '+PLAYER.spd.toFixed(2)+'×   jump '+PHYS.JUMP_SCALE.toFixed(2)+'×   lean '+(PLAYER.lean?PLAYER.lean.coef.toFixed(2):'0')+'×   collide '+(STATE.collide?'on':'OFF')+(STATE.collide?(' walls '+(STATE.walls?'on':'off')):'')+tdbg
    +'\nWASD move · SPACE=jump · hold Z then SPACE=HIGH jump · (in air) hold SPACE=tail-spin hover · [ ] size · , . speed · K L jump-height · ; \' lean · C collision · V walls · F face · P exit\nbuild '+BUILD;
}
function wrapPi(a){a=(a+Math.PI)%(2*Math.PI); if(a<0)a+=2*Math.PI; return a-Math.PI;}
// ===== LEVEL COLLISION ===== build a spatial grid over the level's TERRAIN triangles (view-space, the same
// space as PLAYER.pos) and raycast straight down for ground height. Colliding against the render mesh (the ROM's
// separate collision mesh isn't in the viewer); triggers/sky excluded. Floors = triangles more horizontal than
// vertical (|ny| dominant); walls = near-vertical (handled by horizontal push-out/slide).
let _collision=null, _collisionMesh=null;
function buildCollision(m){
  const tris=[]; if(!m||!m._g) return null;
  for(const g of m._g){
    if(g.trig||g.sky) continue;                      // skip invisible trigger volumes + skybox
    const pos=g.pos, idx=g.idx; if(!pos||!idx) continue;
    for(let t=0;t+2<idx.length;t+=3){
      const a=idx[t],b=idx[t+1],c=idx[t+2];
      const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2], bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2], cx=pos[c*3],cy=pos[c*3+1],cz=pos[c*3+2];
      let nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay), ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az), nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
      const nl=Math.hypot(nx,ny,nz); if(nl<1e-12) continue; nx/=nl;ny/=nl;nz/=nl;
      tris.push({ax,ay,az,bx,by,bz,cx,cy,cz,nx,ny,nz,
        floor:(Math.abs(ny)>=0.5),   // ROM walkable-slope limit: |normal.Y| >= 0.5 = cos(60deg) (func_150AB1F0.s:652)
        minx:Math.min(ax,bx,cx),maxx:Math.max(ax,bx,cx),minz:Math.min(az,bz,cz),maxz:Math.max(az,bz,cz)});
    }
  }
  if(!tris.length) return null;
  let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9,mnY=1e9;
  for(const tr of tris){if(tr.minx<mnx)mnx=tr.minx;if(tr.maxx>mxx)mxx=tr.maxx;if(tr.minz<mnz)mnz=tr.minz;if(tr.maxz>mxz)mxz=tr.maxz;
    const ty=Math.min(tr.ay,tr.by,tr.cy); if(ty<mnY)mnY=ty;}
  const N=80, cw=(mxx-mnx)/N||1, ch=(mxz-mnz)/N||1, grid=Array.from({length:N*N},()=>[]);
  const gi=(x,z)=>{let i=Math.floor((x-mnx)/cw),j=Math.floor((z-mnz)/ch);i=i<0?0:i>N-1?N-1:i;j=j<0?0:j>N-1?N-1:j;return j*N+i;};
  for(let k=0;k<tris.length;k++){const tr=tris[k];
    const i0=Math.max(0,Math.floor((tr.minx-mnx)/cw)),i1=Math.min(N-1,Math.floor((tr.maxx-mnx)/cw));
    const j0=Math.max(0,Math.floor((tr.minz-mnz)/ch)),j1=Math.min(N-1,Math.floor((tr.maxz-mnz)/ch));
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)grid[j*N+i].push(k);}
  return {tris,grid,N,mnx,mnz,cw,ch,gi,mnY};
}
function ensureCollision(){ if(typeof mesh==='undefined'||!mesh) return; if(_collisionMesh!==mesh){ try{_collision=buildCollision(mesh);}catch(e){console.error('collision build',e);_collision=null;} _collisionMesh=mesh; } }
function triYatXZ(tr,x,z){                             // barycentric interpolation of the triangle's Y at (x,z), or null if outside
  const x1=tr.ax,z1=tr.az,x2=tr.bx,z2=tr.bz,x3=tr.cx,z3=tr.cz;
  const det=(z2-z3)*(x1-x3)+(x3-x2)*(z1-z3); if(Math.abs(det)<1e-12) return null;
  const l1=((z2-z3)*(x-x3)+(x3-x2)*(z-z3))/det, l2=((z3-z1)*(x-x3)+(x1-x3)*(z-z3))/det, l3=1-l1-l2, e=-0.02;
  if(l1<e||l2<e||l3<e) return null;
  return l1*tr.ay+l2*tr.by+l3*tr.cy;
}
// highest walkable floor at (x,z) whose surface is at or below yCeil; returns {y,nx,ny,nz} or null
function groundAt(x,z,yCeil){
  const C=_collision; if(!C) return null;
  const cell=C.grid[C.gi(x,z)]; if(!cell||!cell.length) return null;
  let best=null;
  for(const k of cell){const tr=C.tris[k]; if(!tr.floor) continue;
    const y=triYatXZ(tr,x,z); if(y==null) continue;
    if(y<=yCeil && (best==null||y>best.y)) best={y,nx:tr.nx,ny:tr.ny,nz:tr.nz};}
  return best;
}
// horizontal wall push-out: if (x,z) is within `rad` of a near-vertical triangle edge-plane within the feet..head band, push out
function wallPush(x,z,footY,headY,rad){
  const C=_collision; if(!C) return [x,z];
  const cell=C.grid[C.gi(x,z)]; if(!cell||!cell.length) return [x,z];
  let px=x,pz=z;
  for(const k of cell){const tr=C.tris[k]; if(tr.floor) continue;                 // walls only
    if(Math.abs(tr.ny)>0.5) continue;                                             // steep-ish only
    // vertical span overlap test (skip walls entirely above head or below feet)
    const wl=Math.min(tr.ay,tr.by,tr.cy), wh=Math.max(tr.ay,tr.by,tr.cy);
    if(wh<footY||wl>headY) continue;
    // signed distance from point to the wall plane (using XZ normal)
    const nlen=Math.hypot(tr.nx,tr.nz)||1, wnx=tr.nx/nlen, wnz=tr.nz/nlen;
    const d=(px-tr.ax)*wnx+(pz-tr.az)*wnz;
    if(d>=0&&d<rad){                                                              // inside the wall's near side within radius
      // only push if the point projects near the triangle footprint (cheap bbox pad)
      if(px<tr.minx-rad||px>tr.maxx+rad||pz<tr.minz-rad||pz>tr.maxz+rad) continue;
      const push=rad-d; px+=wnx*push; pz+=wnz*push;
    }
  }
  return [px,pz];
}
// place Conker's feet on the terrain at spawn (search a generous band around the spawn point)
function snapPlayerToGround(){
  ensureCollision(); if(!_collision) return;
  const s3=playerBaseScale()*PLAYER.size, footOffV=(PLAYER.footOff||0)*s3, charH=(PLAYER.charH||55)*s3;
  const gr=groundAt(PLAYER.pos[0],PLAYER.pos[2], PLAYER.pos[1]-footOffV+charH*4);
  if(gr!=null){ PLAYER.pos[1]=gr.y+footOffV; PLAYER.yVel=0; PLAYER.onGround=true; }
}
// v3 CONTROLLER: WASD drives Conker (ROM ground constants), camera-relative heading, damped turn, momentum;
// vertical = gravity + jump + tail-spin hover, all resolved against real level-terrain collision (ground raycast + wall slide).
function updatePlayer(dt){
  if(!PLAYER.on||typeof mesh==='undefined'||!mesh||!mesh._s)return;
  const fr=Math.min(3,Math.max(0,dt*30));                          // 30fps-frame units
  updateEyes(fr);                                                  // ROM auto-blink (func_1507E2B0) — random 10..149-tick idle blink cadence
  const cb=camBasis(), f=cb.f, s=cb.s;
  let fx=f[0],fz=f[2],fl=Math.hypot(fx,fz)||1; fx/=fl; fz/=fl;      // horizontal camera forward
  let rx=s[0],rz=s[2],rl=Math.hypot(rx,rz)||1; rx/=rl; rz/=rl;      // horizontal camera right
  const ci=(keys['w']?1:0)-(keys['s']?1:0), si=(keys['d']?1:0)-(keys['a']?1:0);
  let mx=fx*ci+rx*si, mz=fz*ci+rz*si; const mag=Math.hypot(mx,mz);
  const MAX=370;                                                   // ROM RUN-tier speed (gait D_800A34B0 run=370). Full input = run, not walk-capped (this + the linear cadence below is the real "runs slow" fix). SLIDE_THRESH=370*0.81=300 = sourced slide-lock (func_15124C38 0x43960000).
  // ===== ROM MOVEMENT MODEL (master integrator func_15123A54, RE'd from asm). Instantaneous world velocity IS locked
  // to facing (vel = speed·(sin,cos)(heading)) — but BOTH heading AND speed carry their own 2nd-order momentum
  // accumulators (func_15049688 / func_150495B0), so neither flips instantly. On a hard reversal the heading eases
  // toward the opposite dir WITH OVERSHOOT while velocity stays locked to it -> Conker keeps going the old way and
  // SWEEPS/curves into the new = the slight SLIDE; the speed spring (+ the WASD neutral frame) dips speed at the
  // pivot. Heading: rate 3 / gain 6, |d|>=10deg gated (anti-jitter), snap+zero on overshoot. Speed: rate 8 / gain 10. =====
  const dts=fr/30;
  const hasIn=mag>0.01, zStance=PLAYER.onGround&&!!keys['z'];      // holding Z on the ground = frozen ready stance
  const SLIDE_THRESH=MAX*PHYS.SLIDE_FRAC;                          // facing locks above this (ROM speed 300 of run-370 = 0.81)
  // (a) HEADING + SKID. Normal turns = damped spring. A HARD REVERSAL at run speed is the Conker SKID (behaviour taken from
  //     the user driving the real game): BRAKE straight to a stop (facing HELD -> a STRAIGHT slide, NOT a circular arc), then
  //     a QUICK snap-turn to the new direction, then run off. Two phases: PLAYER.skid 1 = braking, 2 = quick-turn.
  let dAbs=0, desired=PLAYER.yaw;
  if(hasIn && !zStance){ desired=Math.atan2(mx/mag,mz/mag)+PLAYER.faceOff; dAbs=Math.abs(wrapPi(desired-PLAYER.yaw)); }
  // SKID ENTRY: hard-reversal input (>120° off facing) while genuinely running.
  if(PLAYER.onGround && hasIn && !zStance && dAbs>PHYS.REV_ANGLE && PLAYER.speed>PHYS.SKID_MIN && PLAYER.skid===0){
    PLAYER.skid=1; PLAYER.skidVel=0; PLAYER.skidTmr=PHYS.SKID_TIMEOUT; }          // enter phase 1 = slide/brake (facing locked)
  const skidding=PLAYER.onGround && PLAYER.skid>0;
  PLAYER.reversing=skidding;                                        // dust + HUD alias
  if(PLAYER.skid===1){                                              // PHASE 1 — BRAKE: facing HELD, slide STRAIGHT to a stop (no arc)
    PLAYER.skidTmr-=fr; PLAYER.angVel*=Math.max(0,1-PHYS.H_RATE*dts);             // no turn -> he brakes along the OLD heading
    if(PLAYER.speed<PHYS.SKID_STOP || !hasIn || PLAYER.skidTmr<=0) PLAYER.skid=2; // slid to ~stop -> quick turn (or bailed)
  } else if(PLAYER.skid===2){                                       // PHASE 2 — QUICK TURN: snap facing to the new dir (speed ~0, so no arc)
    PLAYER.skidTmr-=fr; let d=wrapPi(desired-PLAYER.yaw);
    PLAYER.skidVel += (d*PHYS.SKID_TURN_GAIN - PLAYER.skidVel)*Math.min(1,PHYS.SKID_TURN_RATE*dts);   // fast snap-turn
    let ny=PLAYER.yaw + PLAYER.skidVel*dts;
    if(Math.abs(d)<0.6 && wrapPi(desired-ny)*d<0){ ny=desired; PLAYER.skidVel=0; }               // snap on overshoot
    PLAYER.yaw=wrapPi(ny); PLAYER.angVel=0;
    if(!hasIn || Math.abs(wrapPi(desired-PLAYER.yaw))<0.12 || PLAYER.skidTmr<=0){ PLAYER.skid=0; PLAYER.skidVel=0; PLAYER.reversing=false; }   // aligned/released -> resume run
  } else if(hasIn && !zStance){ let d=wrapPi(desired-PLAYER.yaw);   // NORMAL turn spring (ROM func_15049688)
    PLAYER.angVel += (d*PHYS.H_GAIN - PLAYER.angVel)*Math.min(1,PHYS.H_RATE*dts);
    let ny=PLAYER.yaw + PLAYER.angVel*dts;
    if(Math.abs(d)<0.17453 && wrapPi(desired-ny)*d<0){ ny=desired; PLAYER.angVel=0; }   // within 10deg: snap on overshoot
    PLAYER.yaw=wrapPi(ny);
  } else { PLAYER.angVel*=Math.max(0,1-PHYS.H_RATE*dts); }         // no input / Z stance: bleed turn rate
  // (b) SPEED spring: vel += ((target-speed)·GAIN - vel)·RATE·dt ; speed += vel·dt ; overshoot->snap.
  //     ACCEL = gentle ease-in; normal DECEL crisp; a no-input high-speed release latches a soft SLIDE glide; a SKID brakes to 0.
  let ts;
  if(zStance) ts=0;
  else if(skidding) ts=0;                                          // SKID: brake to a stop (phase 1) + stay stopped through the quick turn (phase 2); normal accel resumes after
  else if(PLAYER.onGround) ts=hasIn?MAX:0;
  else ts=(PLAYER.hover&&PLAYER.hover.active)?Math.min(PLAYER.speed,MAX*PHYS.HOVER_XZ):PLAYER.speed;  // airborne: keep momentum
  { const decel=ts<PLAYER.speed;
    // SLIDE LATCH: a decel that STARTS above the threshold glides ALL the way to a stop (soft); a stop from below the
    // threshold is crisp. The SKID brake (phase 1) uses the same soft glide = the visible slide-to-stop.
    if(!decel || !PLAYER.onGround) PLAYER.sliding=false;
    else if(PLAYER.skid===1) PLAYER.sliding=true;                  // skid BRAKE = soft slide-to-stop (the visible skid)
    else if(PLAYER.skid===2) PLAYER.sliding=false;                 // quick-turn: already ~stopped
    else if(PLAYER.speed>SLIDE_THRESH) PLAYER.sliding=true;
    if(PLAYER.speed<8) PLAYER.sliding=false;
    const soft=PLAYER.sliding;
    // TAP RESET: on a low-speed release (a tap), kill the leftover positive accel momentum so Conker doesn't COAST on
    // after the key is up. (High-speed releases keep their momentum -> the slide; that's the `soft` branch.)
    if(decel && !soft && PLAYER.speed<MAX*0.6 && PLAYER.spdAcc>0) PLAYER.spdAcc=0;
    let sg,sr;
    if(!decel){ sg=PHYS.SPD_GAIN_UP; sr=PHYS.SPD_RATE_UP; }            // ACCEL = gentle ease-in (a tap barely moves)
    else if(soft){ sg=PHYS.SPD_GAIN_SLIDE; sr=PHYS.SPD_RATE_SLIDE; }   // high-speed SLIDE = soft glide-to-stop
    else { sg=PHYS.SPD_GAIN_DN; sr=PHYS.SPD_RATE_DN; }                 // normal stop = crisp
    const e=ts-PLAYER.speed; PLAYER.spdAcc += (e*sg - PLAYER.spdAcc)*Math.min(1,sr*dts);
    let ns=PLAYER.speed + PLAYER.spdAcc*dts;
    if((ts-ns)*e<0){ PLAYER.speed=ts; PLAYER.spdAcc=0; } else PLAYER.speed=Math.max(0,ns); }   // overshoot -> snap + kill accum
  const fdir=PLAYER.yaw-PLAYER.faceOff;                            // velocity LOCKED to facing (ROM: vel = speed·(sin,cos)(heading))
  PLAYER.vel[0]=Math.sin(fdir)*PLAYER.speed; PLAYER.vel[1]=Math.cos(fdir)*PLAYER.speed;
  const ws=mesh._s*PLAYER.spd;                                     // ROM world units -> level view space (+ feel mult)
  // ===== HORIZONTAL move + WALL slide, then VERTICAL gravity/jump/hover against ground raycast =====
  ensureCollision();
  const s3=playerBaseScale()*PLAYER.size, footOffV=(PLAYER.footOff||0)*s3, charH=Math.max(1e-4,(PLAYER.charH||55)*s3);
  let nX=PLAYER.pos[0]+PLAYER.vel[0]*ws*fr, nZ=PLAYER.pos[2]+PLAYER.vel[1]*ws*fr;
  if(STATE.collide!==false && STATE.walls!==false && _collision){
    const footY=PLAYER.pos[1]-footOffV, headY=footY+charH, rad=charH*0.22;
    const pp=wallPush(nX,nZ,footY+charH*0.12,headY,rad); nX=pp[0]; nZ=pp[1];
  }
  PLAYER.pos[0]=nX; PLAYER.pos[2]=nZ;
  if(STATE.collide!==false && _collision){
    let feet=PLAYER.pos[1]-footOffV;
    const jp=!!keys[' '], jEdge=jp&&!PLAYER.jHeld, zHeld=!!keys['z'];   // SPACE = jump (Z+jump = high jump; 2nd press in air held = tail-spin hover)
    // ---- GROUND JUMP (ROM func_1505F298): fires immediately on press. Plain = impulse 59, grav 4.0. Z held = the
    // crouch->rise HIGH jump (animId 235, lower gravity -> ~2x height). Takeoff anim LATCHED here by speed (unk31).
    if(jEdge && PLAYER.onGround){
      PLAYER.onGround=false; PLAYER.jumped=true; PLAYER.hover.used=false; PLAYER.hover.active=false; PLAYER.postHeli=false; PLAYER.apexY=feet;
      PLAYER.takeoff=(PLAYER.speed>=9)?2:1;                        // 1=standing hop (animId50/pair23) ; 2=running somersault (animId55/pair11)
      if(zHeld){ PLAYER.yVel=PHYS.ZJUMP; PLAYER.zJump=true; } else { PLAYER.yVel=PHYS.JUMP; PLAYER.zJump=false; }
      PLAYER.launchYVel=PLAYER.yVel;                               // takeoff impulse -> drives the somersault phase across the arc
    }
    // ---- TAIL-SPIN HELICOPTER (ROM block L15060100): 2nd jump PRESS while airborne mid-first-jump starts it; then
    // HOLDING sustains and RELEASE ends it (after a lead-in), and it is TIMED (hard cap). Once per airborne jump.
    else if(jEdge && !PLAYER.onGround && PLAYER.jumped && !PLAYER.hover.used){
      PLAYER.hover.active=true; PLAYER.hover.used=true; PLAYER.hover.timer=3;      // unk31 := 3
      PLAYER.yVel=0; PLAYER.vel[0]*=PHYS.HOVER_XZ; PLAYER.vel[1]*=PHYS.HOVER_XZ; PLAYER.speed*=PHYS.HOVER_XZ;  // y_vel=0, xz*0.3
    }
    PLAYER.jHeld=jp;
    // ---- HELI per-frame: unk31 counts 3->62 (+2/fr). <13 -> tail spins him UP (+8/fr). Ends at cap 62, OR at >=19
    // when the button is released. Below 19 = guaranteed lead-in (can't cancel). On end, gravity snaps to 4.5.
    if(PLAYER.hover.active){
      PLAYER.hover.timer += 2*fr; const T=PLAYER.hover.timer;
      if(T>=PHYS.HELI_CAP || (T>=PHYS.HELI_CANCEL && !jp)){ PLAYER.hover.active=false; PLAYER.postHeli=true; }
      else if(T<PHYS.HELI_LIFT){ PLAYER.yVel=PHYS.HELI_LIFTV; }    // initial lift (tail spins up)
    }
    const grav=PLAYER.hover.active?PHYS.HOVER_GRAV:(PLAYER.postHeli?PHYS.HELI_EXPGRAV:(PLAYER.zJump?PHYS.ZGRAV:PHYS.GRAV));  // heli 1.0 / post-heli 4.5 / Z-jump floaty / normal 4.0
    PLAYER.yVel-=grav*fr;
    if(PLAYER.hover.active && PLAYER.hover.timer>=PHYS.HELI_LIFT && PLAYER.yVel<PHYS.HELI_CLAMP) PLAYER.yVel=PHYS.HELI_CLAMP;  // capped slow descent (-8/fr) = the hover
    if(PLAYER.yVel<-PHYS.TERMINAL) PLAYER.yVel=-PHYS.TERMINAL;     // terminal -500 (func_1505A770)
    // vertical position on the CHARACTER-SIZE scale (s3), so jump height is proportional to his rendered size
    // (horizontal uses the smaller movement 'feel' scale); JUMP_SCALE = fine-tune knob over the eyeballed bridge.
    let newFeet=feet+PLAYER.yVel*s3*PHYS.JUMP_SCALE*fr*PHYS.VINT;  // func_1505A770: position advances ~0.5*y_vel/frame
    const stepUp=charH*0.35, snapDown=charH*0.30;
    const gr=groundAt(PLAYER.pos[0],PLAYER.pos[2], Math.max(feet,newFeet)+stepUp);
    if(gr!=null && newFeet<=gr.y){ newFeet=gr.y; PLAYER.yVel=0; PLAYER.onGround=true; PLAYER.hover.active=false; PLAYER.hover.used=false; PLAYER.jumped=false; PLAYER.zJump=false; PLAYER.postHeli=false; PLAYER.takeoff=0;
      if(PLAYER.airTime>10 && PLAYER.landClip!=null && PLAYER.speed>150) PLAYER.landTimer=14;   // ROM: animId 66 is the MOVING land (func_1504CB98 @1504D894 gates on xz_velocity>5/tick =150/s). A STANDING jump (speed~0) plays NO land clip -> blends straight to idle 15. Gating on speed removes the wrong 66 pose after a standing hop (user: "standing-still jump lands with the wrong last animation").
    }  // land
    else if(gr!=null && PLAYER.onGround && PLAYER.yVel<=0 && (newFeet-gr.y)<snapDown){ newFeet=gr.y; PLAYER.yVel=0; PLAYER.onGround=true; }  // stick to downslopes
    else PLAYER.onGround=false;
    if(newFeet < _collision.mnY - charH*6){ newFeet=_collision.mnY - charH*6; PLAYER.yVel=0; }  // fell-off-world catch (no infinite fall)
    PLAYER.airTime=PLAYER.onGround?0:(PLAYER.airTime+fr);
    if(!PLAYER.onGround){ if(PLAYER.apexY==null||newFeet>PLAYER.apexY)PLAYER.apexY=newFeet; PLAYER.fallDist=PLAYER.apexY-newFeet; }  // fall distance from apex
    else { PLAYER.apexY=null; PLAYER.fallDist=0; }
    PLAYER.fallDistROM=PLAYER.fallDist/Math.max(1e-4,s3*PHYS.JUMP_SCALE);   // view units -> ROM units (450 = flail-fall gate; Z-jump ~470, normal jump ~232)
    PLAYER.pos[1]=newFeet+footOffV;
    PLAYER.lean.yVel=PLAYER.yVel;                                  // feed the pitch-lean (unkB8 jump/dive arc)
  } else { PLAYER.onGround=true; PLAYER.yVel=0; PLAYER.hover.active=false; PLAYER.hover.used=false; PLAYER.jumped=false; PLAYER.zJump=false; PLAYER.postHeli=false; PLAYER.lean.yVel=0; PLAYER.airTime=0; PLAYER.apexY=null; PLAYER.fallDist=0; }
  // ANIMATION STATE MACHINE + MIXER + RANDOM IDLE-FIDGETS (ROM aiIdx-brain func_1507F640, game_AC030.c):
  // moving -> walk. Idle -> base idle dominates; the brain counts DOWN an idle timer (shrinks with phase = restless),
  // then picks a fidget SEQUENCE (shuffle-bag) and plays its clips IN ORDER (the pull-out->loop->put-back chain),
  // then settles back to base idle, bumps phase, resets the timer. Each clip crossfades into the next.
  const A=PLAYER.anim, moving=PLAYER.speed>3||PLAYER.skid>0, F=PLAYER.fidget;   // skid keeps the locomotion clip (legs slide/plant) through the brake+quick-turn instead of flashing idle
  // ===== REACTIVE WHOLE-BODY LEAN (ROM game_77AD0.c springs -> func_150A9B0C root matrix). There is NO dedicated
  // tail system in the ROM (verified by full pose-pipeline dissection): the tail's non-baked motion is this whole-body
  // lean inherited down the bone hierarchy (pelvis 0 -> tail 24->25->26->27). unkC4=roll banks into turns; unkB8=pitch
  // follows the jump/dive velocity arc. Exact spring rates: turn 0.08 (D_80099348), idle decay 0.2 (D_80099344). =====
  { const L=PLAYER.lean, D2R=0.017453292;
    let dyaw=wrapPi(PLAYER.yaw-L.prevYaw); L.prevYaw=PLAYER.yaw;
    const turnRate=(dyaw/D2R)/Math.max(0.001,fr);            // heading change, deg per 30fps game-frame (ROM turnDelta)
    if(moving){ const t=turnRate*L.coef;                     // func_15052760: target = v0/(unk1E5*7) = turnDelta*13/unk1E5
        L.roll += (t-L.roll)*(1-Math.pow(0.92,fr)); }        // D_80099348 = 0.08 spring (framerate-compensated)
    else { L.roll += (0-L.roll)*(1-Math.pow(0.8,fr)); }      // func_15052590 idle decay, D_80099344 = 0.2
    L.roll=Math.max(-38,Math.min(38,L.roll));                // safety bound (ROM turn-rate target self-limits)
    const yVel=L.yVel||0;                                    // pitch (unkB8) = -atan2(y_vel, xz_vel)*57.29578 (ROM jump/dive case 0x42/0x88)
    // ONLY for a RUNNING jump/dive (real horizontal speed). A standing jump has xz~0, where atan2 -> +-90deg =
    // "lean all the way back then all the way forward" — WRONG. Standing jumps get no procedural pitch (spring clip poses him).
    let tp=0;
    if(!PLAYER.onGround && PLAYER.speed>9 && Math.abs(yVel)>0.001) tp=-Math.atan2(yVel,PLAYER.speed)/D2R;
    tp=Math.max(-32,Math.min(32,tp));                        // gentle arc lean only (~12deg at full run jump)
    L.pitch += (tp-L.pitch)*(1-Math.pow(0.8,fr)); }
  // TAIL DANGLY-CHAIN (ROM func_1503B9BC + func_1503CB98) — cache the solver inputs here; the chain is SOLVED and
  // WRITTEN BACK (overwrites bones 24-27) in drawPlayerInLevel, which has the posed world matrices it needs.
  // ROM: speed field 0x3C clamped 0..60 and EXACTLY 0 at idle so the RNG lateral twitch engages; unk28>=0.5 = airborne.
  PLAYER._fr=fr;
  PLAYER._faceMove=PLAYER.speed>60;   // MOVING FACE: ROM sets expr 0x2A (NARROW frown eyes) when xz_velocity>2.0/tick (=60/s), func_15065A5C:550-608. Relaxed to blink/neutral below.
  PLAYER._tailSpeed=(PLAYER.speed<3)?0:Math.min(60,PLAYER.speed/30);   // ROM sway input
  // DIRT DUST (ROM func_1515B674 burst): continuous foot puffs while running + a heavier trail on a hard skid/reverse + a burst on landing.
  if(PLAYER.onGround){
    PLAYER._dustT=(PLAYER._dustT||0)-fr;
    if(PLAYER._dustT<=0){
      if((PLAYER.reversing||PLAYER.sliding) && PLAYER.speed>40){ spawnDust(3); PLAYER._dustT=1.5; }   // SKID = heavier dust trail
      else if(PLAYER.speed>80){ spawnDust(1); PLAYER._dustT=3.0; }                                    // running = light foot puffs
    }
    if(PLAYER._wasAir) spawnDust(9);                                                                  // LANDING burst
  }
  PLAYER._wasAir=!PLAYER.onGround;
  updateDust(fr);
  PLAYER._airborne=PLAYER.onGround?0:1;
  const zHeldGround=PLAYER.onGround && !!keys['z'];
  PLAYER._crouch=false;
  let target;
  if(!PLAYER.onGround){                                            // AIRBORNE: latched takeoff / fall / flail / tail-spin heli / Z high-jump
    F.seq=-1; F.pos=0; F.phase=0; F.timer=fidgetDelay(0);
    if(PLAYER.hover.active) target=(PLAYER.hoverClip!=null?PLAYER.hoverClip:(PLAYER.fallClip!=null?PLAYER.fallClip:PLAYER.idleClip));  // tail-spin heli (animId 233/pair20)
    else if(PLAYER.zJump && PLAYER.yVel>-6 && PLAYER.zJumpClip!=null) target=PLAYER.zJumpClip;   // Z crouch->rise HIGH jump rise (animId 235/pair21)
    else if(PLAYER.takeoff===2 && !PLAYER.zJump && !PLAYER.hover.used && PLAYER.jumpRunClip!=null) target=PLAYER.jumpRunClip;  // RUNNING jump: the 360 somersault (animId 55/pair11) OWNS THE WHOLE AIRTIME — ROM func_1505F298 sets animId55 once at takeoff and never restarts it (func_1505E0C4 t2==0 gate), so it plays continuously takeoff->land. Checked BEFORE the flail so a normal running jump never flails mid-spin.
    else if(PLAYER.fallDistROM>PHYS.FLAIL_FALL && PLAYER.highFallClip!=null) target=PLAYER.highFallClip;  // BIG fall / Z high-jump DESCENT -> legs-up flail (clip aid 12). SOURCED: fall-distance>450 sets the fall-damage counter 0x1CA (func_1505B5F8.s:130), which func_1505E874.s:134-135 branches on to remap the clip -> flail. Placed BELOW the somersault so it only catches non-somersault falls: Z high-jump (~470>450) flails, normal jump (~232) never does.
    else if(PLAYER.yVel>2) target=(PLAYER.jumpStandClip!=null?PLAYER.jumpStandClip:PLAYER.idleClip);   // standing jump rise = plain hop (animId 50/pair23)
    else target=(PLAYER.fallClip!=null?PLAYER.fallClip:PLAYER.idleClip);                         // ordinary fall (animId 59/pair4) — fall-distance < 450
  }
  else if(zHeldGround && PLAYER.zJumpClip!=null){ target=PLAYER.zJumpClip; PLAYER._crouch=true; F.seq=-1; F.pos=0; F.phase=0; F.timer=fidgetDelay(0); }  // Z held = crouch/ready stance (Z-jump wind-up, held at frame 0)
  else if(moving){ F.seq=-1; F.pos=0; F.phase=0; F.timer=fidgetDelay(0); PLAYER.landTimer=0;
    target=(PLAYER.walkClip!=null?PLAYER.walkClip:PLAYER.idleClip); }                   // walk/run (one clip, cadence tracks speed); moving cancels a landing pose.
    // ROM has NO dedicated skid CLIP (proven: func_15123A54 sets no animId, no selector reads unk8E4/8EC/7B8, unk23E never set to a skid value). A hard-reversal
    // SKID plays THIS locomotion clip at velocity-scaled cadence (func_1505841C) + the reactive turn-lean, while the 180° pivot + speed-clamp-300 is physics (func_15123A54).
  else if(PLAYER.landTimer>0 && PLAYER.landClip!=null){            // brief LANDING impact pose after a real fall (ROM animId 66, func_1504CB98:4474) — ends on its own or the instant you move
    PLAYER.landTimer=Math.max(0,PLAYER.landTimer-fr); target=PLAYER.landClip; F.seq=-1; F.pos=0; F.phase=0; F.timer=fidgetDelay(0); }
  else if(F.seq>=0){                                               // mid fidget sequence: play current item, advance when it ends
    const seq=FIDGET_SEQS[F.seq]; let it=seq[F.pos]; let ci=(it&&PLAYER.byAid)?PLAYER.byAid[it[0]]:null;
    target=(ci!=null)?ci:PLAYER.idleClip;
    if(A.cur===target && A.curT>=clipLen(PLAYER.model,target)){    // current clip finished -> next item / end
      F.pos++;
      if(F.pos>=seq.length){ F.seq=-1; F.pos=0; F.phase=Math.min(3,F.phase+1); F.timer=fidgetDelay(F.phase); target=PLAYER.idleClip; }
      else { it=seq[F.pos]; ci=(it&&PLAYER.byAid)?PLAYER.byAid[it[0]]:null; target=(ci!=null)?ci:PLAYER.idleClip; }
    }
  } else {                                                          // base idle: count down, then launch a fidget sequence
    target=PLAYER.idleClip;
    if(PLAYER.fidgetsOn && A.cur===PLAYER.idleClip && PLAYER.idleClip!=null){
      F.timer-=fr;
      if(F.timer<=0){ F.seq=pickFidgetSeq(); F.pos=0;
        const it=FIDGET_SEQS[F.seq][0], ci=(it&&PLAYER.byAid)?PLAYER.byAid[it[0]]:null; if(ci!=null)target=ci; }
    }
  }
  if(target!=null && target!==A.cur){                              // begin a crossfade to the new clip
    A.prev=A.cur; A.prevT=A.curT; A.cur=target; A.curT=0;
    A.blendDur=(target===PLAYER.hoverClip)?6:(target===PLAYER.walkClip||target===PLAYER.turnClip||target===PLAYER.pivotClip||target===PLAYER.zJumpClip)?4:(target===PLAYER.jumpRunClip||target===PLAYER.jumpStandClip||target===PLAYER.fallClip||target===PLAYER.highFallClip||target===PLAYER.landClip)?3:6;  // ROM blend frames (pivot/turn 4, heli unk3C=6)
    A.blend=(A.prev==null)?0:A.blendDur;
  }
  // playback rate: walk cadence tracks velocity (ROM func_1505841C: ~0.5 baseline + xz_velocity term); fidget = its
  // descriptor speedPct (D_8009B8B0, mostly 100=1x); base idle = 1x.
  const spd=(STATE.animSpeed||1)*PLAYER.animRate, walkRate=0.5+(1.624/267)*PLAYER.speed;   // ROM func_1505841C (game_83300.c:372-393): locomotion cadence is velocity-LINEAR (rate = xz_vel*0.5/scale/(clipLen*10) + floor) with floor 0.1+0.4=0.5 (D_8009946C/D_80099470) and NO saturation. The old min(1,spd/267) flat-lined the cycle at walk speed = "runs slow" when actually running. slope 1.624/267 preserves the prior walk-speed feel under the corrected 1.0 global; scales up uncapped: run 370->2.75x, sprint 530->3.72x.
  let curRate=1.0;
  if(A.cur===PLAYER.walkClip) curRate=walkRate;
  else if(A.cur===PLAYER.hoverClip) curRate=PHYS.HELI_SPIN;          // tail-spin whirls fast (helicopter)
  else if(A.cur===PLAYER.jumpRunClip){                               // running-jump 360 somersault. ROM plays a FIXED 0.8x (D_80099650) and TUNES jump height/gravity so the clip finishes exactly at landing (func_1505F298 sets it once, plays it straight through). Our jump physics aren't in ROM units, so a fixed 0.8x would end mid-air = the "jump-pose, then spin, then land" segmentation. Instead we lock the rate to the predicted airtime -> ONE continuous spin, takeoff to landing (the ROM's visual result). Clamped so short hops don't over-spin.
    const air=Math.max(10, 2*PLAYER.launchYVel/PHYS.GRAV);          // predicted airtime, 30fps-frames (2*v0/g)
    curRate=Math.max(0.6, Math.min(3.2, clipLen(PLAYER.model,PLAYER.jumpRunClip)/air));
  }
  else if(A.cur===PLAYER.zJumpClip) curRate=PLAYER._crouch?0:1.08;   // Z: hold the crouch at frame 0 while Z held; play crouch->rise @1.08x (D_80099660) once launched
  else if(F.seq>=0){ const it=FIDGET_SEQS[F.seq][F.pos]; if(it) curRate=it[1]/100; }
  A.curT  += fr*spd*curRate;
  A.prevT += fr*spd*((A.prev===PLAYER.walkClip)?walkRate:1.0);
  if(A.blend>0)A.blend=Math.max(0,A.blend-fr);
  PLAYER.clip=A.cur;                                               // HUD label
  STATE.target=PLAYER.pos.slice();                                 // third-person camera follows Conker
  updatePlayerHUD();
}
function propModelMat(pr,m){ // local part space -> centered/scaled viewer space (column-major GL)
  const s=m._s,cx=m._cx,cy=m._cy,cz=m._cz, sc=pr.sc, T=pr.pos;
  let rx=pr.rot[0],ry=pr.rot[1],rz=pr.rot[2],ty=T[1];
  const bx=behXform(pr,T);   // ROM per-frame actor update (idle motion), if any
  if(bx){if(bx.rx!==undefined)rx=bx.rx; if(bx.ry!==undefined)ry=bx.ry; if(bx.rz!==undefined)rz=bx.rz; if(bx.ty!==undefined)ty=bx.ty;}
  // Placement orientation R. The state hinge (urot) is a LOCAL-frame rotation of the part about its own
  // pivot (origin) — applied to raw geometry BEFORE R, so a jaw hinges up/down in the head's frame no
  // matter which way the head is turned. Composing v·(H·R), NOT euler-summing (which spins the world axis).
  const u=pr.urot; let R=rotMat3(rx,ry,rz);
  if(u[0]||u[1]||u[2])R=mat3mul(rotMat3(u[0],u[1],u[2]),R);
  const M=new Float32Array(16);
  M[0]=s*sc[0]*R[0][0];M[4]=s*sc[1]*R[1][0];M[8]=s*sc[2]*R[2][0];M[12]=s*(T[0]-cx);
  M[1]=s*sc[0]*R[0][1];M[5]=s*sc[1]*R[1][1];M[9]=s*sc[2]*R[2][1];M[13]=s*(ty-cy);
  M[2]=s*sc[0]*R[0][2];M[6]=s*sc[1]*R[1][2];M[10]=s*sc[2]*R[2][2];M[14]=s*(T[2]-cz);
  M[15]=1; return M;
}
function uploadProps(m){
  if(!m._pp||m._ppbuf)return;
  m._ppbuf=m._pp.map(part=>part.map(g=>({ti:g.ti,anim:g.anim,aspd:g.aspd,aph:g.aph,wob:g.wob,scroll:g.scroll,dec:g.dec,bl:g.bl,al:g.al,ac:g.ac,ws:g.ws,wt:g.wt,sky:g.sky,mod:g.mod,vat:g.vat,tg:g.tg,trig:g.trig,litnrm:g.litnrm,tint:g.tint,n:g.n,
    p:glBuf(g.pos,gl.ARRAY_BUFFER),nr:glBuf(g.nrm,gl.ARRAY_BUFFER),uv:glBuf(g.uv,gl.ARRAY_BUFFER),co:glBuf(g.col,gl.ARRAY_BUFFER),va:glBuf(g.va,gl.ARRAY_BUFFER),ix:glBuf(g.idx,gl.ELEMENT_ARRAY_BUFFER)})));
}
function uploadMesh(m){
  if(m._buf)return; m._buf=m._g.map(g=>({ti:g.ti,anim:g.anim,aspd:g.aspd,aph:g.aph,wob:g.wob,scroll:g.scroll,dec:g.dec,bl:g.bl,al:g.al,ac:g.ac,ws:g.ws,wt:g.wt,sky:g.sky,mod:g.mod,vat:g.vat,tg:g.tg,trig:g.trig,litnrm:g.litnrm,tint:g.tint,n:g.n,
    p:glBuf(g.pos,gl.ARRAY_BUFFER),nr:glBuf(g.nrm,gl.ARRAY_BUFFER),uv:glBuf(g.uv,gl.ARRAY_BUFFER),co:glBuf(g.col,gl.ARRAY_BUFFER),va:glBuf(g.va,gl.ARRAY_BUFFER),ix:glBuf(g.idx,gl.ELEMENT_ARRAY_BUFFER)}));
  uploadProps(m);
}
function resize(){const dpr=Math.min(window.devicePixelRatio||1,2),w=cvs.clientWidth,h=cvs.clientHeight;if(cvs.width!==w*dpr||cvs.height!==h*dpr){cvs.width=w*dpr;cvs.height=h*dpr;}}
function cssvar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function hex2rgb(x){x=x.replace('#','');if(x.length===3)x=x.split('').map(c=>c+c).join('');return[parseInt(x.slice(0,2),16)/255,parseInt(x.slice(2,4),16)/255,parseInt(x.slice(4,6),16)/255];}
let stageBG=[0.03,0.04,0.06];function readTheme(){try{stageBG=hex2rgb(cssvar('--stage')||'#080a0f');}catch(e){}}
function eyePos(){const cp=Math.cos(STATE.pitch),sp=Math.sin(STATE.pitch),cy=Math.cos(STATE.yaw),sy=Math.sin(STATE.yaw);return V3.add(STATE.target,V3.scale([cp*sy,sp,cp*cy],STATE.dist));}
function camBasis(){const e=eyePos();const f=V3.norm(V3.sub(STATE.target,e));const s=V3.norm(V3.cross(f,[0,1,0]));const u=V3.cross(s,f);return{e,f,s,u};}
function applyKeys(){if(PLAYER.on)return;const sp=STATE.dist*0.028;const{f,s}=camBasis();   // play mode: WASD drives Conker, not the camera
  if(keys['w'])STATE.target=V3.add(STATE.target,V3.scale(f,sp));if(keys['s'])STATE.target=V3.add(STATE.target,V3.scale(f,-sp));
  if(keys['a'])STATE.target=V3.add(STATE.target,V3.scale(s,-sp));if(keys['d'])STATE.target=V3.add(STATE.target,V3.scale(s,sp));
  if(keys['e'])STATE.target[1]+=sp;if(keys['q'])STATE.target[1]-=sp;}
const WOB_RATE=2;   // Mechanism D UV-phase advance (angle-units/30fps-frame); = confirmed brightness-pulse tick 2*D_800BE9E4
let animT=0,poseT=0,_lastT=0;   // animT/poseT are 30fps-EQUIVALENT frame units, advanced by real elapsed
// time (below) so every animation — texture cycles, water, skeletal poses, panels — runs at the game's
// intended speed regardless of the viewer's actual (variable, often 60/120/144Hz) refresh rate.
function render(){
  resize();
  if(gl&&prog){
    gl.viewport(0,0,cvs.width,cvs.height);gl.clearColor(stageBG[0],stageBG[1],stageBG[2],1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(STATE.spin&&!dragging)STATE.yaw+=0.0038; applyKeys();
    if(mesh&&mesh._pose){drawPosable(mesh);}
    else if(mesh&&mesh._buf){
      const asp=cvs.width/cvs.height,near=Math.max(0.004,STATE.dist*0.006),far=STATE.dist*8+60;
      const P=M4.persp(0.92,asp,near,far),{e}=camBasis(),Vv=M4.lookAt(e,STATE.target,[0,1,0]),MVP=M4.mul(P,Vv);
      gl.uniformMatrix4fv(uMVP,false,new Float32Array(MVP));gl.uniform3f(uLight,0.45,0.75,0.55);
      // eye-space normal matrix (view rotation 3x3) for G_TEXTURE_GEN chrome UVs. Model is identity here (positions
      // pre-centred/scaled in procGroup), so model->eye rotation == the view rotation.
      if(uNMat)gl.uniformMatrix3fv(uNMat,false,new Float32Array([Vv[0],Vv[1],Vv[2],Vv[4],Vv[5],Vv[6],Vv[8],Vv[9],Vv[10]]));
      const af=Math.floor(animT/22);
      const tex0=STATE.cmode===0;
      function drawGroup(g){
        if(g.trig&&!STATE.triggers)return;   // invisible trigger/zone volume -> hidden by default (Triggers toggle)
        let mode=STATE.cmode;
        // flowing/animated tile scroll (N64 SETTILESIZE ULS/ULT scroll): offset UVs by rate*time (fract to keep
        // float precision). scroll=[du,dv] in UV per 30fps-frame. Reset to 0 for every non-scrolling group.
        // g.wob (Mechanism D, func_1511D394): sinusoidal shimmer, reducible to a UNIFORM time-varying UV offset
        // (ground truth: it writes the same offset to every vertex). S = eased-sine oscillation (bias 73 + amp 794,
        // in S10.5 1/32-texel); T = accumulating drift (t1=round(6.25-12.5cos), wraps @64tx). Phase-rate WOB_RATE is
        // the confirmed brightness-pulse tick (2/frame) used as a proxy for the runtime UV master timer.
        if(uScroll){
          if(g.wob!=null){
            const tw=(g.ti>=0&&DATA.textures[g.ti])?DATA.textures[g.ti].w:32, th=(g.ti>=0&&DATA.textures[g.ti])?DATA.textures[g.ti].h:32;
            const w=WOB_RATE*Math.PI/128, ang=w*animT;               // 256 angle-units = 2π
            const s_osc=(Math.sin(ang)+1)*0.5, t0=Math.round(s_osc*794)+73;   // S offset (1/32 texel)
            const vacc=(6.25*animT-12.5*Math.sin(ang)/(w||1))/32;    // ∫ t1 dt (t1=6.25-12.5cos) = accumulating T drift
            gl.uniform2f(uScroll, ((t0/32)/tw)%1, (-(vacc/th))%1);   // shader vUV=aUV-uScroll: -t0 on S, +accum on T
          } else if(g.scroll)gl.uniform2f(uScroll,(g.scroll[0]*animT)%1,(g.scroll[1]*animT)%1);
          else gl.uniform2f(uScroll,0,0);
        }
        if(uTexgen)gl.uniform1f(uTexgen, g.tg?1.0:0.0);       // G_TEXTURE_GEN chrome surface -> UVs from eye normal
        if(uLitNrm)gl.uniform1f(uLitNrm, g.litnrm?1.0:0.0);   // has real ROM normals -> light it (white-vert objects)
        if(mode===0){
          let ti=g.ti;
          // frame-cycle: per-segment PHASE (aph) drives the World-0x33 traveling wave (each RSP segment 2-7 shows a
          // different flipbook frame). frame=(gaf+aph)%len; aph = 13*(seg-2) from func_150D765C's +13/segment step.
          if(g.anim&&g.anim.length){const gaf=Math.floor(animT/(g.aspd||10));ti=g.anim[(gaf+(g.aph||0))%g.anim.length];}   // per-set speed (data f1 hold byte)
          if(ti>=0&&GTEX[ti]){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,GTEX[ti]);gl.uniform1i(uTex,0);gl.uniform1f(uMode,0.0);
            // Big TILING world surfaces (walls/floors) get smooth LINEAR magnification like before — NEAREST
            // made their low-res texels look blocky. Clamped decals/signs stay crisp NEAREST.
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,(mesh.kind==='level'&&!(g.ws===2&&g.wt===2))?gl.LINEAR:gl.NEAREST);
            // scrolling surfaces must REPEAT so the flow wraps (clamp would freeze at the edge). wob shimmers likewise.
            const _flow=(g.scroll||g.wob!=null);
            const _wS=g.tg?gl.CLAMP_TO_EDGE:(_flow?gl.REPEAT:(g.ws===2?gl.CLAMP_TO_EDGE:(g.ws===1?gl.MIRRORED_REPEAT:gl.REPEAT)));  // texgen sphere-map UVs live in [0,1] -> clamp
            const _wT=g.tg?gl.CLAMP_TO_EDGE:(_flow?gl.REPEAT:(g.wt===2?gl.CLAMP_TO_EDGE:(g.wt===1?gl.MIRRORED_REPEAT:gl.REPEAT)));
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,_wS);   // clamp=decals/signs, mirror=symmetric rugs
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,_wT);
            if(g.tint)gl.uniform3f(uTint,g.tint[0]/255,g.tint[1]/255,g.tint[2]/255);else gl.uniform3f(uTint,1,1,1);
            gl.uniform1f(uAlphaMode, g.bl?(g.al?1.0:(g.vat?3.0:2.0)):0.0); gl.uniform1f(uMod, g.mod?1.0:0.0);}   // vat=per-vertex alpha (glass), al=texA, else luminance
          else {gl.uniform1f(uMode,1.0);gl.uniform1f(uAlphaMode,(g.bl&&g.vat)?3.0:0.0);gl.uniform1f(uMod, g.mod?1.0:0.0);}   // flat-shaded (UV0) faces: mod=1 -> vC is baked shade; bl+vat -> honour per-vertex alpha (untextured glass/overlay)
        } else if(mode===1){gl.uniform1f(uMode,1.0);gl.uniform1f(uAlphaMode,0.0);}
          else {gl.uniform1f(uMode,2.0);gl.uniform1f(uAlphaMode,0.0);const pc=hex2rgb(cssvar('--accent')||'#e0873c');gl.uniform3f(uFlatCol,pc[0],pc[1],pc[2]);}
        if(g.dec){gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1.2,-2.0);}else{gl.disable(gl.POLYGON_OFFSET_FILL);}
        bindA(aPos,g.p,3);bindA(aNrm,g.nr,3);bindA(aUV,g.uv,2);bindA(aCol,g.co,3);bindA(aVA,g.va,1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.ix);gl.drawElements(gl.TRIANGLES,g.n,gl.UNSIGNED_SHORT,0);
      }
      // pass 1: opaque (defer translucent groups in textured mode)
      gl.disable(gl.BLEND);gl.depthMask(true);
      for(const g of mesh._buf){ if(!STATE.sky&&g.sky)continue; if(tex0&&g.bl)continue; drawGroup(g); }
      // pass 2: translucent (light shafts, water) — blend, no depth write
      if(tex0){
        gl.enable(gl.BLEND);gl.depthMask(false);
        for(const g of mesh._buf){ if(!STATE.sky&&g.sky)continue; if(!g.bl)continue;
          // light shafts (translucent, NO alpha channel -> luminance-keyed) are bright textures that read as an
          // opaque grey box under normal over-blend; draw them ADDITIVELY so they glow. Alpha-translucent
          // surfaces (glass/water, has real alpha) keep normal over-blend.
          gl.blendFunc(gl.SRC_ALPHA, (g.al||g.vat)?gl.ONE_MINUS_SRC_ALPHA:gl.ONE);
          drawGroup(g); }
        gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(true);gl.disable(gl.BLEND);
      }
      // pass 3: INSTANCED PROPS (placed objects) — each drawn with its own model matrix so state
      // variants can be toggled and hinges (dino jaw / doors) scrubbed live.
      if(mesh._ppbuf&&mesh._props){try{
        for(const pr of mesh._props){ if(!pr.vis)continue; const part=mesh._ppbuf[pr.pp]; if(!part)continue;
          gl.uniformMatrix4fv(uMVP,false,M4.mul(MVP,propModelMat(pr,mesh)));
          gl.disable(gl.BLEND);gl.depthMask(true);
          for(const g of part){ if(tex0&&g.bl)continue; drawGroup(g); }
          if(tex0){ gl.enable(gl.BLEND);gl.depthMask(false);
            for(const g of part){ if(!g.bl)continue; gl.blendFunc(gl.SRC_ALPHA,(g.al||g.vat)?gl.ONE_MINUS_SRC_ALPHA:gl.ONE); drawGroup(g); }
            gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(true);gl.disable(gl.BLEND); }
        }
        }catch(e){console.error('prop draw',e);mesh._props=null;}
        gl.uniformMatrix4fv(uMVP,false,new Float32Array(MVP));   // restore camera MVP for wire pass
      }
      if(PLAYER.on)drawPlayerInLevel(MVP,Vv);   // PLAY MODE: Conker standing in the level (v1 keystone)
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if(STATE.wire){gl.uniform1f(uMode,3.0);gl.uniform1f(uAlphaMode,0.0);const wc=hex2rgb(cssvar('--line')||'#262b36');gl.uniform3f(uFlatCol,wc[0],wc[1],wc[2]);
        for(const g of mesh._buf){if(g.trig&&!STATE.triggers)continue;bindA(aPos,g.p,3);bindA(aNrm,g.nr,3);bindA(aUV,g.uv,2);bindA(aCol,g.co,3);bindA(aVA,g.va,1);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,g.ix);gl.drawElements(gl.LINES,g.n,gl.UNSIGNED_SHORT,0);}}
    }
    $('#cDist').textContent=STATE.dist.toFixed(2);
    const _now=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
    if(!_lastT)_lastT=_now; const _dt=Math.min(0.1,(_now-_lastT)/1000); _lastT=_now;   // clamp dt (tab-away)
    animT+=_dt*30; poseT+=_dt*30*STATE.animSpeed;   // 30 = N64 target fps -> FPS-independent playback
    if(PLAYER.on)updatePlayer(_dt);   // play mode: drive Conker + follow camera
  }
  requestAnimationFrame(render);
}
function bindA(attr,buf,size){if(attr<0)return;gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.enableVertexAttribArray(attr);gl.vertexAttribPointer(attr,size,gl.FLOAT,false,0,0);}
// ---- UI ----
function curList(){
  if(STATE.cat==='textures')return [];   // textures use their own gallery, not the rail list
  if(STATE.cat==='audio'){const q=($('#search').value||'').toLowerCase();
    return AUDIO.samples.map((m,i)=>({m,i})).filter(o=>(STATE.audioReg==null||o.m.r===STATE.audioReg)&&(!q||o.m.name.includes(q)||(''+o.i).includes(q)));}
  const arr=DATA[STATE.cat]||[];const q=($('#search').value||'').toLowerCase();return arr.map((m,i)=>({m,i})).filter(o=>!q||o.m.name.toLowerCase().includes(q));}
function resetCam(){STATE.target=[0,0,0];STATE.yaw=0.7;STATE.pitch=0.5;STATE.dist=4.4;}
function populateAnimSel(m){
  const sel=$('#animSel'); if(!sel)return; sel.innerHTML='';
  const nclip=(m._pose&&m._pose.clips)?m._pose.clips.length:0;
  const add=(v,l)=>{const o=document.createElement('option');o.value=v;o.textContent=l;sel.appendChild(o);};
  add('idle','Idle (synthetic)'); add('bind','Bind pose');   // idle first = the default
  // CONKER player moves: animId -> group-15 anim table -> rawIdx (= clip's stored `aid`). Verified from source.
  const isConker=(m.id>=1&&m.id<=4&&m._pose&&m._pose.clips);
  const byAid={}; if(isConker)m._pose.clips.forEach((c,i)=>{if(c.aid!=null&&byAid[c.aid]===undefined)byAid[c.aid]=i;});
  if(isConker&&ANIMTAB){ for(const mv of ANIMTAB.moves){const ci=byAid[mv[1]]; if(ci!==undefined)add('clip'+ci,'▶ '+mv[0]);} }
  // generic clip list, annotated with the real game animId(s) that select each clip (via rawIdx)
  for(let i=0;i<nclip;i++){ let lbl='Clip '+(i+1);
    if(isConker&&ANIMTAB){const c=m._pose.clips[i];const ids=(c&&c.aid!=null)?ANIMTAB.r2a[c.aid]:null;if(ids&&ids.length)lbl+=' · anim '+ids.slice(0,4).join('/')+(ids.length>4?'…':'');}
    add('clip'+i,lbl); }
  STATE.poseAnim='idle'; sel.value='idle';   // always default to the synthetic idle, even when real clips exist
  sel.onchange=()=>{const v=sel.value;STATE.poseAnim=v.slice(0,4)==='clip'?parseInt(v.slice(4),10):v;animT=0;poseT=0;updatePoseNote(m);};
  const sp=$('#animSpeed'),spv=$('#animSpeedVal');
  if(sp){sp.value=STATE.animSpeed;if(spv)spv.innerHTML=(+STATE.animSpeed).toFixed(2)+'&times;';
    sp.oninput=()=>{STATE.animSpeed=+sp.value;if(spv)spv.innerHTML=(+sp.value).toFixed(2)+'&times;';};}
  populateAttachSel(m);
  updatePoseNote(m);
}
// socketed-attachment picker: mount any part from the D_80086CC4 attachment table onto this character's bone
function populateAttachSel(m){
  const sel=$('#attachSel'); if(!sel)return; sel.innerHTML='';
  const row=sel.closest('.tg'); const add=(v,l)=>{const o=document.createElement('option');o.value=v;o.textContent=l;sel.appendChild(o);};
  // The D_80086CC4 attachment table's bone indices are CONKER's skeleton slots -> only valid on Conker (models 1-4).
  const isConker=(m.id>=1&&m.id<=4);
  if(row)row.style.display=isConker?'':'none';
  add('','None');
  if(isConker)for(const o of (DATA.attachments||[])){const p=o.parts[0];
    add(o.oid,'obj'+o.oid+' · model '+p.model+' @bone '+p.bone+(o.parts.length>1?(' +'+(o.parts.length-1)):''));}
  STATE.attach=null; sel.value='';
  sel.onchange=()=>{STATE.attach=sel.value?parseInt(sel.value,10):null;};
}
// texture-variant picker (e.g. shirt colour): several NPCs share one model, differing only by which manifest
// entry the runtime binds to seg 0xA (manifest[struct127+0x68], func_1502F01C). build emits one group per variant.
function populateShirtSel(m){
  const sel=$('#shirtSel'),row=$('#shirtRow'); if(!sel)return; sel.innerHTML='';
  const v=m.variants;
  if(!v){ if(row)row.style.display='none'; STATE.shirt=0; return; }
  if(row)row.style.display='';
  v.names.forEach((nm,k)=>{const o=document.createElement('option');o.value=k;o.textContent=nm;sel.appendChild(o);});
  STATE.shirt=v.default||0; sel.value=STATE.shirt;
  sel.onchange=()=>{STATE.shirt=parseInt(sel.value,10);};
}
function updatePoseNote(m){
  const el=$('#poseNote'); if(!el)return;
  const nclip=(m._pose&&m._pose.clips)?m._pose.clips.length:0;
  el.textContent = typeof STATE.poseAnim==='number' ? ('real in-game animation · clip '+(STATE.poseAnim+1)+' / '+nclip)
                 : STATE.poseAnim==='bind' ? 'bind pose (rest)' : 'synthetic idle sway';
  $('#foot-note').textContent = nclip ? ('live rig · '+nclip+' real in-game clips') : 'live skeletal rig (no clip pack matched)';
}
function selectModel(cat,i){PLAYER.on=false;updatePlayerHUD();STATE.cat=cat;STATE.idx=i;setCatUI();   // leaving the level despawns the player
  if(cat==='audio'){selectAudio(i);return;}
  const m=DATA[cat][i];
  if(cat==='posable'){preparePosable(m);mesh=m;resetCam();hideStates();
    document.querySelectorAll('.item').forEach(el=>el.classList.toggle('on',el.dataset.cat===cat&&+el.dataset.i===i));
    $('#bName').textContent=m.name;$('#sSrc').textContent='assets01 · skeleton';$('#sTris').textContent=fmt(m.ntri);
    const nt=new Set();for(const g of m.groups){if(g.ti>=0)nt.add(g.ti);}
    $('#sTex').textContent=nt.size+' tex · '+m.bones.length+' bones';$('#sKind').textContent='rigged character';
    populateAnimSel(m);populateShirtSel(m);return;}
  prep(m);uploadMesh(m);mesh=m;resetCam();try{buildStatesPanel(m);}catch(e){console.error('statesPanel',e);hideStates();}
  document.querySelectorAll('.item').forEach(el=>el.classList.toggle('on',el.dataset.cat===cat&&+el.dataset.i===i));
  $('#bName').textContent=m.name;$('#sSrc').textContent=m.src||'—';$('#sTris').textContent=fmt(m.ntri);
  const nt=new Set();let anim=false;for(const g of m.groups){if(g.ti>=0)nt.add(g.ti);if(g.anim)anim=true;}
  $('#sTex').textContent=nt.size+(anim?' +anim':'');$('#sKind').textContent=m.kind;
  $('#foot-note').textContent=(m.kind==='level'?'world geometry + textures':'character / object')+(anim?' · animated water/lava':'');}
STATE.states=false;
function hideStates(){const t=$('#statesTg');if(t)t.style.display='none';const p=$('#states');if(p)p.style.display='none';STATE.states=false;const b=$('#tStates');if(b){b.textContent='Off';b.classList.remove('on');}}
function buildStatesPanel(m){
  const panel=$('#states'),tg=$('#statesTg'); if(!panel||!tg)return;
  if(!m._props||!m._props.length){hideStates();return;}
  tg.style.display='';
  const groups={}; m._props.forEach((pr,i)=>{(groups[pr.grp]=groups[pr.grp]||[]).push(i);});
  let html='<span class="close" id="statesClose">&times;</span><div class="hd">LEVEL STATES / SWAPS</div>';
  let shown=0;
  // Objects rotate about a LOCAL-frame euler component (decomp: func_151151FC/1511515C/151150BC each hinge
  // a different axis 0x0/0x4/0x8 of the actor). We expose all three; the correct one hinges the part in
  // its own frame (a jaw goes up/down via pitch, not sideways via yaw).
  const AX=[['pitch (X)','tilt up / down'],['yaw (Y)','swing left / right'],['roll (Z)','bank / spin']];
  const behName=b=>b===0x35?'HINGE (jaw / door)':('beh 0x'+b.toString(16));
  // Sort so the MOVABLE objects surface first: hinges (jaw/doors, beh 0x35), then co-located swaps, then
  // other behaviours/swap-states -- otherwise the dino jaw is buried among all the placed props.
  const behOf=gid=>{const b=groups[gid].map(i=>m._props[i].beh>>>0).find(b=>b!==0xffffffff&&b!==0);return b||0;};
  const prio=gid=>{const ix=groups[gid];if(behOf(gid)===0x35)return 0;if(ix.length>1)return 1;if(ix.some(i=>m._props[i].st!==0))return 2;if(behOf(gid))return 3;return 4;};
  Object.keys(groups).sort((a,b)=>prio(a)-prio(b)).forEach(gid=>{
    const idxs=groups[gid];
    const anyDyn=idxs.some(i=>m._props[i].fl&1);
    const anyBeh=idxs.some(i=>m._props[i].beh!==0xffffffff&&m._props[i].beh!==0);
    const anyAlt=idxs.some(i=>m._props[i].st!==0);   // a non-default state = a swap alternate, even if not co-located
    const anyRt=idxs.some(i=>{const p=m._props[i];return p.pos[0]===0&&p.pos[1]===0&&p.pos[2]===0;});   // runtime/script-placed object worth toggling
    if(idxs.length<2 && !anyDyn && !anyBeh && !anyAlt && !anyRt) return;   // skip only plain static single props
    shown++;
    const pr0=m._props[idxs[0]], tags=[];
    if(pr0.ext)tags.push('external'); if(anyDyn)tags.push('dynamic'); if(anyBeh)tags.push(behName(behOf(gid))); if(anyAlt&&idxs.length<2)tags.push('swap-state');
    const atOrigin=pr0.pos[0]===0&&pr0.pos[1]===0&&pr0.pos[2]===0;
    const where=atOrigin?'runtime-placed':('pos '+pr0.pos.map(v=>v|0).join(', '));
    const kind=pr0.ext?'obj':'part';
    html+='<div class="grp"><div class="lbl">'+kind+' '+(pr0.id!=null?pr0.id:gid)+' · '+where+(tags.length?' · '+tags.join(' · '):'')+' <span class="rst" data-grp="'+gid+'">reset</span></div>';
    if(idxs.length>1){ html+='<div class="hint">variants (toggle any / all):</div><div>';
      idxs.forEach(i=>{const p=m._props[i];html+='<span class="chip'+(p.vis?' on':'')+'" data-i="'+i+'">state '+p.st+'</span>';});
      html+='</div>'; }
    html+='<div class="hint">hinge (local axis):</div>';
    AX.forEach((a,ax)=>{ html+='<label class="axl" title="'+a[1]+'">'+a[0]+'<span class="v" data-vg="'+gid+'" data-va="'+ax+'">0&deg;</span>'
      +'<input type="range" min="-180" max="180" step="1" value="0" data-grp="'+gid+'" data-ax="'+ax+'"></label>'; });
    html+='</div>';
  });
  if(!shown)html+='<div class="lbl" style="padding-top:6px">no swap/dynamic objects here — this level is static.</div>';
  panel.innerHTML=html;
  const cl=$('#statesClose'); if(cl)cl.onclick=()=>hideStates();
  // variant chips: INDEPENDENT toggles — any number can be on at once (overlapping swaps allowed)
  panel.querySelectorAll('.chip').forEach(ch=>{ch.onclick=()=>{const i=+ch.dataset.i;m._props[i].vis=m._props[i].vis?0:1;ch.classList.toggle('on',!!m._props[i].vis);};});
  panel.querySelectorAll('input[type=range]').forEach(sl=>{sl.oninput=()=>{const gid=sl.dataset.grp,ax=+sl.dataset.ax,v=+sl.value;
    (groups[gid]||[]).forEach(i=>{m._props[i].urot[ax]=v;});
    const vs=panel.querySelector('.v[data-vg="'+gid+'"][data-va="'+ax+'"]');if(vs)vs.innerHTML=v+'&deg;';};});
  panel.querySelectorAll('.rst').forEach(r=>{r.onclick=()=>{const gid=r.dataset.grp;(groups[gid]||[]).forEach(i=>{m._props[i].urot=[0,0,0];});
    panel.querySelectorAll('input[data-grp="'+gid+'"]').forEach(sl=>{sl.value=0;});
    panel.querySelectorAll('.v[data-vg="'+gid+'"]').forEach(vs=>vs.innerHTML='0&deg;');};});
  panel.style.display=STATE.states?'block':'none';
}
const _bStates=$('#tStates');
if(_bStates)_bStates.onclick=()=>{STATE.states=!STATE.states;_bStates.textContent=STATE.states?'On':'Off';_bStates.classList.toggle('on',STATE.states);$('#states').style.display=STATE.states?'block':'none';};
function updatePoseRow(){const r=$('#poserow');if(r)r.style.display=(STATE.cat==='posable')?'':'none';}
function setCatUI(){const isA=STATE.cat==='audio',isT=STATE.cat==='textures';
  const ap=$('#audioplayer'),ar=$('#audiorow'); if(ap)ap.style.display=isA?'flex':'none'; if(ar)ar.style.display=isA?'flex':'none';
  const tgal=$('#texgallery'); if(tgal)tgal.style.display=isT?'flex':'none';
  const sb=$('#search'); if(sb)sb.placeholder=isT?'filter by id (0x…) or format…':'filter…';
  updatePoseRow();
  if(isA||isT){const tg=$('.tgrow');if(tg)tg.style.display='none';if(isT){stopSample();}} else {const tg=$('.tgrow');if(tg)tg.style.display='';stopSample();stopTexAnim();}
}
function buildTabs(){const t=$('#tabs');t.innerHTML='';CATS.forEach(c=>{const b=document.createElement('div');b.className='tab'+(c.id===STATE.cat?' on':'');
  const cnt=c.id==='audio'?(AUDIO?AUDIO.samples.length:0):(c.id==='textures'?DATA.textures.length:(DATA[c.id]||[]).length);
  b.innerHTML=`${c.label} <span class="c">${cnt}</span>`;b.onclick=()=>{STATE.cat=c.id;setCatUI();buildTabs();buildList();
    if(c.id==='textures'){$('#texinspect').style.display='none';buildGallery();return;}
    const l=curList();if(l.length){if(c.id==='audio')selectAudio(l[0].i,false);else selectModel(c.id,l[0].i);}};t.appendChild(b);});}
function buildList(){const L=$('#list');L.innerHTML='';
  if(STATE.cat==='textures'){buildTexRail();return;}
  const isA=STATE.cat==='audio';curList().forEach(({m,i})=>{const b=document.createElement('button');b.className='item'+(isA&&i===STATE.idx?' on':'');b.dataset.cat=STATE.cat;b.dataset.i=i;
  if(isA){b.innerHTML=`<span class="sw ${m.r===0?'a-sfx':'a-ins'}"></span><span class="nm">${m.name}</span><span class="tc">${m.s.toFixed(2)}s</span>`;b.onclick=()=>selectModel('audio',i);}
  else{b.innerHTML=`<span class="sw"></span><span class="nm">${m.name}</span><span class="tc">${fmt(m.ntri)}▲</span>`;b.onclick=()=>selectModel(STATE.cat,i);if(i===STATE.idx)b.classList.add('on');}
  L.appendChild(b);});}
$('#search').addEventListener('input',()=>{if(STATE.cat==='textures')buildGallery();else buildList();});
{const z=$('#tgZoom');if(z){z.value=STATE.texZoom;z.oninput=()=>{STATE.texZoom=+z.value;const g=$('#tgGrid');if(g)g.style.setProperty('--cell',STATE.texZoom+'px');};}}
// pager wiring
{const bind=(id,fn)=>{const b=$(id);if(b)b.onclick=fn;};
 bind('#tgFirst',()=>texGoto(0)); bind('#tgPrev',()=>texGoto(STATE.texPage-1));
 bind('#tgNext',()=>texGoto(STATE.texPage+1)); bind('#tgLast',()=>texGoto(texPageCount()-1));}

/* ================= AUDIO: live VADPCM decode + Web Audio playback ================= */
let ACTX=null, curSrc=null, curGain=null, ABYTES=null, curPCM=null, playStart=0, playDur=0, seekRAF=0;
function audioBytes(){ if(!ABYTES&&AUDIO.blob instanceof Uint8Array){ABYTES=AUDIO.blob;AUDIO.blob=null;} if(!ABYTES){const bin=atob(AUDIO.blob);ABYTES=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)ABYTES[i]=bin.charCodeAt(i);AUDIO.blob=null;} return ABYTES; }
// Verified N64 ALADPCM: history term + in-block residual feed-forward, floor-divide by 2048, clamp s16.
// (uses Math.floor(x/2048) not >>11 — JS bit-ops are 32-bit and would overflow the accumulator.)
function decodeSample(i){
  const s=AUDIO.samples[i], data=audioBytes().subarray(s.o,s.o+s.l), bk=AUDIO.books[s.b];
  const order=bk[0], npred=bk[1], coefs=bk[2], nf=(data.length/9)|0, out=new Int16Array(nf*16);
  const hist=new Int32Array(order); const ix=new Int32Array(16); let no=0;
  for(let f=0;f<nf;f++){ const p=f*9, hdr=data[p], shift=(hdr>>4)&0xF; let pred=hdr&0xF; if(pred>=npred)pred=npred-1;
    const scale=1<<shift;
    for(let b=0;b<8;b++){ let hi=data[p+1+b]>>4, lo=data[p+1+b]&0xF; if(hi&8)hi-=16; if(lo&8)lo-=16; ix[b*2]=hi*scale; ix[b*2+1]=lo*scale; }
    const bb=pred*order*8;
    for(let sv=0;sv<2;sv++){ const co=sv*8;
      for(let k=0;k<8;k++){ let d=0;
        for(let o=0;o<order;o++) d+=coefs[bb+o*8+k]*hist[o];
        for(let m=0;m<k;m++) d+=ix[co+m]*coefs[bb+(order-1)*8+(k-1-m)];
        let v=Math.floor((ix[co+k]*2048+d)/2048); if(v>32767)v=32767; else if(v<-32768)v=-32768;
        out[no+k]=v; }
      no+=8; for(let o=0;o<order;o++) hist[o]=out[no-order+o];
    }
  }
  return out;
}
function stopSample(){ if(curSrc){try{curSrc.onended=null;curSrc.stop();}catch(e){}curSrc=null;} if(seekRAF)cancelAnimationFrame(seekRAF),seekRAF=0; const f=$('#apFill');if(f)f.style.width='0'; const p=$('#apPlay');if(p)p.textContent='▶ Play'; }
function playSample(i){
  stopSample();
  if(!ACTX)ACTX=new (window.AudioContext||window.webkitAudioContext)();
  if(ACTX.state==='suspended')ACTX.resume();
  const pcm=(i===STATE.idx&&curPCM)?curPCM:decodeSample(i); curPCM=pcm;
  const buf=ACTX.createBuffer(1,Math.max(1,pcm.length),AUDIO.rate), ch=buf.getChannelData(0);
  for(let k=0;k<pcm.length;k++)ch[k]=pcm[k]/32768;
  const src=ACTX.createBufferSource(); src.buffer=buf; src.loop=STATE.audioLoop;
  const g=ACTX.createGain(); g.gain.value=STATE.audioVol; src.connect(g); g.connect(ACTX.destination);
  src.start(); curSrc=src; curGain=g; playStart=ACTX.currentTime; playDur=pcm.length/AUDIO.rate;
  $('#apPlay').textContent='❚❚ Pause';
  src.onended=()=>{ if(curSrc!==src)return; curSrc=null; $('#apPlay').textContent='▶ Play'; $('#apFill').style.width='0';
    if(STATE.audioAuto&&!STATE.audioLoop){const l=curList(),pos=l.findIndex(o=>o.i===STATE.idx);if(pos>=0&&pos+1<l.length)selectAudio(l[pos+1].i);} };
  const tick=()=>{ if(curSrc!==src)return; const t=(ACTX.currentTime-playStart); const frac=STATE.audioLoop?((t/playDur)%1):Math.min(1,t/playDur); $('#apFill').style.width=(frac*100)+'%'; seekRAF=requestAnimationFrame(tick); };
  seekRAF=requestAnimationFrame(tick);
}
function drawWave(i){
  const cv=$('#apWave'); if(!cv)return; const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=cv.clientWidth||520, h=cv.clientHeight||120; cv.width=w*dpr; cv.height=h*dpr;
  const g=cv.getContext('2d'); g.scale(dpr,dpr); g.clearRect(0,0,w,h);
  const pcm=curPCM||decodeSample(i); curPCM=pcm; const N=pcm.length||1, step=Math.max(1,Math.floor(N/w));
  const mid=h/2, acc=cssvar('--accent')||'#e0873c';
  g.strokeStyle=cssvar('--line-soft')||'#1e232e'; g.beginPath(); g.moveTo(0,mid); g.lineTo(w,mid); g.stroke();
  g.strokeStyle=acc; g.lineWidth=1; g.beginPath();
  for(let x=0;x<w;x++){ let mn=32767,mx=-32768; const s0=x*step; for(let k=0;k<step;k++){const v=pcm[s0+k]||0;if(v<mn)mn=v;if(v>mx)mx=v;}
    g.moveTo(x+.5,mid-(mx/32768)*mid*.94); g.lineTo(x+.5,mid-(mn/32768)*mid*.94); }
  g.stroke();
}
function selectAudio(i,play=true){
  STATE.cat='audio'; STATE.idx=i; curPCM=null;
  document.querySelectorAll('#list .item').forEach(el=>el.classList.toggle('on',+el.dataset.i===i&&el.dataset.cat==='audio'));
  const s=AUDIO.samples[i];
  $('#apReg').textContent=(s.r===0?'SFX / VOICE':'INSTRUMENT')+' · #'+i;
  $('#apName').textContent=s.name;
  $('#apMeta').textContent=`${s.s.toFixed(2)} s · ${AUDIO.rate} Hz · ADPCM ${s.l} B · book #${s.b}`;
  $('#bName').textContent=s.name;
  $('#sSrc').textContent='assets17 · VADPCM'; $('#sTris').textContent='—';
  $('#sTex').textContent=(s.r===0?'sfx/voice':'instrument'); $('#sKind').textContent='audio sample';
  $('#foot-note').textContent='decoded live from the cartridge audio bank';
  drawWave(i); if(play)playSample(i); else stopSample();
}
// player + region controls
function aReg(v){STATE.audioReg=v; ['aAll','aSfx','aIns'].forEach((id,k)=>$('#'+id).classList.toggle('on',(v===null&&k===0)||(v===0&&k===1)||(v===1&&k===2))); buildList(); const l=curList(); if(l.length)selectAudio(l[0].i,false);}
function bindAudioUI(){
  if(!AUDIO)return;
  $('#aAll').onclick=()=>aReg(null); $('#aSfx').onclick=()=>aReg(0); $('#aIns').onclick=()=>aReg(1);
  $('#aAuto').onclick=()=>{STATE.audioAuto=!STATE.audioAuto;$('#aAuto').classList.toggle('on',STATE.audioAuto);$('#aAuto').textContent=STATE.audioAuto?'On':'Off';};
  $('#apPlay').onclick=()=>{ if(curSrc){ if(ACTX.state==='running'){ACTX.suspend();$('#apPlay').textContent='▶ Play';} else {ACTX.resume();$('#apPlay').textContent='❚❚ Pause';} } else playSample(STATE.idx); };
  $('#apStop').onclick=stopSample;
  $('#apPrev').onclick=()=>{const l=curList(),p=l.findIndex(o=>o.i===STATE.idx);if(p>0)selectAudio(l[p-1].i);};
  $('#apNext').onclick=()=>{const l=curList(),p=l.findIndex(o=>o.i===STATE.idx);if(p>=0&&p+1<l.length)selectAudio(l[p+1].i);};
  $('#apLoop').onchange=e=>{STATE.audioLoop=e.target.checked; if(curSrc)curSrc.loop=STATE.audioLoop;};
  $('#apVol').oninput=e=>{STATE.audioVol=+e.target.value; if(curGain)curGain.gain.value=STATE.audioVol;};
  $('#apDl').onclick=()=>downloadWav(STATE.idx);
}
function downloadWav(i){
  const pcm=curPCM||decodeSample(i), rate=AUDIO.rate, n=pcm.length, buf=new ArrayBuffer(44+n*2), dv=new DataView(buf);
  const ws=(o,s)=>{for(let k=0;k<s.length;k++)dv.setUint8(o+k,s.charCodeAt(k));};
  ws(0,'RIFF');dv.setUint32(4,36+n*2,true);ws(8,'WAVE');ws(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);
  dv.setUint32(24,rate,true);dv.setUint32(28,rate*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);ws(36,'data');dv.setUint32(40,n*2,true);
  for(let k=0;k<n;k++)dv.setInt16(44+k*2,pcm[k],true);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([buf],{type:'audio/wav'}));a.download=AUDIO.samples[i].name+'.wav';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
bindAudioUI();

function tog(id,key,on,off){const b=$('#'+id);b.onclick=()=>{STATE[key]=!STATE[key];b.classList.toggle('on',STATE[key]);b.textContent=STATE[key]?on:off;};}
tog('tShade','shade','On','Off');tog('tWire','wire','On','Off');tog('tSpin','spin','On','Off');tog('tSky','sky','On','Off');tog('tTrig','triggers','Shown','Hidden');
const CMODE=['Textured','Vertex','Plain'];const bColor=$('#tColor');
bColor.onclick=()=>{STATE.cmode=(STATE.cmode+1)%3;bColor.textContent=CMODE[STATE.cmode];bColor.classList.toggle('on',STATE.cmode===0);};
// interaction
let dragging=false,pmode='orbit',lx=0,ly=0;
cvs.addEventListener('pointerdown',e=>{dragging=true;pmode=(e.button===2||e.button===1||e.shiftKey)?'pan':'orbit';lx=e.clientX;ly=e.clientY;cvs.setPointerCapture(e.pointerId);e.preventDefault();});
cvs.addEventListener('contextmenu',e=>e.preventDefault());
cvs.addEventListener('pointermove',e=>{if(!dragging)return;const dx=e.clientX-lx,dy=e.clientY-ly;lx=e.clientX;ly=e.clientY;
  if(pmode==='orbit'){STATE.yaw-=dx*0.008;STATE.pitch+=dy*0.008;STATE.pitch=Math.max(-1.54,Math.min(1.54,STATE.pitch));}else{const{s,u}=camBasis();const k=STATE.dist*0.0018;STATE.target=V3.add(STATE.target,V3.add(V3.scale(s,-dx*k),V3.scale(u,dy*k)));}});
addEventListener('pointerup',()=>{dragging=false;});
cvs.addEventListener('wheel',e=>{e.preventDefault();STATE.dist*=Math.exp(Math.sign(e.deltaY)*0.12);STATE.dist=Math.max(0.02,Math.min(80,STATE.dist));},{passive:false});
cvs.addEventListener('dblclick',resetCam);
// ---- surface / texture inspector (GPU colour-picking) ----
STATE.inspect=true;   // inspect ON by default
let pickFB=null,pickTex=null,pickRB=null,pickW=0,pickH=0;
function currentMVP(){const asp=cvs.width/cvs.height,near=Math.max(0.004,STATE.dist*0.006),far=STATE.dist*8+60;
  const P=M4.persp(0.92,asp,near,far),{e}=camBasis(),Vv=M4.lookAt(e,STATE.target,[0,1,0]);return M4.mul(P,Vv);}
function ensurePick(w,h){
  if(!pickFB){pickFB=gl.createFramebuffer();pickTex=gl.createTexture();pickRB=gl.createRenderbuffer();}
  if(w!==pickW||h!==pickH){
    gl.bindTexture(gl.TEXTURE_2D,pickTex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.bindRenderbuffer(gl.RENDERBUFFER,pickRB);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,w,h);pickW=w;pickH=h;}
  gl.bindFramebuffer(gl.FRAMEBUFFER,pickFB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,pickTex,0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,pickRB);
}
// Flat list of every clickable group THIS FRAME: pose groups, or terrain _buf + each visible instanced
// prop group (with its own MVP). pickAt and showInspect index the SAME list so a picked id maps back
// correctly — this is what lets you inspect PROPS (dino jaw, dock), which used to be unpickable.
let _pickGroups=[];
function buildPickList(){
  _pickGroups=[];
  if(mesh._pose){ for(const g of mesh._pose.groups){if(g.variant!=null&&g.variant!==STATE.shirt)continue; _pickGroups.push({g,pose:true,mvp:null,prop:null});} return; }
  const base=currentMVP();
  if(mesh._buf){ for(const g of mesh._buf){if(g.trig&&!STATE.triggers)continue;_pickGroups.push({g,pose:false,mvp:base,prop:null});} }
  if(mesh._ppbuf&&mesh._props){ try{
    for(const pr of mesh._props){ if(!pr.vis)continue; const part=mesh._ppbuf[pr.pp]; if(!part)continue;
      const M=M4.mul(base,propModelMat(pr,mesh));
      for(const g of part){if(g.trig&&!STATE.triggers)continue;_pickGroups.push({g,pose:false,mvp:M,prop:pr});} }
  }catch(e){} }
}
function pickAt(cssX,cssY){
  if(!mesh)return -1;
  const dpr=Math.min(window.devicePixelRatio||1,2),w=cvs.width,h=cvs.height;ensurePick(w,h);
  gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.depthMask(true);gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.uniform1f(uMode,3.0);gl.uniform1f(uAlphaMode,0.0);
  buildPickList();
  for(let i=0;i<_pickGroups.length;i++){const e=_pickGroups[i],g=e.g,id=i+1;
    gl.uniformMatrix4fv(uMVP,false,new Float32Array(e.mvp||currentMVP()));
    gl.uniform3f(uFlatCol,(id&0xFF)/255,((id>>8)&0xFF)/255,((id>>16)&0xFF)/255);
    const pb=e.pose?g.posBuf:g.p,nb=e.pose?g.nrmBuf:g.nr,ub=e.pose?g.uvBuf:g.uv,cb=e.pose?g.colBuf:g.co,vb=e.pose?g.vaBuf:g.va,ib=e.pose?g.idxBuf:g.ix;
    bindA(aPos,pb,3);bindA(aNrm,nb,3);bindA(aUV,ub,2);bindA(aCol,cb,3);bindA(aVA,vb,1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.drawElements(gl.TRIANGLES,g.n,gl.UNSIGNED_SHORT,0);}
  const px=Math.round(cssX*dpr),py=Math.round(cssY*dpr),pix=new Uint8Array(4);
  gl.readPixels(Math.max(0,Math.min(w-1,px)),Math.max(0,Math.min(h-1,h-1-py)),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pix);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  return (pix[0]|(pix[1]<<8)|(pix[2]<<16))-1;
}
function fmtName(fmt,siz,flag){
  if(flag===0x400000||(fmt===2&&siz===1))return 'CI8 (256-colour)';
  if(flag===0x800000||(fmt===2&&siz===0))return 'CI4 (16-colour)';
  if(fmt===0&&siz===2)return 'RGBA16'; if(fmt===0&&siz===3)return 'RGBA32';
  if(fmt===3&&siz===2)return 'IA16'; if(fmt===3&&siz===1)return 'IA8'; if(fmt===3&&siz===0)return 'IA4';
  if(fmt===4&&siz===1)return 'I8'; if(fmt===4&&siz===0)return 'I4'; return 'fmt'+fmt+' siz'+siz;
}
/* ================= TEXTURE GALLERY ================= */
// short format tag for one texture index (from DATA.texmeta [texid,fmt,siz,flag,bytes])
function texFmt(i){const tm=DATA.texmeta[i]||[];const fmt=tm[1],siz=tm[2],flag=tm[3];
  if(flag===0x400000||(fmt===2&&siz===1))return 'CI8';
  if(flag===0x800000||(fmt===2&&siz===0))return 'CI4';
  if(fmt===0&&siz===2)return 'RGBA16'; if(fmt===0&&siz===3)return 'RGBA32';
  if(fmt===3&&siz===2)return 'IA16'; if(fmt===3&&siz===1)return 'IA8'; if(fmt===3&&siz===0)return 'IA4';
  if(fmt===4&&siz===1)return 'I8'; if(fmt===4&&siz===0)return 'I4'; return '?';}
// texture-index -> the animation SET it belongs to (or null). Built once from ground-truth ANIMSETS.
const _ani4tex={};ANIMSETS.forEach((s,k)=>{(s.frames||[]).forEach(ti=>{if(_ani4tex[ti]===undefined)_ani4tex[ti]=k;});});
// filter categories, counted live from what's actually decoded
const TEX_FMT_ORDER=['CI8','CI4','RGBA16','RGBA32','IA16','IA8','IA4','I8','I4','?'];
function texCats(){
  const N=DATA.textures.length, fc={}; let nAnim=0,nAlpha=0;
  for(let i=0;i<N;i++){const f=texFmt(i);fc[f]=(fc[f]||0)+1;if(_ani4tex[i]!==undefined)nAnim++;if(DATA.textures[i].a)nAlpha++;}
  const cats=[{key:'all',label:'All textures',n:N}];
  if(ANIMSETS.length)cats.push({key:'anim',label:'Animated',n:nAnim});
  if(nAlpha)cats.push({key:'alpha',label:'Has alpha',n:nAlpha});
  for(const f of TEX_FMT_ORDER)if(fc[f])cats.push({key:'fmt:'+f,label:f,n:fc[f]});
  return cats;
}
function texInCat(i,key){
  if(key==='all')return true;
  if(key==='anim')return _ani4tex[i]!==undefined;
  if(key==='alpha')return !!DATA.textures[i].a;
  if(key.startsWith('fmt:'))return texFmt(i)===key.slice(4);
  return true;
}
function texSearchMatch(i,q){
  if(!q)return true;
  const tm=DATA.texmeta[i]||[]; const id=(tm[0]||0);
  const hx=id.toString(16); q=q.replace(/^0x/,'');
  return hx.includes(q)||(''+id).includes(q)||texFmt(i).toLowerCase().includes(q);
}
function buildTexRail(){
  const L=$('#list');L.innerHTML='';
  texCats().forEach(c=>{const b=document.createElement('button');
    b.className='item'+(c.key===STATE.texFilter?' on':'');b.dataset.texcat=c.key;
    b.innerHTML=`<span class="sw"></span><span class="nm">${c.label}</span><span class="tc">${fmt(c.n)}</span>`;
    b.onclick=()=>{STATE.texFilter=c.key;STATE.texSel=-1;buildTexRail();buildGallery();$('#texinspect').style.display='none';stopTexAnim();};
    L.appendChild(b);});
}
// PAGINATION: rendering all ~3200 cells at once is too heavy (and the lazy-load observer proved unreliable in
// the webview) -> show one PAGE of TEX_PAGE thumbnails, loaded directly (a page of ~150 base64 PNGs is instant).
const TEX_PAGE=150;
let _texIdxs=[];   // current filtered+sorted texture indices (recomputed on filter/search change)
function texApplyFilter(){
  const q=($('#search').value||'').toLowerCase().trim();
  _texIdxs=[];for(let i=0;i<DATA.textures.length;i++)if(texInCat(i,STATE.texFilter)&&texSearchMatch(i,q))_texIdxs.push(i);
  _texIdxs.sort((a,b)=>((DATA.texmeta[a]||[])[0]||0)-((DATA.texmeta[b]||[])[0]||0));
  STATE.texPage=0;
}
function texPageCount(){return Math.max(1,Math.ceil(_texIdxs.length/TEX_PAGE));}
function renderTexPage(){
  const grid=$('#tgGrid');if(!grid)return;
  grid.style.setProperty('--cell',STATE.texZoom+'px');
  const np=texPageCount(); if(STATE.texPage>=np)STATE.texPage=np-1; if(STATE.texPage<0)STATE.texPage=0;
  const start=STATE.texPage*TEX_PAGE, end=Math.min(_texIdxs.length,start+TEX_PAGE);
  // header + pager labels
  $('#tgCount').textContent=fmt(_texIdxs.length);
  const cat=texCats().find(c=>c.key===STATE.texFilter);
  $('#tgFilterName').textContent=cat&&cat.key!=='all'?('· '+cat.label):'';
  $('#tgPageLbl').textContent=(np>1?(start+1)+'–'+end+' · ':'')+ (STATE.texPage+1)+' / '+np;
  $('#tgFirst').disabled=$('#tgPrev').disabled=(STATE.texPage<=0);
  $('#tgLast').disabled=$('#tgNext').disabled=(STATE.texPage>=np-1);
  $('#tgPager').style.visibility=np>1?'visible':'hidden';
  $('#bName').textContent='Texture Atlas';$('#sSrc').textContent='texture pool';
  $('#sTris').textContent=fmt(DATA.textures.length);$('#sTex').textContent=fmt(_texIdxs.length)+' shown';$('#sKind').textContent='textures';
  $('#foot-note').textContent='every texture decoded from the cartridge pool · click to inspect';
  grid.innerHTML='';
  if(!_texIdxs.length){grid.innerHTML='<div class="tg-empty">no textures match this filter / search</div>';return;}
  const frag=document.createDocumentFragment();
  for(let k=start;k<end;k++){
    const i=_texIdxs[k],t=DATA.textures[i],tm=DATA.texmeta[i]||[];
    const cell=document.createElement('div');cell.className='tg-cell checker'+(i===STATE.texSel?' on':'');cell.dataset.i=i;
    const badges=(_ani4tex[i]!==undefined?'<span class="anibadge">ANIM</span>':'')+(t.a?'<span class="albadge">α</span>':'');
    cell.innerHTML=`<div class="thumb"><img alt="" src="${texURL(i)}"></div>`+
      `<div class="cap"><span>0x${(tm[0]||0).toString(16)}</span><span class="fm">${texFmt(i)} ${t.w}×${t.h}</span></div>`+badges;
    cell.onclick=()=>{STATE.texSel=i;grid.querySelectorAll('.tg-cell.on').forEach(c=>c.classList.remove('on'));cell.classList.add('on');showTexInspect(i);};
    frag.appendChild(cell);
  }
  grid.appendChild(frag); grid.scrollTop=0;
}
function texGoto(p){const np=texPageCount();STATE.texPage=Math.max(0,Math.min(np-1,p));renderTexPage();}
// full rebuild (filter changed) -> recompute list + render page 0
function buildGallery(){texApplyFilter();renderTexPage();}
let _texAniTimer=0,_texAniFrame=0;
function stopTexAnim(){if(_texAniTimer){clearInterval(_texAniTimer);_texAniTimer=0;}}
function showTexInspect(i){
  stopTexAnim();
  const panel=$('#texinspect');const t=DATA.textures[i],tm=DATA.texmeta[i]||[];
  const R=(k,v)=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';
  const bytes=tm[4]||0;
  let html='<div class="hd"><span>TEXTURE 0x'+(tm[0]||0).toString(16)+'</span><span class="close" id="txClose">×</span></div>';
  html+='<div class="big checker"><img src="'+texURL(i)+'" id="txBig"></div>';
  html+=R('texture id','0x'+(tm[0]||0).toString(16)+' ('+(tm[0]||0)+')');
  html+=R('dimensions',t.w+' × '+t.h);
  html+=R('format',fmtName(tm[1],tm[2],tm[3]));
  html+=R('tile fmt/siz','fmt '+tm[1]+' · siz '+tm[2]);
  html+=R('alpha',t.a?'yes (per-texel)':'opaque');
  html+=R('asset bytes',fmt(bytes)+' B');
  // animation set membership
  const ak=_ani4tex[i];
  if(ak!==undefined){const s=ANIMSETS[ak];const frames=s.frames||[];
    html+='<div class="aniwrap"><div class="anihd"><span>ANIMATION · '+frames.length+' frames'+(s.hold?(' · hold '+s.hold):'')+'</span><button id="txPlay">▶ play</button></div><div class="strip" id="txStrip"></div></div>';}
  panel.innerHTML=html;panel.style.display='block';
  $('#txClose').onclick=()=>{panel.style.display='none';stopTexAnim();STATE.texSel=-1;$('#tgGrid').querySelectorAll('.tg-cell.on').forEach(c=>c.classList.remove('on'));};
  if(ak!==undefined){
    const s=ANIMSETS[ak],frames=s.frames||[],strip=$('#txStrip'),big=$('#txBig');
    frames.forEach((fi,k)=>{const fr=document.createElement('div');fr.className='fr'+(fi===i?' on':'');
      if(DATA.textures[fi])fr.innerHTML='<img src="'+texURL(fi)+'">';
      fr.title='0x'+((DATA.texmeta[fi]||[])[0]||0).toString(16);
      fr.onclick=()=>{stopTexAnim();$('#txPlay').classList.remove('on');$('#txPlay').textContent='▶ play';big.src=DATA.textures[fi]?texURL(fi):big.src;strip.querySelectorAll('.fr.on').forEach(x=>x.classList.remove('on'));fr.classList.add('on');};
      strip.appendChild(fr);});
    const hold=Math.max(1,s.hold||3),ms=hold*(1000/30);   // hold is in 30fps game-frames
    $('#txPlay').onclick=()=>{const b=$('#txPlay');if(_texAniTimer){stopTexAnim();b.classList.remove('on');b.textContent='▶ play';return;}
      b.classList.add('on');b.textContent='❚❚ stop';_texAniFrame=Math.max(0,frames.findIndex(f=>f===i));
      _texAniTimer=setInterval(()=>{_texAniFrame=(_texAniFrame+1)%frames.length;const fi=frames[_texAniFrame];
        if(DATA.textures[fi])big.src=texURL(fi);
        strip.querySelectorAll('.fr').forEach((x,k)=>x.classList.toggle('on',k===_texAniFrame));},ms);};
  }
}
function showInspect(gi){
  const panel=$('#inspect');
  if(gi<0||gi>=_pickGroups.length){panel.style.display='none';return;}
  const ent=_pickGroups[gi],g=ent.g,ti=g.ti;
  const R=(k,v)=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';
  const wrap=x=>x===2?'clamp':(x===1?'mirror':'repeat');
  let img='',rows='';
  if(ti>=0&&DATA.textures[ti]){
    img='<img src="'+texURL(ti)+'">';
    const tm=(DATA.texmeta&&DATA.texmeta[ti])||[];
    rows+=R('texture id','0x'+(tm[0]||0).toString(16));
    rows+=R('size',DATA.textures[ti].w+'×'+DATA.textures[ti].h);
    rows+=R('format',fmtName(tm[1],tm[2],tm[3]));
    rows+=R('asset bytes',(tm[4]||'?'));
  } else rows+=R('texture','none (flat colour)');
  const fl=[];
  if(g.rt)fl.push('runtime-bound'); if(g.anim&&g.anim.length)fl.push('animated·'+g.anim.length+'fr');
  if(g.bl)fl.push('translucent'); if(g.al)fl.push('has-alpha'); if(g.dec)fl.push('decal'); if(g.mod)fl.push('shade-mod');
  rows+=R('wrap S/T',wrap(g.ws)+' / '+wrap(g.wt));
  rows+=R('flags',fl.length?fl.join(', '):'—');
  rows+=R('triangles',(g.n/3)|0);
  if(ent.prop){const pr=ent.prop; rows+=R('placed object',(pr.ext?'external · assets03['+pr.id+']':'part '+pr.id)+(pr.st?(' · state '+pr.st):''));}
  let warn='';
  if(ti<0&&g.rt)warn='<div class="warn">Runtime-bound: the game binds this texture from code at spawn — it is NOT in the static level data, so it renders as flat colour. Crowd / light-shafts / glass are this type.</div>';
  else if(ti<0)warn='<div class="warn">Untextured: this surface uses only vertex colour (no texture in the display list).</div>';
  panel.innerHTML='<div class="close" id="inspClose">×</div><div class="hd">SURFACE · TEXTURE</div>'+img+rows+warn;
  panel.style.display='block';
  $('#inspClose').onclick=()=>{panel.style.display='none';};
}
const bInspect=$('#tInspect');
if(bInspect)bInspect.onclick=()=>{STATE.inspect=!STATE.inspect;bInspect.textContent=STATE.inspect?'On':'Off';
  bInspect.classList.toggle('on',STATE.inspect);$('#inspecthint').style.display=STATE.inspect?'block':'none';
  if(!STATE.inspect)$('#inspect').style.display='none';};
if(bInspect){bInspect.textContent=STATE.inspect?'On':'Off';bInspect.classList.toggle('on',STATE.inspect);}   // reflect default-on
if($('#inspecthint'))$('#inspecthint').style.display=STATE.inspect?'block':'none';
let downPX=0,downPY=0;
cvs.addEventListener('pointerdown',e=>{downPX=e.clientX;downPY=e.clientY;},true);
cvs.addEventListener('pointerup',e=>{
  if(!STATE.inspect)return;
  const dx=e.clientX-downPX,dy=e.clientY-downPY;
  if(dx*dx+dy*dy<25){const r=cvs.getBoundingClientRect();showInspect(pickAt(e.clientX-r.left,e.clientY-r.top));}
});
addEventListener('keydown',e=>{if(document.activeElement===$('#search'))return;const k=e.key.toLowerCase();if('wasdqez'.includes(k)||k===' '){keys[k]=true;if(PLAYER.on||('wasdqe'.includes(k)))e.preventDefault();}});   // z = the Z button (ready stance / high-jump), tracked only for play mode
// PLAY MODE keys: 'p' spawn/despawn Conker at the current look-point; '[' / ']' tune his world scale.
addEventListener('keydown',e=>{if(document.activeElement===$('#search'))return;const k=e.key.toLowerCase();
  if(k==='p'){ if(!PLAYER.on){ const m=ensurePlayer(); if(m){PLAYER.pos=STATE.target.slice();PLAYER.yaw=STATE.yaw||0;PLAYER.size=1.0;PLAYER.vel=[0,0];PLAYER.speed=0;PLAYER.angVel=0;PLAYER.spdAcc=0;PLAYER.yVel=0;PLAYER.onGround=false;PLAYER.jHeld=false;PLAYER.airTime=0;PLAYER.jumped=false;PLAYER.zJump=false;PLAYER.takeoff=0;PLAYER.postHeli=false;PLAYER.launchYVel=0;PLAYER.tail=tailInit();PLAYER.eye={tgl:0,lid:0,timer:30,acc:0};PLAYER.landTimer=0;PLAYER.hover={active:false,used:false,timer:0};PLAYER.lean={pitch:0,roll:0,prevYaw:PLAYER.yaw,yVel:0,coef:(PLAYER.lean?PLAYER.lean.coef:1.3)};PLAYER.fidget={seq:-1,pos:0,timer:fidgetDelay(0),phase:0,recent:[]};PLAYER.anim={cur:(PLAYER.idleClip!=null?PLAYER.idleClip:null),curT:0,prev:null,prevT:0,blend:0,blendDur:1};PLAYER.on=true;snapPlayerToGround();} } else PLAYER.on=false; updatePlayerHUD(); e.preventDefault(); }
  else if(k===']'){ PLAYER.size=Math.min(50,PLAYER.size*1.25); updatePlayerHUD(); e.preventDefault(); }
  else if(k==='['){ PLAYER.size=Math.max(0.05,PLAYER.size*0.8); updatePlayerHUD(); e.preventDefault(); }
  else if(k===','){ PLAYER.spd=Math.max(0.01,PLAYER.spd*0.85); updatePlayerHUD(); e.preventDefault(); }
  else if(k==='.'){ PLAYER.spd=Math.min(10,PLAYER.spd*1.25); updatePlayerHUD(); e.preventDefault(); }
  else if(k==='-'||k==='_'){ PLAYER.animRate=Math.max(0.25,PLAYER.animRate*0.85); updatePlayerHUD(); e.preventDefault(); }   // animation cadence down
  else if(k==='='||k==='+'){ PLAYER.animRate=Math.min(6,PLAYER.animRate*1.18); updatePlayerHUD(); e.preventDefault(); }      // animation cadence up
  else if(k===';'){ if(PLAYER.lean)PLAYER.lean.coef=Math.max(0,PLAYER.lean.coef-0.15); updatePlayerHUD(); e.preventDefault(); }   // reactive-lean intensity down (calibrate unk1E5 divisor)
  else if(k==='\''){ if(PLAYER.lean)PLAYER.lean.coef=Math.min(6,PLAYER.lean.coef+0.15); updatePlayerHUD(); e.preventDefault(); } // reactive-lean intensity up
  else if(k==='c'&&PLAYER.on){ STATE.collide=!STATE.collide; if(STATE.collide)snapPlayerToGround(); updatePlayerHUD(); e.preventDefault(); }  // toggle terrain collision (ground+gravity)
  else if(k==='v'&&PLAYER.on){ STATE.walls=!STATE.walls; updatePlayerHUD(); e.preventDefault(); }        // toggle wall collision (experimental)
  else if(k==='t'&&PLAYER.on){ TAIL.enabled=!TAIL.enabled; if(PLAYER.tail)PLAYER.tail.seeded=false; updatePlayerHUD(); e.preventDefault(); }  // toggle the ROM tail dangly-chain write-back (compare vs clip pose)
  else if(k==='k'&&PLAYER.on){ PHYS.JUMP_SCALE=Math.max(0.1,PHYS.JUMP_SCALE*0.85); updatePlayerHUD(); e.preventDefault(); }  // jump height down
  else if(k==='l'&&PLAYER.on){ PHYS.JUMP_SCALE=Math.min(8,PHYS.JUMP_SCALE*1.18); updatePlayerHUD(); e.preventDefault(); }     // jump height up
  else if(k==='f'&&PLAYER.on){ PLAYER.faceOff=PLAYER.faceOff?0:Math.PI; e.preventDefault(); }
  else if(k==='o'&&PLAYER.on){   // TEST: force-play the next PROP-holding fidget (cycles the 8 prop sequences)
    const props=[]; for(let i=0;i<FIDGET_ATTACH.length;i++)if(FIDGET_ATTACH[i])props.push(i);
    if(props.length){ PLAYER._pt=((PLAYER._pt==null?-1:PLAYER._pt)+1)%props.length; const si=props[PLAYER._pt], fa=FIDGET_ATTACH[si];
      PLAYER.fidget.seq=si; PLAYER.fidget.pos=0; PLAYER.vel=[0,0]; PLAYER.speed=0;
      try{console.log('[prop test] seq '+si+' objId '+fa.o+' @bone '+fa.b);}catch(_){} updatePlayerHUD(); }
    e.preventDefault(); }
});
addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;});addEventListener('blur',()=>{for(const k in keys)keys[k]=false;});
new MutationObserver(readTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',readTheme);
// boot
readTheme();
if(!(DATA[STATE.cat]||[]).length){for(const c of CATS){if((DATA[c.id]||[]).length){STATE.cat=c.id;break;}}}
const ok=initGL();buildTabs();buildList();
if(ok){
  GTEX=new Array(DATA.textures.length).fill(WHITE);
  const f=curList();if(f.length)selectModel(STATE.cat,f[0].i);
  render();
  loadTextures(()=>{$('#loading').style.display='none';});
}
