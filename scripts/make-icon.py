"""Draw media/icon.png, the Marketplace icon.

The icon is a shell prompt with an echo of itself behind it: the thing the
extension does is bring a prompt back. Kept as a script, and regenerated
rather than edited, so the icon has a source like everything else here.

    python scripts/make-icon.py

No third-party libraries: it writes the PNG bytes directly, and gets smooth
edges by sampling each pixel SS x SS times.
"""

import os
import struct
import zlib

SIZE = 128
SS = 4  # supersampling factor

BG = (0x10, 0x16, 0x22)
EDGE = (0x2A, 0x33, 0x45)
PROMPT = (0x4E, 0xC9, 0xB0)
CURSOR = (0xE0, 0xAF, 0x68)
GHOST_ALPHA = 0.26


def rounded_rect(x, y, w, h, r):
    """A coverage test for a rounded rectangle."""

    def inside(px, py):
        if px < x or py < y or px > x + w or py > y + h:
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        dx, dy = px - cx, py - cy
        return dx * dx + dy * dy <= r * r

    return inside


def thick_line(x1, y1, x2, y2, width):
    """A coverage test for a line segment with round caps."""
    half = width / 2.0
    vx, vy = x2 - x1, y2 - y1
    length2 = vx * vx + vy * vy

    def inside(px, py):
        if length2 == 0:
            t = 0.0
        else:
            t = ((px - x1) * vx + (py - y1) * vy) / length2
            t = min(1.0, max(0.0, t))
        dx = px - (x1 + t * vx)
        dy = py - (y1 + t * vy)
        return dx * dx + dy * dy <= half * half

    return inside


def chevron(cx, cy, reach, drop, width):
    """The > of a prompt, apex at (cx, cy)."""
    return [
        thick_line(cx - reach, cy - drop, cx, cy, width),
        thick_line(cx, cy, cx - reach, cy + drop, width),
    ]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(os.path.dirname(here), "media", "icon.png")

    plate = rounded_rect(2, 2, SIZE - 4, SIZE - 4, 26)
    inner = rounded_rect(5, 5, SIZE - 10, SIZE - 10, 23)

    ghost = chevron(45, 60, 19, 19, 9)

    live = chevron(76, 57, 24, 24, 12)
    live.append(rounded_rect(54, 84, 42, 11, 5.5))

    rows = []
    step = 1.0 / SS
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    # Background plate, with a hairline edge for light themes.
                    if not plate(x, y):
                        continue
                    colour = BG if inner(x, y) else EDGE
                    alpha = 1.0
                    for shape in ghost:
                        if shape(x, y):
                            colour = blend(colour, PROMPT, GHOST_ALPHA)
                            break
                    for i, shape in enumerate(live):
                        if shape(x, y):
                            colour = CURSOR if i == len(live) - 1 else PROMPT
                            break
                    acc[0] += colour[0] * alpha
                    acc[1] += colour[1] * alpha
                    acc[2] += colour[2] * alpha
                    acc[3] += 255.0 * alpha
            n = SS * SS
            row += bytes(int(round(c / n)) for c in acc)
        rows.append(bytes(row))

    write_png(out, SIZE, SIZE, rows)
    print("wrote " + out)


def blend(base, over, alpha):
    return tuple(int(round(b + (o - b) * alpha)) for b, o in zip(base, over))


def write_png(path, width, height, rows):
    raw = b"".join(bytes([0]) + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    png += chunk(b"IHDR", header)
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    directory = os.path.dirname(path)
    if not os.path.isdir(directory):
        os.makedirs(directory)
    with open(path, "wb") as handle:
        handle.write(png)


if __name__ == "__main__":
    main()
