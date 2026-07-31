#!/usr/bin/env python3
"""Render true-to-panel mocks of the LedBox idle screen (192x64).

Uses the board's own font and the same PIL drawing calls the firmware uses, so
what this produces is what the panel will show -- minus LED bloom.
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 192, 64
FONT = '/tmp/ARIAL.TTF'
GOLD = (255, 200, 50)      # KSCW gold #FFC832
BLUE = (74, 85, 162)       # KSCW blue #4A55A2 -- dim on LED, used sparingly
WHITE = (255, 255, 255)
SCALE = 7                  # upscale for viewing


def crest(height, src='/tmp/kscw_gelb.png'):
    """Trim the transparent margin and scale the crest to a target height."""
    im = Image.open(src).convert('RGBA')
    bbox = im.split()[-1].getbbox()          # alpha bbox = the actual artwork
    if bbox:
        im = im.crop(bbox)
    w = max(1, round(im.width * height / im.height))
    im = im.resize((w, height), Image.LANCZOS)
    # LED panels have no alpha: composite onto black exactly like the board does.
    flat = Image.new('RGB', im.size, (0, 0, 0))
    flat.paste(im, (0, 0), im)
    return flat


def text(d, xy, s, size, fill, anchor='la'):
    d.text(xy, s, font=ImageFont.truetype(FONT, size), fill=fill, anchor=anchor)


def variant_a():
    """Crest left + club name stacked right. Pure branding."""
    img = Image.new('RGB', (W, H), (0, 0, 0))
    c = crest(58)
    img.paste(c, (3, 3))
    d = ImageDraw.Draw(img)
    x = 3 + c.width + 10
    text(d, (x, 14), 'KSC', 26, GOLD)
    text(d, (x, 42), 'WIEDIKON', 19, WHITE)
    return img


def variant_b():
    """Crest left + the two team names right. Branding plus who is playing."""
    img = Image.new('RGB', (W, H), (0, 0, 0))
    c = crest(50)
    img.paste(c, (4, 7))
    d = ImageDraw.Draw(img)
    x = 4 + c.width + 12
    text(d, (x, 8), 'KSCW', 22, GOLD)
    text(d, (x, 34), 'GAST', 22, (255, 69, 0))
    text(d, (W - 4, 20), 'vs', 13, WHITE, anchor='ra')
    return img


def variant_c():
    """Small crest + club name on one line, team names underneath."""
    img = Image.new('RGB', (W, H), (0, 0, 0))
    c = crest(30)
    img.paste(c, (4, 1))
    d = ImageDraw.Draw(img)
    text(d, (4 + c.width + 6, 6), 'KSC WIEDIKON', 18, GOLD)
    d.line([(4, 34), (W - 4, 34)], fill=(60, 60, 60))
    text(d, (6, 40), 'KSCW', 20, WHITE)
    text(d, (W // 2, 42), '-', 16, (140, 140, 140), anchor='ma')
    text(d, (W - 6, 40), 'GAST', 20, (255, 69, 0), anchor='ra')
    return img


for name, fn in [('a', variant_a), ('b', variant_b), ('c', variant_c)]:
    img = fn()
    img.save(f'/tmp/mock_{name}.png')
    img.resize((W * SCALE, H * SCALE), Image.NEAREST).save(f'/tmp/mock_{name}_big.png')
    print(f'mock_{name}: {img.size} -> upscaled {W*SCALE}x{H*SCALE}')

# a single sheet with all three stacked, for easy comparison
sheet = Image.new('RGB', (W * SCALE, H * SCALE * 3 + 40), (20, 20, 20))
for i, n in enumerate('abc'):
    sheet.paste(Image.open(f'/tmp/mock_{n}_big.png'), (0, i * (H * SCALE + 20)))
sheet.save('/tmp/mock_all.png')
print('sheet:', sheet.size)
