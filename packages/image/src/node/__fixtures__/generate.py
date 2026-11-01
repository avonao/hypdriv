#!/usr/bin/env python3
"""Regenerates the binary fixtures and reference.json for the portable placeholder engine tests.

Needs Pillow (with WebP and AVIF support), numpy and ImageMagick's `convert`. Run from this directory:

    python3 generate.py

`reference.json` holds, for every fixture, the exact area-average downscale (premultiplied alpha) of the
picture as Pillow/libjpeg decode it, base64-encoded RGBA. The tests compare the TypeScript decoders to it.
"""
import base64
import json
import math
import os
import struct
import subprocess
import zlib

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)


def scene(w, h):
    """Smooth gradient with a few flat shapes: stresses chroma, edges and block means."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (
                int(255 * x / max(1, w - 1)),
                int(255 * y / max(1, h - 1)),
                int(128 + 100 * math.sin((x + y) / max(6, w / 5))),
            )
    d = ImageDraw.Draw(im)
    d.ellipse([w * 0.1, h * 0.15, w * 0.45, h * 0.7], fill=(250, 210, 20))
    d.rectangle([w * 0.55, h * 0.4, w * 0.9, h * 0.85], fill=(20, 60, 230))
    d.line([0, h - 1, w - 1, 0], fill=(255, 255, 255), width=max(1, w // 40))
    return im


def with_alpha(im):
    w, h = im.size
    a = Image.new("L", (w, h))
    pa = a.load()
    for y in range(h):
        for x in range(w):
            pa[x, y] = int(255 * (0.15 + 0.85 * x / max(1, w - 1)))
    out = im.convert("RGBA")
    out.putalpha(a)
    return out


# ---- JPEG -------------------------------------------------------------------------------------------------
big = scene(320, 200)
big.save("jpeg-444-baseline.jpg", quality=90, subsampling=0)
big.save("jpeg-420-baseline.jpg", quality=85, subsampling=2)
big.save("jpeg-422-baseline.jpg", quality=85, subsampling=1)
big.save("jpeg-420-progressive.jpg", quality=85, subsampling=2, progressive=True)
big.save("jpeg-444-progressive-optimized.jpg", quality=92, subsampling=0, progressive=True, optimize=True)
big.save("jpeg-420-restart.jpg", quality=85, subsampling=2, restart_marker_blocks=3)
subprocess.run(["convert", "jpeg-444-baseline.jpg", "-sampling-factor", "1x2", "-quality", "85", "jpeg-440-baseline.jpg"], check=True)
scene(40, 30).save("jpeg-444-progressive-small.jpg", quality=90, subsampling=0, progressive=True)
scene(37, 23).save("jpeg-420-small-odd.jpg", quality=88, subsampling=2)
scene(161, 99).save("jpeg-420-odd-large.jpg", quality=88, subsampling=2)
scene(160, 100).convert("L").save("jpeg-gray.jpg", quality=90)
scene(24, 16).convert("L").save("jpeg-gray-small.jpg", quality=90)
scene(160, 120).convert("CMYK").save("jpeg-cmyk.jpg", quality=92)
scene(64, 48).convert("CMYK").save("jpeg-cmyk-small.jpg", quality=92)
scene(1000, 80).save("jpeg-wide.jpg", quality=80, subsampling=2)  # 12.5:1, exercises non-square targets
scene(8, 8).save("jpeg-tiny.jpg", quality=95, subsampling=0)

# ---- PNG --------------------------------------------------------------------------------------------------
pic = scene(96, 60)
pic.save("png-rgb8.png")
with_alpha(pic).save("png-rgba8.png")
pic.convert("L").save("png-gray8.png")
pic.convert("LA").save("png-graya8.png")
p = pic.quantize(colors=12)
p.save("png-palette4.png", bits=4)
pal = pic.quantize(colors=200)
pal.info["transparency"] = bytes([255] * 100 + [0] * 50 + [128] * 50)
pal.save("png-palette8-trns.png", transparency=pal.info["transparency"])
pic.convert("L").point(lambda v: 255 if v > 127 else 0).convert("1").save("png-gray1.png")

# real 16-bit data (the low bytes differ from the high bytes), forced to 16 bits per sample
sixteen = ["-depth", "16", "-define", "png:bit-depth=16"]
subprocess.run(["convert", "-size", "96x60", "gradient:red-blue", *sixteen, "-define", "png:color-type=2", "png-rgb16.png"], check=True)
subprocess.run(["convert", "png-rgba8.png", *sixteen, "-define", "png:color-type=6", "png-rgba16.png"], check=True)
subprocess.run(["convert", "-size", "96x60", "gradient:", *sixteen, "-define", "png:color-type=0", "png-gray16.png"], check=True)
subprocess.run(["convert", "png-gray8.png", "-depth", "4", "png-gray4.png"], check=True)
subprocess.run(["convert", "png-gray8.png", "-depth", "2", "png-gray2.png"], check=True)
subprocess.run(["convert", "png-rgb8.png", "-interlace", "PNG", "png-rgb8-interlaced.png"], check=True)
subprocess.run(["convert", "png-rgba8.png", "-interlace", "PNG", "png-rgba8-interlaced.png"], check=True)
subprocess.run(["convert", "png-gray4.png", "-depth", "4", "-interlace", "PNG", "png-gray4-interlaced.png"], check=True)
subprocess.run(["convert", "png-rgb8.png", "-resize", "37x23!", "-interlace", "PNG", "png-rgb8-interlaced-odd.png"], check=True)
for n in range(5):
    subprocess.run(["convert", "png-rgb8.png", "-define", f"png:compression-filter={n}", f"png-rgb8-filter{n}.png"], check=True)


def png_chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png_rgb_colorkey(path, im, key):
    """8-bit RGB PNG with a tRNS colour key and cycling per-row filters (all five filter types)."""
    w, h = im.size
    px = im.load()
    rows = [bytes(c for x in range(w) for c in px[x, y]) for y in range(h)]
    bpp = 3
    out = bytearray()
    for y, row in enumerate(rows):
        f = y % 5
        prior = rows[y - 1] if y else bytes(len(row))
        filt = bytearray()
        for i, v in enumerate(row):
            a = row[i - bpp] if i >= bpp else 0
            b = prior[i]
            c = prior[i - bpp] if i >= bpp else 0
            if f == 0:
                pred = 0
            elif f == 1:
                pred = a
            elif f == 2:
                pred = b
            elif f == 3:
                pred = (a + b) // 2
            else:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            filt.append((v - pred) & 0xFF)
        out.append(f)
        out += filt
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr)
    data += png_chunk(b"tRNS", struct.pack(">HHH", *key))
    data += png_chunk(b"IDAT", zlib.compress(bytes(out), 9)) + png_chunk(b"IEND", b"")
    open(path, "wb").write(data)


keyed = pic.copy()
d = ImageDraw.Draw(keyed)
d.rectangle([10, 8, 50, 40], fill=(1, 2, 3))
write_png_rgb_colorkey("png-rgb8-colorkey-filters.png", keyed, (1, 2, 3))

# ---- GIF --------------------------------------------------------------------------------------------------
gif_src = scene(120, 80)
gif_src.convert("P", palette=Image.ADAPTIVE, colors=64).save("gif-static.gif")
t = gif_src.convert("P", palette=Image.ADAPTIVE, colors=64)
t.save("gif-transparent.gif", transparency=0)
gif_src.convert("P", palette=Image.ADAPTIVE, colors=32).save("gif-interlaced.gif", interlace=True)
frames = [Image.new("P", (60, 40), color=i) for i in (1, 2, 3)]
for i, f in enumerate(frames):
    f.putpalette([0, 0, 0, 250, 20, 20, 20, 250, 20, 20, 20, 250] + [0] * (768 - 12))
frames[0].save("gif-animated.gif", save_all=True, append_images=frames[1:], duration=100, loop=0)

# ---- WebP / AVIF (decoded through the optional @jsquash codecs) ---------------------------------------
scene(160, 100).save("webp-lossy.webp", quality=85)
with_alpha(scene(96, 60)).save("webp-lossless-alpha.webp", lossless=True)
scene(128, 80).save("avif-lossy.avif", quality=75)
with_alpha(scene(96, 60)).save("webp-lossy-alpha.webp", quality=80)  # VP8X + ALPH + VP8
scene(64, 40).save("webp-lossless.webp", lossless=True)  # bare VP8L
anim = [scene(96, 60), scene(96, 60).transpose(Image.FLIP_LEFT_RIGHT), scene(96, 60).transpose(Image.FLIP_TOP_BOTTOM)]
anim[0].save("webp-animated.webp", save_all=True, append_images=anim[1:], duration=100, loop=0, quality=80)


# ---- Reference downscale ------------------------------------------------------------------------------------
def area_downscale(rgba, w, h, tw, th):
    """Exact coverage-weighted mean, premultiplied alpha - the algorithm the TypeScript Downscaler implements."""
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(tw * th)]

    def axis(src, dst):
        spans = []
        for i in range(src):
            lo, hi = i * dst, (i + 1) * dst
            t0 = (i * dst) // src
            t1 = min(dst - 1, -(-((i + 1) * dst) // src) - 1)
            spans.append([(t, max(0, min(hi, (t + 1) * src) - max(lo, t * src)) / src) for t in range(t0, t1 + 1)])
        return spans

    xs, ys = axis(w, tw), axis(h, th)
    for y in range(h):
        for x in range(w):
            r, g, b, a = rgba[(y * w + x) * 4:(y * w + x) * 4 + 4]
            al = a / 255.0
            for ty, wy in ys[y]:
                for tx, wx in xs[x]:
                    wgt = wx * wy
                    cell = acc[ty * tw + tx]
                    cell[0] += r * al * wgt
                    cell[1] += g * al * wgt
                    cell[2] += b * al * wgt
                    cell[3] += al * wgt
    out = bytearray()
    for r, g, b, a in acc:
        if a < 1e-9:
            out += bytes(4)
        else:
            out += bytes([round(r / a), round(g / a), round(b / a), round(a * 255)])
    return bytes(out)


def reference(path, size):
    im = Image.open(path)
    im.seek(0)
    if im.mode.startswith("I"):
        # Pillow clips 16-bit gray to 8 bits; PNG decoders (and browsers) take the high byte
        import numpy as np

        im = Image.fromarray((np.asarray(im).astype(np.uint32) >> 8).clip(0, 255).astype(np.uint8), "L")
    im = im.convert("RGBA")
    w, h = im.size
    tw = max(1, min(size, w))
    th = max(1, round(h * tw / w))
    return {
        "width": w,
        "height": h,
        "target": [tw, th],
        "rgba": base64.b64encode(area_downscale(im.tobytes(), w, h, tw, th)).decode(),
    }


files = sorted(f for f in os.listdir(".") if f.endswith((".jpg", ".png", ".gif", ".webp", ".avif")))
ref = {}
for f in files:
    ref[f] = {"16": reference(f, 16)}
for f in ("jpeg-420-baseline.jpg", "jpeg-444-baseline.jpg", "png-rgba8.png", "png-rgb8.png", "jpeg-wide.jpg"):
    ref[f]["32"] = reference(f, 32)
ref["jpeg-420-baseline.jpg"]["8"] = reference("jpeg-420-baseline.jpg", 8)


def dc_grid(path):
    """Exact 8x8 block means (edge-replicated like libjpeg pads), base64 RGB - what a DC-only decode delivers."""
    import numpy as np

    im = np.asarray(Image.open(path).convert("RGB")).astype(float)
    h, w, _ = im.shape
    gh, gw = -(-h // 8), -(-w // 8)
    padded = np.pad(im, ((0, gh * 8 - h), (0, gw * 8 - w), (0, 0)), mode="edge")
    means = padded.reshape(gh, 8, gw, 8, 3).mean(axis=(1, 3))
    return {"grid": [gw, gh], "rgb": base64.b64encode(np.rint(means).astype("uint8").tobytes()).decode()}


for f in ("jpeg-gray.jpg", "jpeg-444-baseline.jpg", "jpeg-444-progressive-optimized.jpg"):
    ref[f]["dc"] = dc_grid(f)
json.dump(ref, open("reference.json", "w"), indent=1, sort_keys=True)
print(f"{len(files)} fixtures, {sum(os.path.getsize(f) for f in files) // 1024} KiB")
