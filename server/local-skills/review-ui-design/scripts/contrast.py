#!/usr/bin/env python3
"""Calculate WCAG contrast for two opaque sRGB hex colors."""

from __future__ import annotations

import argparse
import re
import sys


HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def parse_hex(value: str) -> tuple[int, int, int]:
    match = HEX_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(
            f"Invalid color {value!r}. Use #RGB or #RRGGBB without alpha."
        )
    raw = match.group(1)
    if len(raw) == 3:
        raw = "".join(char * 2 for char in raw)
    return tuple(int(raw[index : index + 2], 16) for index in (0, 2, 4))


def linearize(channel: int) -> float:
    value = channel / 255
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


def luminance(rgb: tuple[int, int, int]) -> float:
    red, green, blue = (linearize(channel) for channel in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: tuple[int, int, int], background: tuple[int, int, int]) -> float:
    lighter = max(luminance(foreground), luminance(background))
    darker = min(luminance(foreground), luminance(background))
    return (lighter + 0.05) / (darker + 0.05)


def pass_fail(value: float, threshold: float) -> str:
    return "PASS" if value >= threshold else "FAIL"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Calculate WCAG contrast for opaque sRGB hex colors."
    )
    parser.add_argument("foreground", help="Foreground color: #RGB or #RRGGBB")
    parser.add_argument("background", help="Background color: #RGB or #RRGGBB")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--large-text",
        action="store_true",
        help="Evaluate WCAG large-text thresholds.",
    )
    mode.add_argument(
        "--non-text",
        action="store_true",
        help="Evaluate the 3:1 non-text UI/graphics threshold.",
    )
    args = parser.parse_args()

    try:
        foreground = parse_hex(args.foreground)
        background = parse_hex(args.background)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    ratio = contrast_ratio(foreground, background)
    print(f"Contrast ratio: {ratio:.2f}:1")

    if args.non_text:
        print(f"WCAG non-text 3.0:1: {pass_fail(ratio, 3.0)}")
    elif args.large_text:
        print(f"WCAG AA large text 3.0:1: {pass_fail(ratio, 3.0)}")
        print(f"WCAG AAA large text 4.5:1: {pass_fail(ratio, 4.5)}")
    else:
        print(f"WCAG AA normal text 4.5:1: {pass_fail(ratio, 4.5)}")
        print(f"WCAG AAA normal text 7.0:1: {pass_fail(ratio, 7.0)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
