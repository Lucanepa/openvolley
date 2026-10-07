// @vitest-environment node
// The logo files (rendered from brand/ by scripts/make-brand-assets.py) and
// every place that links to them.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { PWA_ICONS, PWA_INCLUDE_ASSETS } from '../../pwa-workbox.js'
import { subdomains, htmlFor } from '../../scripts/build-subdomains.js'

const frontendDir = resolve(__dirname, '../..')
const pub = (p) => resolve(frontendDir, 'public', p)

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const b = readFileSync(path)
  expect(b.subarray(1, 4).toString()).toBe('PNG')
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

const HEAD_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />'
]

const PAGES = ['index.html', 'manager.html', 'referee/index.html', 'bench/index.html', 'livescore/index.html',
  'scoresheet/index.html', 'upload_roster/index.html', 'scoresheet_pdf/index_scoresheet.html']

describe('brand assets', () => {
  it('every page head links the favicon (ico + svg) and the apple-touch icon', () => {
    for (const page of PAGES) {
      const html = readFileSync(resolve(frontendDir, page), 'utf8')
      for (const link of HEAD_LINKS) expect(html, page).toContain(link)
    }
    for (const name of Object.keys(subdomains)) {
      const html = htmlFor(subdomains[name])
      for (const link of HEAD_LINKS) expect(html, name).toContain(link)
    }
  })

  it('the linked files exist, at their sizes', () => {
    expect(existsSync(pub('favicon.ico'))).toBe(true)
    expect(readFileSync(pub('favicon.svg'), 'utf8')).toMatch(/^<svg [^>]*viewBox="0 0 512 512"/)
    expect(pngSize(pub('apple-touch-icon.png'))).toEqual([180, 180])
    for (const icon of PWA_ICONS) {
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(pngSize(pub(icon.src)), icon.src).toEqual([w, h])
    }
    for (const asset of PWA_INCLUDE_ASSETS.filter((a) => !a.includes('*'))) {
      expect(existsSync(pub(asset)), asset).toBe(true)
    }
    expect(PWA_ICONS.map((i) => i.purpose)).toEqual(['any', 'any', 'maskable', 'maskable'])
  })

  it('public/favicon.svg is brand/favicon.svg (the generator copies it)', () => {
    expect(readFileSync(pub('favicon.svg'), 'utf8')).toBe(readFileSync(resolve(frontendDir, 'brand/favicon.svg'), 'utf8'))
  })

  it('the old green logo files are gone', () => {
    for (const old of ['openvolley_no_bg.png', 'openvolley_dark_bg.png', 'openvolley_icon_192.png', 'openvolley_icon_512.png']) {
      expect(existsSync(pub(old)), old).toBe(false)
    }
  })

  it('the Android adaptive icons carry a monochrome layer (themed icons)', () => {
    for (const xml of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      const text = readFileSync(resolve(frontendDir, 'android/app/src/main/res/mipmap-anydpi-v26', xml), 'utf8')
      expect(text).toContain('<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>')
    }
    for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      expect(existsSync(resolve(frontendDir, `android/app/src/main/res/mipmap-${d}/ic_launcher_monochrome.png`)), d).toBe(true)
    }
  })
})
