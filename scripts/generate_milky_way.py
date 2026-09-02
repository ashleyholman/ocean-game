#!/usr/bin/env python3
"""Generate the compact diffuse Milky Way map used by the sky shader.

Usage:
    python3 scripts/generate_milky_way.py milkyway_gal.png output.ts

The input is the DIFFUSE layer of NASA SVS "Deep Star Maps 2020" in GALACTIC
coordinates, plate carrée. Two properties of that particular file are the
reason it is the source:

  * It is the unresolved-light layer, published separately from the resolved
    `starmap` layer. Our own HYG catalogue draws the resolved stars as points,
    so compositing this on top adds the galaxy WITHOUT counting those stars
    twice.
  * It is already in galactic coordinates, so the bake is a straight
    (l, b) -> texel mapping with no reprojection and no resampling error
    beyond the one box filter below.

The master is 32768x16384 and about 466 MB, which nobody needs: everything the
naked eye resolves in the band is degrees across. Wikimedia Commons renders a
3840x1920 version of it, and that is the expected input here, converted from
JPEG to PNG by any tool (`sips -s format png in.jpg --out out.png`). Decoding
is stdlib zlib so this script keeps its sibling's no-dependencies property.

Licence: NASA/Goddard Space Flight Center Scientific Visualization Studio
(Ernie Wright, Laurence Schuler, Ian Jones), built from Gaia DR2. CC BY.
See docs/project/ASSET_CREDITS.md.
"""

from __future__ import annotations

import base64
import hashlib
import pathlib
import struct
import sys
import zlib


# 0.75 degrees per texel. Chosen by looking: at this size the Great Rift keeps
# its edges and the Magellanic Clouds keep their shape, and at half of it
# (240x120, 1.5 degrees) both smear into the general glow — which loses the
# only thing a real map buys over a procedural band.
MAP_WIDTH = 480
MAP_HEIGHT = 240

# Chromaticity is stored at a quarter of the luminance resolution because it
# genuinely varies that slowly: the plane is warm and the halo is neutral over
# tens of degrees, while the STRUCTURE — which lane is dark — is carried
# entirely by luminance. A quarter-resolution chroma plane costs 19 KB of
# source instead of 300 KB and is indistinguishable once recombined.
CHROMA_DIVISOR = 4

# Luminance is stored as linear^(1/4), not as sRGB.
#
# This map gets multiplied down to a low amplitude and added to a nearly black
# sky, so the faint high-latitude glow is the part most at risk. In sRGB
# encoding a texel at 0.001 of peak lands on code 3 of 255 and bands visibly
# once amplified; the fourth root puts it on code 45 and spends the codes
# where the picture actually is. The shader undoes it with a pow(v, 4).
LUMINANCE_GAMMA = 4.0

# Chromaticity ratios reach about 1.8 in the reddest dust and 1.4 in the bluest
# halo, so 2.5 leaves headroom at both ends without wasting many codes.
CHROMA_SCALE = 2.5

SOURCE_URL = "https://svs.gsfc.nasa.gov/4851"
SOURCE_FILE = "Deep Star Maps 2020 – Milkyway 2020 64k gal.jpg (3840px render)"

LUMA = (0.2126, 0.7152, 0.0722)

SRGB_TO_LINEAR = [
    (v / 255.0 / 12.92)
    if (v / 255.0) <= 0.04045
    else (((v / 255.0) + 0.055) / 1.055) ** 2.4
    for v in range(256)
]


def read_png(path: pathlib.Path) -> tuple[int, int, int, bytes]:
    """Decode an 8-bit non-interlaced PNG to raw samples."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    pos = 8
    idat = bytearray()
    width = height = depth = ctype = interlace = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if tag == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(
                ">IIBBBBB", body[:13]
            )
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length
    if depth != 8 or interlace != 0:
        raise SystemExit("expected an 8-bit non-interlaced PNG")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    if channels < 3:
        raise SystemExit("expected a colour PNG")

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(height * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        filter_type = raw[p]
        p += 1
        line = bytearray(raw[p : p + stride])
        p += stride
        if filter_type == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                guess = a + b - c
                da, db, dc = abs(guess - a), abs(guess - b), abs(guess - c)
                pred = a if (da <= db and da <= dc) else (b if db <= dc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif filter_type != 0:
            raise SystemExit(f"unknown PNG filter {filter_type}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)


def box_downsample(
    width: int,
    height: int,
    channels: int,
    pixels: bytes,
    out_w: int,
    out_h: int,
) -> list[list[float]]:
    """Area-average to the target grid, IN LINEAR LIGHT.

    Averaging display-encoded values would be averaging the wrong quantity: a
    texel that is half bright lane and half dark dust carries the mean FLUX of
    the two, and only linear samples add that way. Done in sRGB the whole band
    comes out systematically too bright, most visibly along the rift edges
    where the contrast within one texel is highest.
    """
    if width % out_w or height % out_h:
        raise SystemExit(
            f"{width}x{height} is not an integer multiple of {out_w}x{out_h}"
        )
    bx, by = width // out_w, height // out_h
    inv = 1.0 / (bx * by)
    acc = [[0.0, 0.0, 0.0] for _ in range(out_w * out_h)]
    lut = SRGB_TO_LINEAR
    for y in range(height):
        row = y * width * channels
        base = (y // by) * out_w
        for x in range(width):
            i = row + x * channels
            cell = acc[base + x // bx]
            cell[0] += lut[pixels[i]]
            cell[1] += lut[pixels[i + 1]]
            cell[2] += lut[pixels[i + 2]]
    return [[c * inv for c in cell] for cell in acc]


def encode_byte(value: float) -> int:
    return max(0, min(255, int(round(value * 255))))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2])
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    width, height, channels, pixels = read_png(source)
    linear = box_downsample(
        width, height, channels, pixels, MAP_WIDTH, MAP_HEIGHT
    )

    luminance = [
        LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2] for c in linear
    ]
    peak = max(luminance)
    if peak <= 0:
        raise SystemExit("source map is black")

    # Luminance plane, normalised to its own peak so the shader's amplitude
    # constant reads as "fraction of the brightest Milky Way".
    lum_bytes = bytearray(
        encode_byte((value / peak) ** (1.0 / LUMINANCE_GAMMA))
        for value in luminance
    )

    # Chroma plane: FLUX-WEIGHTED mean chromaticity over each block. Weighting
    # matters — an unweighted mean lets the near-black texels, whose ratios are
    # pure quantisation noise, drag the colour of the bright ones next to them.
    cw, chh = MAP_WIDTH // CHROMA_DIVISOR, MAP_HEIGHT // CHROMA_DIVISOR
    sums = [[0.0, 0.0, 0.0] for _ in range(cw * chh)]
    for y in range(MAP_HEIGHT):
        base = (y // CHROMA_DIVISOR) * cw
        for x in range(MAP_WIDTH):
            cell = sums[base + x // CHROMA_DIVISOR]
            rgb = linear[y * MAP_WIDTH + x]
            cell[0] += rgb[0]
            cell[1] += rgb[1]
            cell[2] += rgb[2]
    chroma_bytes = bytearray()
    for cell in sums:
        y_sum = LUMA[0] * cell[0] + LUMA[1] * cell[1] + LUMA[2] * cell[2]
        if y_sum <= 0:
            chroma_bytes += bytes((encode_byte(1 / CHROMA_SCALE),) * 2)
            continue
        chroma_bytes += bytes(
            (
                encode_byte(cell[0] / y_sum / CHROMA_SCALE),
                encode_byte(cell[2] / y_sum / CHROMA_SCALE),
            )
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as out:
        out.write(
            "/* GENERATED FILE — do not hand-edit.\n"
            ' * Diffuse Milky Way map from NASA SVS "Deep Star Maps 2020",\n'
            " * galactic coordinates, CC BY. Regenerate with\n"
            " * scripts/generate_milky_way.py.\n"
            " */\n\n"
            "/** Luminance texels across galactic longitude. */\n"
            f"export const MILKY_WAY_WIDTH = {MAP_WIDTH};\n"
            "/** Luminance texels across galactic latitude. */\n"
            f"export const MILKY_WAY_HEIGHT = {MAP_HEIGHT};\n"
            "/** The chroma plane is this many times coarser on each axis. */\n"
            f"export const MILKY_WAY_CHROMA_DIVISOR = {CHROMA_DIVISOR};\n"
            "/** Exponent the shader applies to decode stored luminance. */\n"
            f"export const MILKY_WAY_LUMINANCE_GAMMA = {LUMINANCE_GAMMA};\n"
            "/** Divisor the shader applies to decode stored chromaticity. */\n"
            f"export const MILKY_WAY_CHROMA_SCALE = {CHROMA_SCALE};\n\n"
            "/**\n"
            " * Luminance, one byte per texel, row 0 at galactic north.\n"
            " *\n"
            " * Stored as (linear / peak) ^ (1 / MILKY_WAY_LUMINANCE_GAMMA);\n"
            " * see the encoding discussion in the generator.\n"
            " */\n"
            "export const MILKY_WAY_LUMINANCE_BASE64 =\n"
            f'  "{base64.b64encode(bytes(lum_bytes)).decode("ascii")}";\n\n'
            "/** Flux-weighted (R/Y, B/Y) per coarse texel, divided by scale. */\n"
            "export const MILKY_WAY_CHROMA_BASE64 =\n"
            f'  "{base64.b64encode(bytes(chroma_bytes)).decode("ascii")}";\n\n'
            "export const MILKY_WAY_METADATA = {\n"
            '  source: "NASA SVS Deep Star Maps 2020 — diffuse galaxy layer",\n'
            f"  sourceUrl: {SOURCE_URL!r},\n".replace("'", '"')
            + f"  sourceFile: {SOURCE_FILE!r},\n".replace("'", '"')
            + f'  sourceSha256: "{digest}",\n'
            '  coordinates: "galactic, plate carree, l = 0 at u = 0.5",\n'
            f"  width: {MAP_WIDTH},\n"
            f"  height: {MAP_HEIGHT},\n"
            '  licence: "CC BY 4.0",\n'
            "} as const;\n"
        )

    print(
        f"Wrote {MAP_WIDTH}x{MAP_HEIGHT} luminance "
        f"and {cw}x{chh} chroma to {destination}"
    )


if __name__ == "__main__":
    main()
