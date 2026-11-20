/**
 * Old-browser check: an inline script at the top of each page's <body> that
 * runs before the app's bundle and, on a browser too old for the app, shows
 * a plain message instead of the white page that browser would otherwise
 * be left with. On Android 9's own WebView (Chrome 66) the bundle stops at
 * its first `?.` ("Unexpected token .", emulator check of 2026-11-20) and
 * nothing at all is drawn. Shared by vite.config.js (main multi-page build,
 * dev server, the Android app) and scripts/build-subdomains.js (per-app
 * builds, the manager consoles included); allowed by its hash in the
 * Content-Security-Policy (csp.js, and the backend's in server.js).
 *
 * What it asks of the browser, the floor the build is made for
 * (build-target.js: Chrome 107, Safari 16, Firefox 104) and below which the
 * app cannot work:
 *   - CSS container queries (Chrome / Android WebView 105, Safari 16.0,
 *     Firefox 110): the stylesheet uses them (the portrait roster cards and
 *     others), and no browser has them without everything older the bundle
 *     needs (`?.` and `??`: Chrome 80, Safari 13.1, Firefox 74);
 *   - cascade layers (CSSLayerBlockRule: Chrome 99, Safari 15.4, Firefox 97):
 *     every Tailwind rule sits in a layer; without them none applies.
 * Not Chrome 111 / Safari 16.4 (Tailwind 4's own list): the build lowers the
 * oklch() colours and keeps color-mix() behind @supports, so the WebViews
 * the build target names still get the app.
 * The JavaScript syntax is not tested itself: that takes eval or
 * new Function, which the CSP forbids (it would throw on every browser).
 *
 * ES5 only (it has to run where the bundle cannot), ASCII only (\u escapes,
 * so the hash holds whatever the page's encoding), no app CSS (inline
 * styles: the stylesheet may not apply). A modern browser runs one
 * CSS.supports() call and nothing else: no flash, no wait.
 * The message is in the app's language (its saved 'language', else the
 * browser's: src/i18n), du/tu, and names what to update: Android System
 * WebView or Chrome on Android, else the browser or the system. Below it,
 * small, the browser's version from its user agent (for a support mail).
 * OpenBeach on a beach host (the OpenBeach manager), else OpenVolley.
 */
export const BROWSER_CHECK_SCRIPT = `(function(){var w=window,d=document,c=w.CSS;try{if(c&&c.supports&&c.supports('container-type','inline-size')&&w.CSSLayerBlockRule)return}catch(e){}var n=navigator,l='';try{l=localStorage.getItem('language')||''}catch(e){}l=String(l||n.language||'').slice(0,2).toLowerCase();var m={en:["This device's browser is too old for %.","Please update \\u201cAndroid System WebView\\u201d (or Chrome) in the Play Store, or use a newer device.","Please update the browser or the system, or use a newer device."],de:["Der Browser dieses Ger\\u00e4ts ist zu alt f\\u00fcr %.","Aktualisiere bitte \\u00abAndroid System WebView\\u00bb (oder Chrome) im Play Store oder nimm ein neueres Ger\\u00e4t.","Aktualisiere bitte den Browser oder das System oder nimm ein neueres Ger\\u00e4t."],fr:["Le navigateur de cet appareil est trop ancien pour %.","Mets \\u00e0 jour \\u00ab\\u00a0Android System WebView\\u00a0\\u00bb (ou Chrome) dans le Play Store, ou utilise un appareil plus r\\u00e9cent.","Mets \\u00e0 jour le navigateur ou le syst\\u00e8me, ou utilise un appareil plus r\\u00e9cent."],it:["Il browser di questo dispositivo \\u00e8 troppo vecchio per %.","Aggiorna \\u00abAndroid System WebView\\u00bb (o Chrome) nel Play Store, oppure usa un dispositivo pi\\u00f9 recente.","Aggiorna il browser o il sistema, oppure usa un dispositivo pi\\u00f9 recente."]},t=m[l]||m.en,u=n.userAgent||'',a=/beach/i.test(location.hostname+location.pathname)?'OpenBeach':'OpenVolley',v=(/(Chrome|Firefox)\\/[\\d.]+/.exec(u)||/Version\\/[\\d.]+/.exec(u)||[''])[0].replace('Version','Safari').replace('/',' ');function s(){var b=d.body||d.documentElement,x=d.createElement('div');x.id='ov-too-old';x.setAttribute('role','alert');x.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:auto;background:#fff;color:#1c1917;font:16px/1.5 sans-serif;text-align:center;padding:48px 20px';function p(y,z){var e=d.createElement('p');e.style.cssText='margin:0 auto 12px;padding:0;max-width:30em;color:#1c1917;font:16px/1.5 sans-serif;text-align:center;'+z;e.appendChild(d.createTextNode(y));x.appendChild(e)}p(t[0].replace('%',a),'font-size:20px;font-weight:700');p(/Android/i.test(u)?t[1]:t[2],'');if(v)p(v,'font-size:13px;color:#78716c');b.insertBefore(x,b.firstChild)}if(d.body)s();else d.addEventListener('DOMContentLoaded',s)})()`

/**
 * The vite plugin: the check at the top of every page's <body> (after the
 * <head>, so a long inline script never pushes <meta charset> out of the
 * first 1024 bytes, and below the Android build's CSP <meta>).
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 */
export function browserCheck({ enabled = true } = {}) {
  return {
    name: 'browser-check',
    transformIndexHtml(html) {
      if (!enabled) return html
      return [{ tag: 'script', injectTo: 'body-prepend', children: BROWSER_CHECK_SCRIPT }]
    }
  }
}
