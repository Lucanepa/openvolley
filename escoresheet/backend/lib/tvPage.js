/**
 * The live screen page any screen can open, smart TVs included
 * (owner 2026-11-17): GET /tv/<code> and its script GET /tv/tv.js.
 *
 * The page and its script are plain files, lib/tv/tv.html and lib/tv/tv.js,
 * so the desktop app's relay (frontend/src-tauri/src/relay.rs) embeds the very
 * same page (include_str!) and serves it without internet. Rules for them:
 *
 *   - plain HTML, CSS without grid or custom properties, and ES5 JavaScript
 *     (no arrow functions, let/const, template literals, fetch, promises):
 *     smart TV browsers (Samsung Tizen, LG webOS, old Android TV and Fire TV)
 *     run old engines. tests/tvPage.test.js checks it;
 *   - the script polls /api/global/live/<code> on the SAME origin every 5 s,
 *     so it works from the cloud (openvolley.app/tv/<code> redirects there)
 *     and from any venue relay or desktop app (http://<relay>/tv/<code>);
 *   - no inline script (the backend's CSP allows scripts from 'self' only);
 *   - placeholders in tv.html: `{{CODE}}`, `{{SRC}}` (what the script polls)
 *     and `{{LABEL}}` (shown at the top), each once.
 */
import { readFileSync } from 'node:fs'

const TV_HTML = readFileSync(new URL('./tv/tv.html', import.meta.url), 'utf8')
export const TV_JS = readFileSync(new URL('./tv/tv.js', import.meta.url), 'utf8')
// /tv without a code: a form to type it with a TV remote. No script at all:
// a GET form to /tv/go, which redirects to /tv/<code> (every TV browser can)
const TV_ENTRY_HTML = readFileSync(new URL('./tv/entry.html', import.meta.url), 'utf8')

/** The code entry page; `wrong`: the last code typed was not a code. */
export function tvEntryHtml({ wrong = false } = {}) {
  return TV_ENTRY_HTML.replace('{{ERROR}}', wrong ? '<div class="err">ABCD 2345 &middot; 8 letters and digits &middot; 8 Buchstaben und Ziffern &middot; 8 lettres et chiffres &middot; 8 lettere e cifre</div>' : '')
}

/**
 * The page for a live screen code, one court of it (`screen`), or one league
 * game (`game`). The caller has checked them (isLiveCode, screenNumber, the
 * game number's digits); only A-Z and 0-9 go into the page. A bare string is
 * a code (the first version's call).
 */
export function tvPageHtml(arg) {
  const o = typeof arg === 'string' ? { code: arg } : (arg || {})
  const clean = (v) => String(v ?? '').replace(/[^A-Z0-9]/g, '')
  let code = clean(o.code), src, label
  if (o.game != null) {
    const g = clean(o.game)
    code = ''
    src = `/api/global/live/game/${g}`
    label = `#${g}`
  } else {
    const n = Number(o.screen)
    const screen = Number.isInteger(n) && n >= 1 && n <= 99 ? n : null
    src = `/api/global/live/${code}${screen ? `?screen=${screen}` : ''}`
    label = `${code.slice(0, 4)} ${code.slice(4)}${screen ? ` \u00b7 ${screen}` : ''}`
  }
  return TV_HTML.replace('{{CODE}}', code).replace('{{SRC}}', src).replace('{{LABEL}}', label)
}
