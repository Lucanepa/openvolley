"""Geometry of the OpenVolley ball, and the ball-only SVGs in this folder.

Only needed to redraw the ball itself (change a seam, a colour, a size cut).
The rasters (favicon, PWA, Android, desktop, PDF) are rendered from the SVGs
by scripts/make-brand-assets.py; the lockups (lockup*.svg) are committed as
they are, because their letters are outlines of Inter Display Bold.

    cd escoresheet/frontend && python3 brand/geometry.py

The ball: a circle of radius R cut by three circular-arc seams that leave the
centre 120 deg apart and meet the rim. Each third has one more seam parallel
to its neighbour, from the rim to the next seam: 3 panel groups of 2 strips,
the stripe pattern that reads as a volleyball rather than a pinwheel. Seams
are real gaps of width g, not white strokes: every panel edge is an arc
concentric with its seam, so each panel is a handful of SVG `A` arcs, no
flattening, no masks, no strokes. Panel group 0 (top right) is the red one.
Standard library only.
"""
import math
from pathlib import Path

RED = '#e2001a'    # Swiss Volley red (volleyui red-600)
INK = '#1c1917'    # stone-900
PAPER = '#fafaf9'  # stone-50: the ink panels on dark backgrounds
HAIR = '#e7e5e4'   # stone-200: the tile hairline
MONO = '#000000'   # one colour: Android themed icon, one-colour print

BEND = 0.42        # seam curvature (offset of the seam circle, fraction of R)
STRIPE = 0.40      # width of the parallel strip, fraction of R

OUT = Path(__file__).resolve().parent


def _circ_inter(c1, r1, c2, r2):
    (x1, y1), (x2, y2) = c1, c2
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
    h2 = r1 * r1 - a * a
    if h2 < 0:
        raise ValueError('no intersection')
    h = math.sqrt(h2)
    xm, ym = x1 + a * dx / d, y1 + a * dy / d
    return [(xm + h * dy / d, ym - h * dx / d), (xm - h * dy / d, ym + h * dx / d)]


def _ang(c, p):
    return math.atan2(p[1] - c[1], p[0] - c[0])


def _delta(a0, a1):
    d = a1 - a0
    while d <= -math.pi:
        d += 2 * math.pi
    while d > math.pi:
        d -= 2 * math.pi
    return d


def f(v):
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def _arc(C, r, p_from, p_to):
    d = _delta(_ang(C, p_from), _ang(C, p_to))
    return f'A{f(r)} {f(r)} 0 0 {1 if d > 0 else 0} {f(p_to[0])} {f(p_to[1])}'


def _M(p):
    return f'M{f(p[0])} {f(p[1])}'


def _seams(cx, cy, R, bend, rot):
    O = (cx, cy)
    out = []
    for k in range(3):
        th = math.radians(rot + 120 * k)
        P = (cx + R * math.cos(th), cy + R * math.sin(th))
        M = ((O[0] + P[0]) / 2, (O[1] + P[1]) / 2)
        nx, ny = -(P[1] - O[1]) / R, (P[0] - O[0]) / R
        S = (M[0] + nx * bend * R, M[1] + ny * bend * R)
        out.append((S, math.hypot(S[0] - O[0], S[1] - O[1]), th, P))
    return out


def panels(cx, cy, R, g, bend=BEND, rot=-90):
    """The three panel groups without their parallel seam: 3 paths."""
    O = (cx, cy)
    sm = _seams(cx, cy, R, bend, rot)
    out = []
    for k in range(3):
        (Sa, ra, tha, PA), (Sb, rb, thb, PB) = sm[k], sm[(k + 1) % 3]
        tm = tha + math.radians(60)
        T = (cx + 0.75 * R * math.cos(tm), cy + 0.75 * R * math.sin(tm))
        rA = ra - g / 2 if math.dist(T, Sa) < ra else ra + g / 2
        rB = rb - g / 2 if math.dist(T, Sb) < rb else rb + g / 2
        rimA = min(_circ_inter(O, R, Sa, rA), key=lambda p: math.dist(p, PA))
        rimB = min(_circ_inter(O, R, Sb, rB), key=lambda p: math.dist(p, PB))
        corner = min(_circ_inter(Sa, rA, Sb, rB), key=lambda p: math.dist(p, O))
        a0, a1 = _ang(O, rimA), _ang(O, rimB)
        large = 1 if (a1 - a0) % (2 * math.pi) > math.pi else 0
        dB = _delta(_ang(Sb, rimB), _ang(Sb, corner))
        dA = _delta(_ang(Sa, corner), _ang(Sa, rimA))
        out.append(f'M{f(rimA[0])} {f(rimA[1])}'
                   f'A{f(R)} {f(R)} 0 {large} 1 {f(rimB[0])} {f(rimB[1])}'
                   f'A{f(rB)} {f(rB)} 0 0 {1 if dB > 0 else 0} {f(corner[0])} {f(corner[1])}'
                   f'A{f(rA)} {f(rA)} 0 0 {1 if dA > 0 else 0} {f(rimA[0])} {f(rimA[1])}Z')
    return out


def striped(cx, cy, R, g, w=STRIPE, bend=BEND, rot=-90):
    """The three panel groups with their parallel seam: 3 x (strip, rest)."""
    O = (cx, cy)
    sm = _seams(cx, cy, R, bend, rot)
    res = []
    for k in range(3):
        A, B = sm[k], sm[(k + 1) % 3]
        mid = sm[k][2] + math.radians(60)
        T = (cx + 0.75 * R * math.cos(mid), cy + 0.75 * R * math.sin(mid))
        # the strip runs along the seam whose circle the panel lies outside of
        if math.dist(T, B[0]) < B[1]:
            A, B = B, A
        (Sa, ra, tha, PA), (Sb, rb, thb, PB) = A, B
        sa = -1 if math.dist(T, Sa) < ra else 1
        sb = -1 if math.dist(T, Sb) < rb else 1
        rA = ra + sa * g / 2
        rB = rb + sb * g / 2
        rP1 = rb + sb * (w * R - g / 2)
        rP2 = rb + sb * (w * R + g / 2)
        rimA = min(_circ_inter(O, R, Sa, rA), key=lambda p: math.dist(p, PA))
        rimB = min(_circ_inter(O, R, Sb, rB), key=lambda p: math.dist(p, PB))
        rimP1 = min(_circ_inter(O, R, Sb, rP1), key=lambda p: math.dist(p, rimB))
        rimP2 = min(_circ_inter(O, R, Sb, rP2), key=lambda p: math.dist(p, rimB))
        corner = min(_circ_inter(Sa, rA, Sb, rB), key=lambda p: math.dist(p, O))
        qA1 = min(_circ_inter(Sa, rA, Sb, rP1), key=lambda p: math.dist(p, corner))
        qA2 = min(_circ_inter(Sa, rA, Sb, rP2), key=lambda p: math.dist(p, corner))
        strip = (_M(rimP1) + _arc(O, R, rimP1, rimB) + _arc(Sb, rB, rimB, corner)
                 + _arc(Sa, rA, corner, qA1) + _arc(Sb, rP1, qA1, rimP1) + 'Z')
        rest = (_M(rimA) + _arc(O, R, rimA, rimP2) + _arc(Sb, rP2, rimP2, qA2)
                + _arc(Sa, rA, qA2, rimA) + 'Z')
        res.append((strip, rest))
    return res


def ball(cx, cy, R, g, ink=INK, red=RED, mono=None, simple=False):
    """The ball as 3 <path>s. simple: only the red group keeps its parallel
    seam (the small-size cut: 4 seams instead of 6)."""
    st = striped(cx, cy, R, g)
    pn = panels(cx, cy, R, g) if simple else None
    out = []
    for k in range(3):
        d = pn[k] if simple and k else st[k][0] + st[k][1]
        out.append(f'<path fill="{mono or (red if k == 0 else ink)}" d="{d}"/>')
    return '\n  '.join(out)


def svg(body, vb='0 0 512 512', title='OpenVolley'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}">\n'
            f'  <title>{title}</title>\n  {body}\n</svg>\n')


DISC = '<circle cx="256" cy="256" r="256" fill="#ffffff"/>\n  '
SAFE_R = 512 * 33 / 108   # 108 dp adaptive canvas -> 66 dp safe circle: r 156.4 of 512
TILE_R = 150              # the ball inside the app tile (< SAFE_R)
# Android shows a 72 dp window of the 108 dp canvas: TILE_R would fill ~88 % of
# the launcher circle, heavier than the system icons. Their keyline: ~70 %.
ADAPTIVE_R = 120
# Themed (monochrome) icons are glyphs: a little smaller again, like the system ones.
THEMED_R = 108

FILES = {
    # the mark, 16 px of clear space on 512
    'mark.svg': svg(ball(256, 256, 240, 24)),
    'mark-dark.svg': svg(ball(256, 256, 240, 24, ink=PAPER)),
    'mark-mono.svg': svg(ball(256, 256, 240, 24, mono=MONO), title='OpenVolley (monochrome)'),
    # small-size cut on a white disc (holds on dark): heavier seams. The serve
    # ball (20..100 px) and the 48+ px favicon entries.
    'ball.svg': svg(DISC + ball(256, 256, 238, 50)),
    # smallest cut: 16/32 px favicon, the browser tab's SVG icon
    'favicon.svg': svg(DISC + ball(256, 256, 240, 52, simple=True)),
    # app tile (PWA, apple-touch): 512 = the 108 dp adaptive canvas
    'icon-tile.svg': svg(
        f'<rect x="0.75" y="0.75" width="510.5" height="510.5" rx="114" fill="#ffffff" stroke="{HAIR}" stroke-width="1.5"/>\n  '
        + ball(256, 256, TILE_R, 17), title='OpenVolley eScoresheet'),
    # Android adaptive layers; the background layer is plain #ffffff
    'adaptive-foreground.svg': svg(ball(256, 256, ADAPTIVE_R, 14), title='OpenVolley adaptive foreground'),
    'adaptive-monochrome.svg': svg(ball(256, 256, THEMED_R, 13, mono=MONO), title='OpenVolley adaptive monochrome'),
    # Windows / Linux app icon: tile inset like the platform icon grids
    'icon-desktop.svg': svg(
        f'<rect x="32" y="32" width="448" height="448" rx="100" fill="#ffffff" stroke="{HAIR}" stroke-width="2"/>\n  '
        + ball(256, 256, 168, 18), title='OpenVolley eScoresheet'),
    # ... and its 16-32 px cut: fuller tile, bigger ball, 4 seams
    'icon-desktop-small.svg': svg(
        f'<rect x="8" y="8" width="496" height="496" rx="96" fill="#ffffff" stroke="{HAIR}" stroke-width="8"/>\n  '
        + ball(256, 256, 206, 46, simple=True), title='OpenVolley eScoresheet'),
}

if __name__ == '__main__':
    for name, text in FILES.items():
        (OUT / name).write_text(text)
        print('wrote', OUT / name)
