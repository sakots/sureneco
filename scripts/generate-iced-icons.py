#!/usr/bin/env python3
"""Regenerate Iced icon assets from the SVG (ImageMagick and Pillow required)."""

from pathlib import Path
import subprocess

from PIL import Image


ASSETS = Path(__file__).resolve().parents[1] / "trials/iced/assets/icons"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main():
    subprocess.run(
        ["convert", "-background", "none", str(ASSETS / "app.svg"), str(ASSETS / "app.png")],
        check=True,
    )
    with Image.open(ASSETS / "app.png") as source:
        image = source.convert("RGBA")
    if image.size != (256, 256):
        raise ValueError("The window icon must be 256×256 pixels")
    (ASSETS / "app.rgba").write_bytes(image.tobytes())
    image.save(ASSETS / "app.ico", sizes=[(size, size) for size in SIZES])


if __name__ == "__main__":
    main()
