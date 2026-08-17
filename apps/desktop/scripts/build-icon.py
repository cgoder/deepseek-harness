#!/usr/bin/env python3
"""Render the app icon set from the POWER.svg source.

Pipeline: rsvg-convert the SVG at aspect-preserving size, then center it on a
square 1024x1024 transparent canvas, then run `pnpm exec tauri icon` over the
result (invoked separately by the caller). Depends on rsvg-convert (brew:
librsvg) and Pillow.
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image

SVG = Path(__file__).parent.parent / "src-tauri" / "POWER.svg"
OUT = Path(__file__).parent.parent / "src-tauri" / "app-icon.png"
CANVAS = 1024


def main() -> int:
    if not SVG.is_file():
        print(f"missing source: {SVG}", file=sys.stderr)
        return 1
    temp = Path("/tmp") / "power-icon-raw.png"
    # Aspect-preserving size: height fills the canvas, width by ratio.
    subprocess.run(
        ["rsvg-convert", "-w", "1024", "-h", str(round(1024 * 562 / 661)), str(SVG), "-o", str(temp)],
        check=True,
    )
    with Image.open(temp) as raw:
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        x = (CANVAS - raw.width) // 2
        y = (CANVAS - raw.height) // 2
        canvas.paste(raw, (x, y), raw)
        canvas.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())