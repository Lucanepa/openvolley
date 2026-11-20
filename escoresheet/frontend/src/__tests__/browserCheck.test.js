// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { JSDOM } from 'jsdom'
import { BROWSER_CHECK_SCRIPT, browserCheck } from '../../browser-check.js'
import { contentSecurityPolicy, BROWSER_CHECK_HASH } from '../../csp.js'

// The old-browser check (browser-check.js): on a browser the app cannot run
// in (Android 9's own WebView, Chrome 66: a white page, emulator check of
// 2026-11-20) a plain message instead, in the app's language.

const frontendDir = resolve(__dirname, '../..')
const read = (p) => readFileSync(resolve(frontendDir, p), 'utf8')

const UA = {
  android9: 'Mozilla/5.0 (Linux; Android 9; AOSP on IA Emulator Build/PSR1.180720.117; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.158 Mobile Safari/537.36',
  ipad15: 'Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
}

/**
 * Runs the check in a fresh page with the given browser features.
 * @param {object} o
 * @param {boolean} [o.containerQueries] CSS.supports('container-type', 'inline-size')
 * @param {boolean} [o.layers] window.CSSLayerBlockRule
 * @param {boolean} [o.css] window.CSS at all
 * @param {boolean} [o.supportsThrows] CSS.supports throws
 * @param {string} [o.language] navigator.language
 * @param {string|null} [o.saved] localStorage 'language' (the app's choice)
 * @param {string} [o.ua] navigator.userAgent
 * @param {string} [o.url]
 * @param {boolean} [o.inHead] run before <body> exists
 */
function run({ containerQueries = true, layers = true, css = true, supportsThrows = false, language = 'en-US', saved = null, ua = UA.desktop, url = 'https://app.openvolley.app/', inHead = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url, runScripts: 'outside-only' })
  const w = dom.window
  if (inHead) w.document.body.remove()
  const asked = []
  if (css) {
    w.CSS = {
      supports(prop, value) {
        asked.push(`${prop}: ${value}`)
        if (supportsThrows) throw new Error('not here')
        return prop === 'container-type' && value === 'inline-size' ? containerQueries : true
      }
    }
  } else {
    delete w.CSS
  }
  if (layers) w.CSSLayerBlockRule = function CSSLayerBlockRule() {}
  else delete w.CSSLayerBlockRule
  Object.defineProperty(w.navigator, 'language', { value: language, configurable: true })
  Object.defineProperty(w.navigator, 'userAgent', { value: ua, configurable: true })
  if (saved) w.localStorage.setItem('language', saved)
  w.eval(BROWSER_CHECK_SCRIPT)
  return { w, asked, box: () => w.document.getElementById('ov-too-old') }
}

describe('old-browser check: what it asks of the browser', () => {
  it('a browser with container queries and cascade layers: nothing shown, one CSS.supports call', () => {
    const { box, asked } = run()
    expect(box()).toBeNull()
    expect(asked).toEqual(['container-type: inline-size'])
  })

  it('no container queries (Chrome / WebView before 105, Safari before 16): the message', () => {
    expect(run({ containerQueries: false }).box()).not.toBeNull()
  })

  it('no cascade layers (before Chrome 99 / Safari 15.4: no Tailwind rule would apply): the message', () => {
    expect(run({ layers: false }).box()).not.toBeNull()
  })

  it('no CSS object, or CSS.supports throwing: the message', () => {
    expect(run({ css: false }).box()).not.toBeNull()
    expect(run({ supportsThrows: true }).box()).not.toBeNull()
  })

  it('covers the whole page, above whatever the bundle may still draw, with its own styles', () => {
    const { box, w } = run({ containerQueries: false, ua: UA.android9 })
    const b = box()
    expect(b.getAttribute('role')).toBe('alert')
    expect(b.parentNode).toBe(w.document.body)
    expect(b.style.position).toBe('fixed')
    expect(b.style.zIndex).toBe('2147483647')
    expect(b.style.background).toMatch(/#fff|rgb\(255, 255, 255\)/)
    expect(w.document.getElementById('root')).not.toBeNull()
  })

  it('run before <body> exists, it waits for it', () => {
    const { w, box } = run({ containerQueries: false, inHead: true })
    expect(box()).toBeNull()
    w.document.documentElement.appendChild(w.document.createElement('body'))
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'))
    expect(box()).not.toBeNull()
    expect(box().parentNode).toBe(w.document.body)
  })
})

describe('old-browser check: the message', () => {
  const text = (o) => run({ containerQueries: false, ...o }).box().textContent

  it('Android: update Android System WebView or Chrome, and the browser version for support', () => {
    const t = text({ ua: UA.android9 })
    expect(t).toContain("This device's browser is too old for OpenVolley.")
    expect(t).toContain('Please update “Android System WebView” (or Chrome) in the Play Store, or use a newer device.')
    expect(t).toContain('Chrome 66.0.3359.158')
    expect(t).not.toContain('Version 4.0')
  })

  it('elsewhere (an old iPad): update the browser or the system', () => {
    const t = text({ ua: UA.ipad15 })
    expect(t).toContain('Please update the browser or the system, or use a newer device.')
    expect(t).not.toContain('Play Store')
    expect(t).toContain('Safari 15.6')
  })

  it("in the browser's language, du/tu: German (de-CH too), French, Italian; English otherwise", () => {
    expect(text({ language: 'de-CH', ua: UA.android9 })).toContain('Der Browser dieses Geräts ist zu alt für OpenVolley.Aktualisiere bitte «Android System WebView» (oder Chrome) im Play Store oder nimm ein neueres Gerät.')
    expect(text({ language: 'fr-CH', ua: UA.android9 })).toContain('Le navigateur de cet appareil est trop ancien pour OpenVolley.Mets à jour « Android System WebView » (ou Chrome) dans le Play Store, ou utilise un appareil plus récent.')
    expect(text({ language: 'it-CH', ua: UA.ipad15 })).toContain('Il browser di questo dispositivo è troppo vecchio per OpenVolley.Aggiorna il browser o il sistema, oppure usa un dispositivo più recente.')
    expect(text({ language: 'es-ES' })).toContain("This device's browser is too old for OpenVolley.")
  })

  it("the app's saved language over the browser's (src/i18n: localStorage 'language')", () => {
    expect(text({ language: 'de-DE', saved: 'fr' })).toContain('trop ancien')
    expect(text({ language: 'en-US', saved: 'de-CH' })).toContain('zu alt')
  })

  it('OpenBeach on a beach host (the OpenBeach manager)', () => {
    expect(text({ url: 'https://manager-beach.openvolley.app/' })).toContain('too old for OpenBeach.')
    expect(text({ url: 'https://manager.openvolley.app/' })).toContain('too old for OpenVolley.')
  })
})

describe('old-browser check: runs where the bundle cannot', () => {
  it('ES5 only, ASCII only, nothing that ends the inline <script>', () => {
    // no arrow functions, template literals, let / const, classes, spread, ?. or ??
    expect(BROWSER_CHECK_SCRIPT).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\?\.|\?\?/)
    expect(BROWSER_CHECK_SCRIPT).toMatch(/^[\x20-\x7e]+$/)
    expect(BROWSER_CHECK_SCRIPT.toLowerCase()).not.toContain('</script')
    // the message strings are \u escapes in the page, real characters once parsed
    expect(BROWSER_CHECK_SCRIPT).toContain('Ger\\u00e4ts')
  })

  it('no eval and no new Function (the CSP forbids both: the check would fail on every browser)', () => {
    expect(BROWSER_CHECK_SCRIPT).not.toMatch(/\beval\b|Function\(/)
  })
})

describe('old-browser check: on every page, allowed by the CSP', () => {
  it('the plugin puts it at the top of every <body>, the scoresheet and the manager consoles too', () => {
    const plugin = browserCheck()
    for (const path of ['/index.html', '/referee/index.html', '/bench/index.html', '/livescore/index.html', '/upload_roster/index.html', '/scoresheet/index.html', '/dictate/index.html', '/manager.html', '/manager-beach.html', '/_build_manager.html']) {
      expect(plugin.transformIndexHtml('<html></html>', { path }), path).toEqual([{ tag: 'script', injectTo: 'body-prepend', children: BROWSER_CHECK_SCRIPT }])
    }
    expect(browserCheck({ enabled: false }).transformIndexHtml('<html></html>', { path: '/index.html' })).toBe('<html></html>')
  })

  it('both builds use it (vite.config.js: the web app, the dev server and the Android app; build-subdomains.js: every subdomain)', () => {
    expect(read('vite.config.js')).toContain('    browserCheck(),\n')
    expect(read('scripts/build-subdomains.js')).toContain('        browserCheck(),\n')
  })

  it('its hash is in the pages\' policy (_headers, the Android <meta>) and in the backend\'s', () => {
    const hash = `'sha256-${createHash('sha256').update(BROWSER_CHECK_SCRIPT, 'utf8').digest('base64')}'`
    expect(BROWSER_CHECK_HASH).toBe(hash)
    expect(contentSecurityPolicy().match(/script-src ([^;]+)/)[1].split(' ')).toContain(hash)
    const server = readFileSync(resolve(frontendDir, '../backend/server.js'), 'utf8')
    const backendScriptSrc = server.match(/"script-src ([^"]+)"/)[1].split(' ')
    expect(backendScriptSrc).toContain(hash)
  })
})
