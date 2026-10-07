"""Everything the extractor needs, read straight from a user-supplied Conker's Bad Fur Day (US) ROM.

No decomp checkout required. Sources (all verified against the decomp's split/build outputs):
  * asset groups 00..1F  : root table @ 0xAB1950 = {u32 off (from table), u32 len} per group
  * texture pool         : rzip files from 0x1A37E0, positioned by the u16 stride table D_80091D20
                           in .data (func_15003570 does the same walk at boot); texid == pool index
  * game .data section   : rzip @ 0x42450+0x145ED8 (VRAM 0x80082B20), 189088 bytes
rzip = u32 big-endian uncompressed length + raw deflate stream.
"""
import os, struct, zlib, hashlib

US_SHA1 = "4cbadd3c4e0729dec46af64ad018050eada4f47a"
ASSETS_TABLE = 0xAB1950
TEXPOOL = 0x1A37E0
DATA_ROM = 0x42450 + 0x145ED8
DATA_VRAM = 0x80082B20
POOL_STRIDES = 0x80091D20   # u16[7762] compressed size per pool entry
POOL_COUNT = 7762

def _find_rom():
    p = os.environ.get("CONKER_ROM") or "baserom.us.z64"
    if os.path.exists(p): return p
    raise SystemExit("set CONKER_ROM to your Conker's Bad Fur Day (US) ROM")

def normalize(b):
    """.z64 (big-endian) / .v64 (byte-swapped) / .n64 (little-endian) -> .z64 byte order."""
    b = bytearray(b); m = bytes(b[:4])
    if m == b"\x80\x37\x12\x40": return bytes(b)
    if m == b"\x37\x80\x40\x12": b[0::2], b[1::2] = b[1::2], b[0::2]; return bytes(b)
    if m == b"\x40\x12\x37\x80":
        a = bytearray(len(b)); a[0::4] = b[3::4]; a[1::4] = b[2::4]; a[2::4] = b[1::4]; a[3::4] = b[0::4]; return bytes(a)
    raise ValueError("not an N64 ROM")

ROM = normalize(open(_find_rom(), "rb").read())
if hashlib.sha1(ROM).hexdigest() != US_SHA1:
    raise SystemExit("ROM is not Conker's Bad Fur Day (US)")

def u32(d, o): return struct.unpack_from(">I", d, o)[0]
def runzip(d):
    try: return zlib.decompressobj(wbits=-15).decompress(d[4:])
    except Exception: return None

def group_bytes(idx):
    """Raw ROM slice of asset group idx (== decomp assets/rzip/assetsNN/assetsNN.bin)."""
    off = u32(ROM, ASSETS_TABLE + idx * 8); ln = u32(ROM, ASSETS_TABLE + idx * 8 + 4)
    return ROM[ASSETS_TABLE + off: ASSETS_TABLE + off + ln]

def subfiles(idx):
    """Decompressed files of a group, named exactly as splat's rzip split names them (0000, 0001, ...):
       walk the 8-byte {off, len|type<<24} dir, skip empty entries, stop at the first out-of-range one."""
    g = group_bytes(idx); gabs = ASSETS_TABLE + u32(ROM, ASSETS_TABLE + idx * 8)
    out = []; previous = 0; n = 0; k = 0
    while 8 + k * 8 <= len(g):
        start, comp = struct.unpack_from(">ii", g, k * 8); k += 1
        typ = comp >> 24; length = comp % 0x10000000
        if start >= len(g) or length > len(ROM) or start < previous: break
        if length == 0: continue
        previous = start
        end = start + length; pad = -(gabs + end) % 8          # splat pads each file to an 8-byte ROM boundary
        raw = g[start:end + pad]
        if typ & 16:
            try: res = zlib.decompressobj(wbits=-15).decompress(raw[4:])
            except Exception: res = None
        else:
            res = raw[:len(raw) - pad] if pad else raw
        if res: out.append(("%04d" % n, res))
        n += 1
    return out

_GD = None
def game_data():
    global _GD
    if _GD is None:
        _GD = zlib.decompressobj(wbits=-15).decompress(ROM[DATA_ROM + 4: DATA_ROM + 4 + 0x40000])
    return _GD

_POOL = None
def _pool():
    global _POOL
    if _POOL is None:
        gd = game_data(); t = POOL_STRIDES - DATA_VRAM; a = TEXPOOL; _POOL = []
        for i in range(POOL_COUNT):
            s = struct.unpack_from(">H", gd, t + 2 * i)[0]; _POOL.append((a, s)); a += s
    return _POOL

_CACHE = {}
def get_asset(texid):
    """Decompressed texture-pool entry `texid` (None if out of range / empty)."""
    if texid in _CACHE: return _CACHE[texid]
    P = _pool(); r = None
    if 0 <= texid < len(P) and P[texid][1]:
        a, s = P[texid]; r = runzip(ROM[a:a + s])
    _CACHE[texid] = r; return r
