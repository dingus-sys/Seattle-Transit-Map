"""Draw the app logo (a transit line rising over the mountains and winding down to a
station) as a single SVG shape, traced from the reference sketch's proportions.

The stroke is built as a union of short round-capped pieces whose width changes along
the line, so it thickens through the curve the way a brush stroke does.
Writes web/logo-mark.svg (the bare mark, viewBox 0 0 100 100).
"""
import os

from shapely.geometry import LineString, Point
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Centerline in the sketch's pixel space: (x, y, stroke width)
MOUNTAIN = [(474, 548, 30), (702, 322, 42), (780, 382, 40), (918, 244, 48), (1072, 395, 60)]
CURVE = [(1072, 395, 60), (1118, 452, 66), (1066, 510, 60), (900, 518, 58), (780, 521, 60),
         (664, 556, 72), (622, 638, 78), (676, 703, 66), (790, 722, 60), (950, 722, 58)]
START = ((438, 593), 72, 41)   # station ring: center, outer radius, inner radius
END = ((1013, 722), 80, 45)


def catmull(pts, n=14):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in range(3)))
    out.append(pts[-1])
    return out


def stroke(points):
    parts = []
    for (x0, y0, w0), (x1, y1, w1) in zip(points, points[1:]):
        seg = LineString([(x0, y0), (x1, y1)])
        steps = max(1, int(seg.length / 6))
        for k in range(steps):
            a, b = k / steps, (k + 1) / steps
            sub = LineString([seg.interpolate(a, normalized=True), seg.interpolate(b, normalized=True)])
            parts.append(sub.buffer((w0 + (w1 - w0) * (a + b) / 2) / 2, quad_segs=8))
    return unary_union(parts)


def main():
    line = unary_union([stroke(MOUNTAIN), stroke(catmull(CURVE))])
    rings = [Point(c).buffer(ro, quad_segs=32) for c, ro, ri in (START, END)]
    holes = [Point(c).buffer(ri, quad_segs=32) for c, ro, ri in (START, END)]
    shape = unary_union([line, *rings])
    for h in holes:
        shape = shape.difference(h)
    shape = shape.buffer(3, quad_segs=6).buffer(-3, quad_segs=6).simplify(0.6)  # smooth the brush edge

    minx, miny, maxx, maxy = shape.bounds
    size = max(maxx - minx, maxy - miny)
    s = 100 / size
    ox = (100 - (maxx - minx) * s) / 2 - minx * s
    oy = (100 - (maxy - miny) * s) / 2 - miny * s

    def ring(coords):
        pts = [f"{x * s + ox:.1f} {y * s + oy:.1f}" for x, y in coords]
        return "M" + " L".join(pts) + "Z"

    polys = getattr(shape, "geoms", [shape])
    d = "".join(ring(p.exterior.coords) + "".join(ring(i.coords) for i in p.interiors) for p in polys)
    out = os.path.join(ROOT, "web", "logo-mark.svg")
    open(out, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="{d}"/></svg>\n')
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
