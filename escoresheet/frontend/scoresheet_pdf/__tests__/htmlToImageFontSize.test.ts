// html-to-image copied every font-size as floor(px) - 0.1, so the PDF printed
// the sheet's text smaller than it is (8.5px -> 7.9px). The Vite plugin turns
// that branch off in every build; these tests fail when an html-to-image update
// brings the shrinking back in a form the plugin no longer recognises.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { keepFontSize, htmlToImageFontSize } from '../../vite-plugin-html-to-image-font-size.js'

const require = createRequire(import.meta.url)
const pkgDir = dirname(require.resolve('html-to-image/package.json'))
const BUILDS = ['es/clone-node.js', 'lib/clone-node.js', 'dist/html-to-image.js']
const SHRINK = /Math\.floor\(\s*parseFloat\([^;]*?\)\s*\)\s*-\s*0?\.1\b/

describe('html-to-image keeps font-size (vite-plugin-html-to-image-font-size)', () => {
  it.each(BUILDS)('turns the font-size branch off in %s', (file) => {
    const code = readFileSync(join(pkgDir, file), 'utf8')
    const out = keepFontSize(code, file)
    // every shrinking left is behind `false &&`
    const live = out.split(/\r?\n/).filter(l => /font-size/.test(l) && /endsWith/.test(l) && !/false \/\* OpenVolley/.test(l))
    expect(live).toEqual([])
    expect(out).not.toBe(code)
    expect(SHRINK.test(out)).toBe(true) // the code is still there, only never run
  })

  it('leaves code without the shrinking alone', () => {
    const code = "if (name === 'font-size' && value.endsWith('px')) { value = value; }"
    expect(keepFontSize(code)).toBe(code)
  })

  it('fails the build when the shrinking is there in a form it does not know', () => {
    const code = "if (prop == 'font-size') { v = `${Math.floor(parseFloat(v)) - 0.1}px`; }"
    expect(() => keepFontSize(code, 'x.js')).toThrow(/html-to-image changed/)
  })

  it('transforms only html-to-image', () => {
    const plugin = htmlToImageFontSize() as { transform: (code: string, id: string) => unknown }
    const code = readFileSync(join(pkgDir, 'es/clone-node.js'), 'utf8')
    expect(plugin.transform(code, '/x/src/clone-node.js')).toBeNull()
    expect(plugin.transform(code, join(pkgDir, 'es/clone-node.js'))).toMatchObject({ code: expect.stringContaining('OpenVolley: keep font-size') })
  })

  it('the clone keeps an 8.5px font-size (toSvg through the plugin)', async () => {
    const { toSvg } = await import('html-to-image')
    // jsdom has no SVGImageElement, which html-to-image's image pass checks for
    const g = globalThis as any
    const hadSvgImage = 'SVGImageElement' in g
    if (!hadSvgImage) g.SVGImageElement = class {}
    const el = document.createElement('div')
    el.style.fontSize = '8.5px'
    el.style.width = '40px'
    el.style.height = '10px'
    el.textContent = '02.10.2005'
    document.body.appendChild(el)
    // the branch runs only when the computed style has no cssText, as in
    // Chromium and WebKit: jsdom fills it, so hide it as they do
    const real = window.getComputedStyle
    window.getComputedStyle = ((node: Element) => {
      // (jsdom has no pseudo-element styles: the element's own, whose empty content skips them)
      const cs = real.call(window, node)
      return new Proxy(cs, {
        get: (t, k) => (k === 'cssText' ? '' : typeof (t as any)[k] === 'function' ? (t as any)[k].bind(t) : (t as any)[k])
      })
    }) as typeof window.getComputedStyle
    try {
      const url = await toSvg(el, { skipFonts: true, includeStyleProperties: ['font-size', 'width', 'height'] })
      const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
      expect(svg).toMatch(/font-size:\s*8\.5px/)
      expect(svg).not.toMatch(/font-size:\s*7\.9px/)
    } finally {
      window.getComputedStyle = real
      if (!hadSvgImage) delete g.SVGImageElement
      el.remove()
    }
  })
})
