"""OpenBeach's desktop app icons (src-tauri/icons/beach, tauri.beach.conf.json),
rendered from its logo B2 in brand/beach/.

    cd escoresheet/frontend && python3 scripts/make-beach-icons.py

`tauri icon` (resvg) renders brand/beach/icon-tile.svg, the dune app tile, for
48 px and up, and brand/beach/favicon.svg, its small-size cut (a fuller tile,
the ball near the edge), for 16 to 32 px, where the tile's ball would be a
smudge. Pillow writes the .ico and .icns from those renders, each size drawn
at its own size. The SVGs are copies of openbeach's escoresheet/frontend/brand/
(its README describes the logo); copy them again when that changes.
Needs: npm install (for @tauri-apps/cli), Pillow.
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent          # escoresheet/frontend
BRAND = ROOT / 'brand/beach'
OUT = ROOT / 'src-tauri/icons/beach'
TAURI = ROOT / 'node_modules/.bin/tauri'
TILE, SMALL = 'icon-tile.svg', 'favicon.svg'

_tmp = Path(tempfile.mkdtemp(prefix='ob-icons-'))
_sets = {}


def render(name, size):
    """brand/beach/<name> at size x size px, from `tauri icon`'s set (every
    size it writes is rendered at that size) or a --png render of its own."""
    if name not in _sets:
        out = _tmp / name
        subprocess.run([str(TAURI), 'icon', str(BRAND / name), '-o', str(out)],
                       check=True, capture_output=True, cwd=ROOT)
        _sets[name] = out
    png = _sets[name] / f'{size}x{size}.png'
    if not png.exists():
        out = _tmp / f'{name}-{size}'
        subprocess.run([str(TAURI), 'icon', str(BRAND / name), '--png', str(size), '-o', str(out)],
                       check=True, capture_output=True, cwd=ROOT)
        png = out / f'{size}x{size}.png'
    return Image.open(png).convert('RGBA')


def save(im, name):
    im.save(OUT / name, optimize=True)
    print('wrote', (OUT / name).relative_to(ROOT))


OUT.mkdir(parents=True, exist_ok=True)
save(render(SMALL, 32), '32x32.png')
save(render(TILE, 64), '64x64.png')
save(render(TILE, 128), '128x128.png')
save(render(TILE, 256), '128x128@2x.png')
save(render(TILE, 512), 'icon.png')

ICO = {16: SMALL, 24: SMALL, 32: SMALL, 48: TILE, 64: TILE, 256: TILE}
images = [render(n, s) for s, n in sorted(ICO.items())]
images[-1].save(OUT / 'icon.ico', format='ICO', sizes=[i.size for i in images], append_images=images[:-1])
print('wrote', (OUT / 'icon.ico').relative_to(ROOT))

ICNS = {16: SMALL, 32: SMALL, 64: TILE, 128: TILE, 256: TILE, 512: TILE, 1024: TILE}
images = [render(n, s) for s, n in sorted(ICNS.items())]
images[-1].save(OUT / 'icon.icns', format='ICNS', append_images=images[:-1])
print('wrote', (OUT / 'icon.icns').relative_to(ROOT))

shutil.rmtree(_tmp, ignore_errors=True)
