"""OpenVolley Android launcher icons and splash images.

Renders the ball mark (public/ball.png) on white for every mipmap density
(legacy square + round icon, adaptive-icon foreground) and the full logo
(public/openvolley_no_bg.png) centred on white for the pre-Android-12 splash
drawables. Rerun after changing the logo, then rebuild:

    cd escoresheet/frontend && python3 scripts/make-android-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'android/app/src/main/res'
WHITE = (255, 255, 255, 255)

ball = Image.open(ROOT / 'public/ball.png').convert('RGBA')
ball = ball.crop(ball.getbbox())
logo = Image.open(ROOT / 'public/openvolley_no_bg.png').convert('RGBA')
logo = logo.crop(logo.getbbox())

# launcher size (dp 48) and adaptive foreground size (dp 108) per density
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def fit(img, box):
    """img scaled to fit a box x box square, centred on a transparent canvas."""
    scale = box / max(img.size)
    w, h = round(img.width * scale), round(img.height * scale)
    return img.resize((w, h), Image.LANCZOS), w, h


def on_canvas(size, art, fraction, background=WHITE):
    canvas = Image.new('RGBA', (size, size), background)
    a, w, h = fit(art, size * fraction)
    canvas.alpha_composite(a, ((size - w) // 2, (size - h) // 2))
    return canvas


def circle_mask(img):
    ss = 4
    m = Image.new('L', (img.width * ss, img.height * ss), 0)
    ImageDraw.Draw(m).ellipse((0, 0, m.width - 1, m.height - 1), fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), m.resize(img.size, Image.LANCZOS))
    return out


def rounded(img, radius_fraction=0.18):
    ss = 4
    m = Image.new('L', (img.width * ss, img.height * ss), 0)
    r = int(m.width * radius_fraction)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, m.width - 1, m.height - 1), radius=r, fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), m.resize(img.size, Image.LANCZOS))
    return out


for name, d in DENSITIES.items():
    folder = RES / f'mipmap-{name}'
    folder.mkdir(parents=True, exist_ok=True)
    launcher = round(48 * d)
    legacy = on_canvas(launcher, ball, 0.80)
    rounded(legacy).save(folder / 'ic_launcher.png')
    circle_mask(on_canvas(launcher, ball, 0.74)).save(folder / 'ic_launcher_round.png')
    # adaptive foreground: 108 dp canvas, the visible safe zone is the 66 dp circle
    fg = round(108 * d)
    on_canvas(fg, ball, 0.56, background=(0, 0, 0, 0)).save(folder / 'ic_launcher_foreground.png')

# Pre-Android-12 splash (Android 12+ draws the adaptive icon on white, see styles.xml)
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
    a, aw, ah = fit(logo, min(w, h) * 0.45)
    canvas.alpha_composite(a, ((w - aw) // 2, (h - ah) // 2))
    (RES / folder).mkdir(parents=True, exist_ok=True)
    canvas.convert('RGB').save(RES / folder / 'splash.png', optimize=True)

print('icons and splash written to', RES)
