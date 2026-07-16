#!/usr/bin/env python3
"""Encode an RGBA PNG as lossless WebP while preserving transparent RGB."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def clear_transparent_rgb(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    data = bytearray(rgba.tobytes())
    for index in range(0, len(data), 4):
        if data[index + 3] == 0:
            data[index] = 0
            data[index + 1] = 0
            data[index + 2] = 0
    return Image.frombytes("RGBA", rgba.size, bytes(data))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    with Image.open(input_path) as opened:
        image = clear_transparent_rgb(opened)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="WEBP", lossless=True, quality=100, method=6, exact=True)
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
