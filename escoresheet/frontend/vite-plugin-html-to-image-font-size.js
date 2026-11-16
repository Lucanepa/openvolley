/**
 * html-to-image (1.11.x) prints every font smaller than the sheet sets it:
 * when a computed style has no cssText (Chromium and WebKit, always), its
 * clone-node copies `font-size` as `Math.floor(px) - 0.1`. A DoB at 8.5px
 * became 7.9px, a FitText name at 5.5px 4.9px (up to 11 % smaller), so the PDF
 * did not show the sizes FitText fitted or the owner chose (field-spec 17.13).
 *
 * This plugin turns that branch off where the module is loaded, in every
 * build (vite.config.js: web, desktop, Android, F-Droid; scripts/
 * build-subdomains.js: manager, app, referee, ...), the dev server and the
 * tests (vitest.config.js). A patch-package postinstall would not run in the
 * F-Droid recipe (`npm ci --ignore-scripts`). If an html-to-image update changes the code so
 * the branch is still there but no longer recognised, the build fails rather
 * than shipping small text; if the update drops the branch, nothing is done.
 * scoresheet_pdf/__tests__/htmlToImageFontSize.test.ts guards both cases.
 */

/** `if (name === 'font-size' && value.endsWith('px'))` (es, lib) or the dist's minified form */
const FONT_SIZE_BRANCH = /(if\s*\(\s*)((?:\w+\s*===\s*(['"])font-size\3|(['"])font-size\4\s*===\s*\w+)\s*&&\s*\w+\.endsWith\(\s*(['"])px\5\s*\)\s*\))/g

/** The shrinking itself: `Math.floor(parseFloat(...)) - 0.1` (or `-.1`) */
const SHRINK = /Math\.floor\(\s*parseFloat\([^;]*?\)\s*\)\s*-\s*0?\.1\b/

/** Files of html-to-image that hold the branch */
const MODULE = /[\\/]node_modules[\\/]html-to-image[\\/](?:es[\\/]clone-node|lib[\\/]clone-node|dist[\\/]html-to-image)\.js(?:\?.*)?$/

/**
 * The module's code with the font-size branch disabled (`if (false && ...)`).
 * Unchanged when there is no shrinking in it; throws when there is, but in a
 * form this does not recognise.
 * @param {string} code
 * @param {string} [id]  for the error message
 * @returns {string}
 */
export function keepFontSize(code, id = 'html-to-image') {
  if (!SHRINK.test(code)) return code
  let hits = 0
  const out = code.replace(FONT_SIZE_BRANCH, (_m, head, cond) => {
    hits += 1
    return `${head}false /* OpenVolley: keep font-size */ && ${cond}`
  })
  if (hits !== 1) {
    throw new Error(`[html-to-image-font-size] ${id}: found ${hits} font-size branches, expected 1. ` +
      'html-to-image changed: check that it still copies font-size unchanged (vite-plugin-html-to-image-font-size.js).')
  }
  return out
}

/** @returns {import('vite').Plugin} */
export function htmlToImageFontSize() {
  return {
    name: 'openvolley:html-to-image-font-size',
    enforce: 'pre',
    transform(code, id) {
      if (!MODULE.test(id)) return null
      return { code: keepFontSize(code, id), map: null }
    }
  }
}

export default htmlToImageFontSize
