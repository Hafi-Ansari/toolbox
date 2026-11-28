"""Builds the photo converter's synthetic HEIC test fixtures (e2e/fixtures/photo/*.heic).

The repo's libheif-js build only decodes HEVC, so HEIC fixtures are made here, once, with
Pillow + pillow-heif (which bundles an x265 encoder), and committed (a few KB each):

    python -m venv .venv && .venv/Scripts/pip install pillow pillow-heif   (or bin/pip)
    node scripts/photo-icc.ts > out/p3.icc
    .venv/Scripts/python scripts/photo-fixtures.py out/p3.icc

Every fixture is a 64x48 test card, stored landscape:
  - left third: pure Display P3 red (255, 0, 0), a color outside sRGB;
  - middle third: white;
  - right third: a gray ramp.
  main.heic:  8-bit, Display P3 ICC, EXIF Orientation 6 (rotate 90° clockwise), a date taken,
              Make "Toolbox test", and a made-up GPS position (12°34'56" N, 1°2'3" E).
  deep.heic:  10-bit, same picture and profile, no EXIF.
  alpha.heic: 8-bit with transparency: the right third is fully transparent.
"""
import sys
from pathlib import Path

import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()
OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures" / "photo"
OUT.mkdir(parents=True, exist_ok=True)
icc = Path(sys.argv[1]).read_bytes()


def card(mode="RGB"):
    im = Image.new(mode, (64, 48))
    px = im.load()
    for y in range(48):
        for x in range(64):
            if x < 21:
                c = (255, 0, 0)
            elif x < 42:
                c = (255, 255, 255)
            else:
                v = round(255 * y / 47)
                c = (v, v, v)
            px[x, y] = c + ((255,) if mode == "RGBA" else ())
    return im


def exif():
    e = Image.Exif()
    e[0x0112] = 6  # Orientation: rotate 90° clockwise to view
    e[0x010F] = "Toolbox test"  # Make
    e.get_ifd(0x8769)[0x9003] = "2024:05:06 07:08:09"  # DateTimeOriginal
    gps = e.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (12.0, 34.0, 56.0)
    gps[3] = "E"
    gps[4] = (1.0, 2.0, 3.0)
    return e.tobytes()


card().save(OUT / "main.heic", quality=95, icc_profile=icc, exif=exif(), chroma=444)
# 10-bit: pillow-heif saves 16-bit "RGB;16" data as 10-bit unless SAVE_HDR_TO_12_BIT is set.
pillow_heif.options.SAVE_HDR_TO_12_BIT = False
rgb = card().tobytes()
deep = b"".join(int(v * 257).to_bytes(2, "little") for v in rgb)
heif = pillow_heif.from_bytes(mode="RGB;16", size=(64, 48), data=deep)
heif[0].info["icc_profile"] = icc
heif.save(OUT / "deep.heic", quality=95, chroma=444)
alpha = card("RGBA")
for y in range(48):
    for x in range(42, 64):
        alpha.putpixel((x, y), (0, 0, 0, 0))
alpha.save(OUT / "alpha.heic", quality=95, icc_profile=icc, chroma=444)
for f in sorted(OUT.glob("*.heic")):
    print(f.name, f.stat().st_size, "bytes")
