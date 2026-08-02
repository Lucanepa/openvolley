#!/usr/bin/env python3
"""Golden-image regression test.

Re-renders every screen and checks it still matches the committed reference in golden/.
Catches accidental rendering changes, and once the board's baseline is dialled in on real
hardware it locks that in too. A screen passes if < 0.5% of its pixels differ from golden
(a small tolerance absorbs Pillow anti-aliasing noise across versions).

    python3 goldentest.py            # check against golden/
    cp samples/*.png golden/         # (re)bless the current render as the reference
"""
import os
import subprocess
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    print("pillow required: pip install pillow")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
THRESHOLD = 0.005  # max fraction of changed pixels per screen


def diff_fraction(a_path, b_path):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return 1.0
    diff = ImageChops.difference(a, b)
    pixels = list(diff.getdata())
    changed = sum(1 for (r, g, bl) in pixels if r + g + bl > 24)  # ignore faint AA noise
    return changed / max(1, len(pixels))


def main():
    subprocess.run([sys.executable, os.path.join(HERE, "render_samples.py")],
                   cwd=HERE, check=True, stdout=subprocess.DEVNULL)
    gdir, sdir = os.path.join(HERE, "golden"), os.path.join(HERE, "samples")
    golds = sorted(f for f in os.listdir(gdir) if f.endswith(".png")) if os.path.isdir(gdir) else []
    if not golds:
        print("no golden/ reference yet — bless the current render with:  cp samples/*.png golden/")
        return 1
    ok = True
    for f in golds:
        s = os.path.join(sdir, f)
        if not os.path.exists(s):
            print(f"  FAIL {f}  (not rendered)")
            ok = False
            continue
        frac = diff_fraction(os.path.join(gdir, f), s)
        passed = frac < THRESHOLD
        ok = ok and passed
        print(f"  {'PASS' if passed else 'FAIL'} {f}  ({frac * 100:.2f}% changed)")
    print("golden: OK" if ok else "golden: MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
