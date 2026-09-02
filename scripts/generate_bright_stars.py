#!/usr/bin/env python3
"""Generate the compact HYG catalogue used by the browser.

Usage:
    python3 scripts/generate_bright_stars.py hygdata_v41.csv output.ts

The input is not bundled because the complete HYG database is about 34 MB.
The generated subset remains CC BY-SA 4.0; see the adjacent licence notice.
"""

from __future__ import annotations

import csv
import hashlib
import json
import pathlib
import sys


"""
Catalogue depth.

6.5 is the naked-eye limit of a dark site, and it is chosen to sit just past
`TimeOfDay.limitingMagnitude`, which reaches 6.2 at astronomical night. That
relationship is the whole point of the number: a catalogue that stops short of
the limit can never put a star AT the threshold, so no star ever hovers on the
edge of being seen. The previous 4.5 left the faintest record we owned a full
1.7 magnitudes clear of the limit, which is why the field read as one uniform
sprinkle — every star in it was comfortably visible.

7.0 was measured too (15,598 records) and rejected: those stars are below the
limit at every hour the world can make, so they would cost bytes and draw calls
to render nothing.
"""
MAX_MAGNITUDE = 6.5
EXPECTED_SHA256 = "d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd"
SOURCE_URL = (
    "https://raw.githubusercontent.com/astronexus/HYG-Database/"
    "main/hyg/CURRENT/hygdata_v41.csv"
)


def compact_number(value: str, digits: int) -> str:
    """
    Round-trip a catalogue field at a stated precision.

    The previous ".12g" spent twelve significant digits on every field, which
    for a nine-thousand-star catalogue is most of the file. The precisions
    below are chosen against what a pixel can resolve, not against what the
    source happens to store: 1e-5 hours of right ascension is 0.15 arcseconds
    and 1e-4 degrees of declination is 0.36 arcseconds, both far inside a
    device pixel at any field of view this game uses. Magnitude and colour
    index feed smooth curves where the third decimal has never been visible.
    """
    return format(round(float(value), digits), "g")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2])
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(
            f"Unexpected HYG v4.1 SHA-256 {digest}; expected {EXPECTED_SHA256}"
        )

    with source.open(newline="", encoding="utf-8") as handle:
        rows = [
            row
            for row in csv.DictReader(handle)
            if row["dist"] not in ("", "0.0")
            and float(row["mag"]) <= MAX_MAGNITUDE
        ]

    required = {"Polaris", "Acrux", "Mimosa", "Gacrux", "Imai"}
    names = {row["proper"] for row in rows}
    if not required.issubset(names):
        raise SystemExit(f"Required navigation stars missing: {required - names}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as out:
        out.write(
            "/* GENERATED FILE — do not hand-edit.\n"
            " * HYG Database v4.1 bright-star subset, CC BY-SA 4.0.\n"
            f" * Filter: finite-distance records with visual magnitude <= {MAX_MAGNITUDE}.\n"
            f" * Source SHA-256: {digest}.\n"
            " * Regenerate with scripts/generate_bright_stars.py.\n"
            " */\n\n"
            "export type BrightStarRecord = readonly [\n"
            "  rightAscensionHours: number,\n"
            "  declinationDeg: number,\n"
            "  visualMagnitude: number,\n"
            "  colorIndexBv: number | null,\n"
            "  /** Proper name or Bayer designation; empty for the rest. */\n"
            "  label: string,\n"
            "];\n\n"
            "export const BRIGHT_STAR_CATALOGUE = [\n"
        )
        for row in rows:
            # A label only where one carries meaning. Proper names and Bayer
            # designations are how a person refers to a star; the catalogue
            # numbers that used to fill the gap were unread by any consumer and
            # would now be seven thousand rows of "HIP 12345" — a quarter of the
            # generated file spent on strings nothing looks at. Empty string
            # rather than null so the tuple's shape never varies.
            label = row["proper"] or (
                f"{row['bayer']} {row['con']}" if row["bayer"] else ""
            )
            color_index = compact_number(row["ci"], 3) if row["ci"] else "null"
            out.write(
                "  ["
                f"{compact_number(row['ra'], 5)}, "
                f"{compact_number(row['dec'], 4)}, "
                f"{compact_number(row['mag'], 2)}, "
                f"{color_index}, "
                f"{json.dumps(label, ensure_ascii=False)}"
                "],\n"
            )
        out.write(
            "] as const satisfies readonly BrightStarRecord[];\n\n"
            "export const BRIGHT_STAR_CATALOGUE_METADATA = {\n"
            '  source: "HYG Database v4.1",\n'
            f"  sourceUrl: {json.dumps(SOURCE_URL)},\n"
            f'  sourceSha256: "{digest}",\n'
            f'  filter: "distance > 0 and visual magnitude <= {MAX_MAGNITUDE}",\n'
            f"  recordCount: {len(rows)},\n"
            '  catalogueEpoch: "J2000",\n'
            '  licence: "CC BY-SA 4.0",\n'
            "} as const;\n"
        )

    print(f"Wrote {len(rows)} stars to {destination}")


if __name__ == "__main__":
    main()
