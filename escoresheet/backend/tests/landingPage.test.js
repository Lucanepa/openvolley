// The status page at '/' (lib/landingPage.js) and its icons (lib/icons.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderLandingPage, escapeHtml, INDOOR_ROLES, BEACH_ROLES } from '../lib/landingPage.js'
import { ICONS, icon } from '../lib/icons.js'
import { BRAND_MARK, brandMark } from '../lib/brandMark.js'

const BASE = 'http://192.168.1.20:8080'
const withQr = (roles) => roles.map((r) => ({ ...r, url: `${BASE}${r.path}`, svg: '<svg data-qr="1"></svg>' }))

function render(overrides = {}) {
  return renderLandingPage({
    baseUrl: BASE,
    clientCount: 1,
    matchCount: 2,
    indoor: withQr(INDOOR_ROLES),
    beach: withQr(BEACH_ROLES),
    matches: [],
    formatTime: () => '21:45:53',
    ...overrides
  })
}

/** Anything the page would fetch or run: it must be self-contained (venue LAN, no internet). */
function remoteResources(html) {
  const found = []
  for (const m of html.matchAll(/<(script|link|img|iframe|object|embed|source|video|audio)\b[^>]*>/gi)) found.push(m[0])
  for (const m of html.matchAll(/@import|url\(\s*['"]?(?!#)[^)]*\)/gi)) found.push(m[0])
  for (const m of html.matchAll(/\s(?:src|srcset|poster)\s*=/gi)) found.push(m[0])
  return found
}

describe('landing page', () => {
  it('keeps every role, its QR code and its link', () => {
    const html = render()
    for (const r of [...INDOOR_ROLES, ...BEACH_ROLES]) {
      assert.ok(html.includes(`>${r.label}</h3>`), r.label)
      assert.ok(html.includes(`<a href="${escapeHtml(BASE + r.path)}">`), r.path)
    }
    assert.equal(html.match(/data-qr="1"/g).length, INDOOR_ROLES.length + BEACH_ROLES.length)
    assert.match(html, /Indoor volleyball/)
    assert.match(html, /Beach volleyball/)
    assert.match(html, /How to connect/)
    assert.ok(html.includes(BASE))
  })

  it('shows the live counts with the right plural', () => {
    assert.match(render(), /1 connected client</)
    assert.match(render(), /2 active matches</)
    const one = render({ clientCount: 0, matchCount: 1 })
    assert.match(one, /0 connected clients</)
    assert.match(one, /1 active match</)
    assert.match(one, /Server running/)
  })

  it('lists active matches only when there are some', () => {
    assert.doesNotMatch(render(), /Active matches/)
    const html = render({ matches: [{ home: 'Volley Näfels', away: 'Lausanne UC', updatedAt: 1 }, { home: 'A', away: 'B' }] })
    assert.match(html, /Active matches/)
    assert.match(html, /Volley Näfels vs Lausanne UC/)
    assert.match(html, /21:45:53/)
  })

  it('escapes team names and the Host header (any scoreboard socket can name a team)', () => {
    const html = render({
      baseUrl: 'http://evil"><script>x</script>',
      matches: [{ home: '<img src=x onerror=alert(1)>', away: 'B & "C"', updatedAt: 1 }]
    })
    assert.ok(!html.includes('<img'))
    assert.ok(!html.includes('<script'))
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; vs B &amp; &quot;C&quot;'))
  })

  it('loads nothing from anywhere: no scripts, stylesheets, images or fonts', () => {
    const html = render({ matches: [{ home: 'A', away: 'B', updatedAt: 1 }] })
    assert.deepEqual(remoteResources(html), [])
    assert.doesNotMatch(html, /https?:\/\/(?!192\.168\.1\.20:8080|www\.w3\.org\/2000\/svg)/)
  })

  it('draws its icons from the packs (no emoji, no hand-drawn whistle)', () => {
    const html = render()
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    for (const name of ['whistle', 'house', 'plane', 'clipboard-list', 'tv', 'tree-palm', 'smartphone', 'volleyball']) {
      const firstShape = ICONS[name].slice(ICONS[name].indexOf('>') + 1, ICONS[name].indexOf('/>') + 2)
      assert.ok(html.includes(firstShape), name)
    }
  })
})

describe('brand mark', () => {
  it('heads the page with the OpenVolley ball, inline', () => {
    const html = render()
    assert.ok(html.includes(`<div class="title">${brandMark({ size: 32 })}<h1>OpenVolley server</h1></div>`))
    assert.match(BRAND_MARK, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/)
    assert.equal(BRAND_MARK.match(/<path /g).length, 3)
    assert.ok(BRAND_MARK.includes('fill="#e2001a"'), 'one red panel group')
  })

  it('is decorative: sized, hidden from screen readers (the h1 names it)', () => {
    assert.match(brandMark({ size: 20 }), /^<svg class="brand-mark" width="20" height="20" aria-hidden="true" focusable="false" xmlns=/)
  })

  it('is generated from the frontend\'s brand/mark.svg', async () => {
    const { readFile } = await import('node:fs/promises')
    const svg = await readFile(new URL('../../frontend/brand/mark.svg', import.meta.url), 'utf8')
    for (const d of BRAND_MARK.match(/ d="[^"]+"/g)) assert.ok(svg.includes(d), 'same paths as brand/mark.svg')
  })
})

describe('icons', () => {
  it('sizes an icon, hides it from screen readers, and keeps the pack geometry', () => {
    const svg = icon('smartphone', { size: 28, className: 'x' })
    assert.match(svg, /^<svg class="x" width="28" height="28" aria-hidden="true" focusable="false" /)
    assert.ok(svg.includes('<rect width="14" height="20" x="5" y="2" rx="2" ry="2" />'), 'inner geometry untouched')
    assert.equal(svg.match(/<svg/g).length, 1)
    assert.equal(svg.match(/\swidth=/g).length, 2) // the svg's own and the rect's
  })

  it('throws on an unknown icon', () => {
    assert.throws(() => icon('nope'), /unknown icon/)
  })
})
