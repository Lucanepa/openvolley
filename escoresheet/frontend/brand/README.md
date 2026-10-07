# OpenVolley logo

A flat volleyball: three curved seams from the centre, each third with one
parallel seam, so 3 panel groups of 2 strips. One group (top right) is Swiss
Volley red, the other two are stone-900. Next to it, "OpenVolley" in Inter
Display Bold. It follows the app's look (volleyui): warm stone, white, one red
accent, flat shapes.

The SVGs in this folder are the source of every logo file in the repo. Change
an SVG here, then render the rasters:

```bash
cd escoresheet/frontend
python3 brand/geometry.py               # only when redrawing the ball (rewrites the ball-only SVGs)
python3 scripts/make-brand-assets.py    # every PNG / ICO / ICNS, and backend/lib/brandMark.js
```

`make-brand-assets.py` rasterises with resvg through the Tauri CLI already in
devDependencies (`npm install` first; works offline) and composes with Pillow.
The output is deterministic: commit the SVG change and the renders together.

## Files

| File | What it is | Used for |
|---|---|---|
| `mark.svg` | The ball, 512 canvas, 16 px clear space | App screens (Scoresheet archive header), apple-touch, maskable PWA icon, legacy Android launcher icons, the server's status page (`backend/lib/brandMark.js`) |
| `mark-dark.svg` | The ball for dark backgrounds: ink panels become stone-50 | Anything on stone-900 or darker |
| `mark-mono.svg` | The ball in one colour (#000) | One-colour print, stamps, embroidery |
| `ball.svg` | Small-size cut: heavier seams (50 of 512), on a white disc | The serve indicator (`public/ball.png`, `src/ball_fallback.png`, 20 to 100 px, also on dark), the scoresheet PDF ball, favicon.ico 48 px and up |
| `favicon.svg` | Smallest cut: 4 seams instead of 6 (only the red group keeps its parallel seam), on a white disc | Browser tab icon (`public/favicon.svg`), favicon.ico 16 and 32 px |
| `icon-tile.svg` | White rounded tile with a stone-200 hairline, the ball inside the adaptive-icon safe zone | PWA `any` icons, the store icon (fastlane, F-Droid) |
| `adaptive-foreground.svg` | Android adaptive foreground: the ball on the 108 dp canvas (radius 120 of 512, about 70 % of the 72 dp launcher circle like the system icons; safe circle 156.4) | `mipmap-*/ic_launcher_foreground.png`, Android 12+ splash |
| `adaptive-monochrome.svg` | The same in black, a little smaller (radius 108), as themed glyphs are | `mipmap-*/ic_launcher_monochrome.png`, the Android 13+ themed icon |
| `icon-desktop.svg` | Inset tile, bigger ball | Windows / Linux app icon (Tauri `src-tauri/icons`, Electron), 48 px and up |
| `icon-desktop-small.svg` | Fuller tile, 4-seam ball | The same at 16, 24 and 32 px |
| `lockup.svg` | Ball + "OpenVolley" in one line, ink | Manager and console headers, the PDF header (`public/openvolley_logo.png`) |
| `lockup-dark.svg` | The same for dark backgrounds | |
| `lockup-stacked.svg` | Ball above "OpenVolley" | Home screen, referee idle screen, Android splash |
| `geometry.py` | The ball's geometry; writes the ball-only SVGs above | Redrawing the ball |

The lockups' letters are outlines (no font needed at runtime) of Inter
(SIL Open Font License 1.1) in the Display cut the app uses, Bold 700,
tracking −0.02em, kerned. The ball is 1.8× the cap height, the cap height
centred on the ball. To change the word, re-outline it; do not set it in a
font on top of the mark.

## Colours

| Role | Hex | volleyui token |
|---|---|---|
| Red panel group | `#e2001a` | red-600 (Swiss Volley red) |
| Ink panels, wordmark | `#1c1917` | stone-900 |
| Ink on dark | `#fafaf9` | stone-50 |
| Tile hairline | `#e7e5e4` | stone-200 |
| Tile, adaptive background, disc | `#ffffff` | white |

Exactly one panel group is red. App heads keep `theme-color` `#ffffff`.

## Clear space and minimum size

- Clear space: at least a quarter of the ball's diameter on every side (the
  lockup's own margin is the minimum; do not crop into it).
- The full mark (6 seams) down to 48 px. Between 20 and 48 px use `ball.svg`;
  below 20 px use `favicon.svg` (16 px) or `icon-desktop-small.svg`.
- The lockup down to 20 px tall; below that, use the mark alone.

## Do

- Use the SVGs (inline or as an image) wherever the target allows; PNGs only
  where a raster is required (PDF capture, Android, desktop icons).
- Put the ball on white or on a light stone background; on dark, use the
  `-dark` versions or `ball.svg` (it carries its own white disc).
- Keep the seams as gaps: they let the background show through.

## Don't

- Recolour the panels, make more than one group red, or add gradients,
  shadows, glows, outlines or 3D shading.
- Rotate, skew or stretch the ball, or change the seam pattern.
- Draw the seams as white strokes over a black circle (they would vanish on white).
- Put the ink ball on a dark background without its disc.
- Set "OpenVolley" in another typeface or weight next to the mark.
