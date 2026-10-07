"""Every OpenVolley logo raster, rendered from the SVGs in brand/.

    cd escoresheet/frontend && python3 scripts/make-brand-assets.py

Rerun after changing a file in brand/ (see brand/README.md), check the
renders, commit them with the SVG. It writes:

- public/: favicon.svg, favicon.ico, apple-touch-icon.png, icon-192/512.png
  and icon-maskable-192/512.png (PWA manifest), ball.png (serve indicator,
  scoresheet PDF), openvolley_logo.png (PDF header)
- src/ball_fallback.png (bundled copy of the serve ball)
- android/app/src/main/res: launcher icons (square, round, adaptive
  foreground, themed-icon monochrome) for every density, pre-Android-12 splash
- src-tauri/icons and electron/: desktop app icons (png, ico, icns)
- fastlane/metadata/android/en-US/images/icon.png (repo root): store icon
- ../backend/lib/brandMark.js: the mark as inline SVG for the server's page
- ../deploy/pkgs/index.html: the install page's favicon and header icon, inline

The SVGs are rasterised by resvg through the Tauri CLI (`tauri icon --png`,
already a devDependency, works offline); Pillow composes, crops and writes
the .ico/.icns files. Needs: npm install (for @tauri-apps/cli), Pillow.
"""
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent          # escoresheet/frontend
REPO = ROOT.parent.parent
BRAND = ROOT / 'brand'
PUBLIC = ROOT / 'public'
RES = ROOT / 'android/app/src/main/res'
TAURI = ROOT / 'node_modules/.bin/tauri'
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

_tmp = Path(tempfile.mkdtemp(prefix='ov-brand-'))
_cache = {}


def _svg(name):
    return (BRAND / name).read_text()


def _viewbox(text):
    return [float(v) for v in re.search(r'viewBox="([^"]+)"', text).group(1).split()]


def _in_square(text, w, h):
    """text drawn into a w x h box (top left) of a max(w, h) square canvas,
    since resvg (tauri icon) renders square outputs only."""
    vb = ' '.join(f'{v:g}' for v in _viewbox(text))
    inner = text[text.index('>') + 1:text.rindex('</svg>')]
    side = max(w, h)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}">'
            f'<svg x="0" y="0" width="{w}" height="{h}" viewBox="{vb}">{inner}</svg></svg>')


def render(name, w, h=None):
    """brand/<name> rasterised to w x h px (aspect kept, centred), RGBA."""
    h = h or w
    key = (name, w, h)
    if key not in _cache:
        text = _svg(name) if w == h else _in_square(_svg(name), w, h)
        side = max(w, h)
        n = len(_cache)
        (_tmp / f'{n}.svg').write_text(text)
        subprocess.run([str(TAURI), 'icon', str(_tmp / f'{n}.svg'), '--png', str(side), '-o', str(_tmp / str(n))],
                       check=True, capture_output=True, cwd=ROOT)
        im = Image.open(_tmp / str(n) / f'{side}x{side}.png').convert('RGBA')
        _cache[key] = im.crop((0, 0, w, h))
    return _cache[key].copy()


def fit_box(name, box):
    """brand/<name> scaled to fit a box x box square, at its own aspect."""
    _, _, vw, vh = _viewbox(_svg(name))
    s = box / max(vw, vh)
    return render(name, max(1, round(vw * s)), max(1, round(vh * s)))


def on_canvas(size, name, fraction, background=WHITE):
    canvas = Image.new('RGBA', (size, size), background)
    art = fit_box(name, round(size * fraction))
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def masked(img, shape, radius_fraction=0.0):
    ss = 4
    m = Image.new('L', (img.width * ss, img.height * ss), 0)
    box = (0, 0, m.width - 1, m.height - 1)
    if shape == 'circle':
        ImageDraw.Draw(m).ellipse(box, fill=255)
    else:
        ImageDraw.Draw(m).rounded_rectangle(box, radius=int(m.width * radius_fraction), fill=255)
    out = Image.new('RGBA', img.size, CLEAR)
    out.paste(img, (0, 0), m.resize(img.size, Image.LANCZOS))
    return out


def rel(path):
    return path.relative_to(REPO)


def save_png(im, path, rgb=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    (im.convert('RGB') if rgb else im).save(path, optimize=True)
    print('wrote', rel(path))


def save_ico(path, entries):
    """entries {size: brand svg}: every size drawn at its own size, no downscaling."""
    images = [render(name, s) for s, name in sorted(entries.items())]
    images[-1].save(path, format='ICO', sizes=[im.size for im in images], append_images=images[:-1])
    print('wrote', rel(path))


def save_icns(path, entries):
    images = [render(name, s) for s, name in sorted(entries.items())]
    images[-1].save(path, format='ICNS', append_images=images[:-1])
    print('wrote', rel(path))


# ---- web ---------------------------------------------------------------
shutil.copyfile(BRAND / 'favicon.svg', PUBLIC / 'favicon.svg')
print('wrote', rel(PUBLIC / 'favicon.svg'))
# 16/32 px: the 4-seam cut; 48 px and up: the 6-seam small-size ball
save_ico(PUBLIC / 'favicon.ico', {16: 'favicon.svg', 32: 'favicon.svg', 48: 'ball.svg',
                                  64: 'ball.svg', 128: 'ball.svg', 256: 'ball.svg'})
# iOS rounds the corners itself: an opaque white square, the ball at 76 %
save_png(on_canvas(180, 'mark.svg', 0.76), PUBLIC / 'apple-touch-icon.png', rgb=True)
for s in (192, 512):
    save_png(render('icon-tile.svg', s), PUBLIC / f'icon-{s}.png')
    # maskable: full-bleed white, the ball well inside the 80 % safe circle
    save_png(on_canvas(s, 'mark.svg', 0.72), PUBLIC / f'icon-maskable-{s}.png', rgb=True)
save_png(render('ball.svg', 1024), PUBLIC / 'ball.png')
save_png(render('ball.svg', 256), ROOT / 'src/ball_fallback.png')
save_png(fit_box('lockup.svg', 1024), PUBLIC / 'openvolley_logo.png')

# ---- Android -----------------------------------------------------------
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for dens, d in DENSITIES.items():
    folder = RES / f'mipmap-{dens}'
    launcher = round(48 * d)   # legacy icons (API < 26): a white tile, a white disc
    save_png(masked(on_canvas(launcher, 'mark.svg', 0.78), 'rounded', 0.18), folder / 'ic_launcher.png')
    save_png(masked(on_canvas(launcher, 'mark.svg', 0.72), 'circle'), folder / 'ic_launcher_round.png')
    fg = round(108 * d)        # adaptive layers: 108 dp canvas, 66 dp safe circle
    save_png(render('adaptive-foreground.svg', fg), folder / 'ic_launcher_foreground.png')
    save_png(render('adaptive-monochrome.svg', fg), folder / 'ic_launcher_monochrome.png')

# Pre-Android-12 splash (12+ draws the adaptive foreground on white, styles.xml)
SPLASH = {
    'drawable': (480, 320),
    'drawable-land-mdpi': (480, 320), 'drawable-land-hdpi': (800, 480),
    'drawable-land-xhdpi': (1280, 720), 'drawable-land-xxhdpi': (1600, 960),
    'drawable-land-xxxhdpi': (1920, 1280),
    'drawable-port-mdpi': (320, 480), 'drawable-port-hdpi': (480, 800),
    'drawable-port-xhdpi': (720, 1280), 'drawable-port-xxhdpi': (960, 1600),
    'drawable-port-xxxhdpi': (1280, 1920),
}
for folder, (w, h) in SPLASH.items():
    canvas = Image.new('RGBA', (w, h), WHITE)
    art = fit_box('lockup-stacked.svg', round(min(w, h) * 0.45))
    canvas.alpha_composite(art, ((w - art.width) // 2, (h - art.height) // 2))
    save_png(canvas, RES / folder / 'splash.png', rgb=True)

# ---- desktop (Tauri, Electron) ------------------------------------------
# 16-32 px: the fuller 4-seam tile; 48 px and up: the inset tile
SMALL, LARGE = 'icon-desktop-small.svg', 'icon-desktop.svg'
ICONS = ROOT / 'src-tauri/icons'
save_png(render(SMALL, 32), ICONS / '32x32.png')
save_png(render(LARGE, 64), ICONS / '64x64.png')
save_png(render(LARGE, 128), ICONS / '128x128.png')
save_png(render(LARGE, 256), ICONS / '128x128@2x.png')
save_png(render(LARGE, 512), ICONS / 'icon.png')
ICO = {16: SMALL, 24: SMALL, 32: SMALL, 48: LARGE, 64: LARGE, 256: LARGE}
ICNS = {16: SMALL, 32: SMALL, 64: LARGE, 128: LARGE, 256: LARGE, 512: LARGE, 1024: LARGE}
for folder in (ICONS, ROOT / 'electron'):
    save_ico(folder / 'icon.ico', ICO)
    save_icns(folder / 'icon.icns', ICNS)
save_png(render(LARGE, 1024), ROOT / 'electron/icon.png')

# ---- store listing (F-Droid / fastlane) ----------------------------------
save_png(render('icon-tile.svg', 512), REPO / 'fastlane/metadata/android/en-US/images/icon.png')

# ---- the server's status page (no build step there: a generated module) --
mark = _svg('mark.svg')
mark = re.sub(r'\s*<title>[^<]*</title>', '', mark)
mark = re.sub(r'\s+role="img" aria-label="[^"]*"', '', mark)
mark = re.sub(r'>\s+<', '><', mark).strip()
assert "'" not in mark and '\\' not in mark
brand_js = ROOT.parent / 'backend/lib/brandMark.js'
brand_js.write_text(
    '// GENERATED by escoresheet/frontend/scripts/make-brand-assets.py from\n'
    '// escoresheet/frontend/brand/mark.svg. Do not edit: change the SVG, rerun.\n'
    '//\n'
    "// The OpenVolley mark as inline SVG for the server's own HTML: no file, no\n"
    '// request, as the status page must render on a venue LAN with no internet.\n'
    f"export const BRAND_MARK = '{mark}'\n"
    '\n'
    '/** The mark `size` px square, decorative (the page names OpenVolley in text). */\n'
    "export function brandMark({ size = 28, className = 'brand-mark' } = {}) {\n"
    "  return BRAND_MARK.replace('<svg ', `<svg class=\"${className}\" width=\"${size}\" height=\"${size}\" aria-hidden=\"true\" focusable=\"false\" `)\n"
    '}\n')
print('wrote', rel(brand_js))

# ---- the install page (get.openvolley.app): inline, it fetches nothing ----
def bare(text):
    text = re.sub(r'\s*<title>[^<]*</title>', '', text)
    text = re.sub(r'\s+role="img" aria-label="[^"]*"', '', text)
    return re.sub(r'>\s+<', '><', text).strip()


page = ROOT.parent / 'deploy/pkgs/index.html'
html = page.read_text()
fav = bare(_svg('favicon.svg')).replace('"', "'")
fav = ''.join(c if c.isalnum() or c in " ='/:.-" else f'%{ord(c):02X}' for c in fav)
html, n1 = re.subn(r'<link rel="icon" href="data:image/svg\+xml,[^"]*">',
                   lambda _: f'<link rel="icon" href="data:image/svg+xml,{fav}">', html)
tile = bare(_svg('icon-tile.svg')).replace('<svg ', '<svg class="hero-icon" aria-hidden="true" focusable="false" ', 1)
html, n2 = re.subn(r'<svg class="hero-icon"[\s\S]*?</svg>', lambda _: tile, html)
assert n1 == 1 and n2 == 1, 'deploy/pkgs/index.html: favicon link or hero icon not found'
page.write_text(html)
print('wrote', rel(page))

shutil.rmtree(_tmp, ignore_errors=True)
