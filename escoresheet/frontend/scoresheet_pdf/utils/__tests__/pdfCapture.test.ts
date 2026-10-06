import { describe, it, expect, afterEach } from 'vitest'
import { hideImages, imageBox, isWebKitGtk, styleListFor, usedStyleProperties } from '../pdfCapture'

describe('isWebKitGtk', () => {
  it('is the Linux WebKit engine only', () => {
    // Tauri on Linux / MiniBrowser / Epiphany
    expect(isWebKitGtk('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15')).toBe(true)
    // Chrome on Linux, Android WebView, Windows WebView2, macOS Safari, iOS, Firefox
    expect(isWebKitGtk('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe(false)
    expect(isWebKitGtk('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe(false)
    expect(isWebKitGtk('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe(false)
    expect(isWebKitGtk('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe(false)
    expect(isWebKitGtk('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe(false)
    expect(isWebKitGtk('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe(false)
  })
})

describe('styleListFor', () => {
  it('always hands out the same array, refilled (html-to-image caches the first one)', () => {
    const a = styleListFor(['color', 'width'])
    const b = styleListFor(['display'])
    expect(b).toBe(a)
    expect(b).toEqual(['display'])
  })
})

describe('usedStyleProperties', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('keeps what the sheet sets, drops UA defaults and custom properties, and cleans up', () => {
    document.body.innerHTML = '<div id="sheet" style="--color-x: red"><span style="color: rgb(255, 0, 0)">A</span><div style="display: flex">B</div></div>'
    const used = usedStyleProperties(document.getElementById('sheet')!)
    expect(used).toContain('color')
    expect(used).toContain('display')
    expect(used.some((p) => p.startsWith('--'))).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
  })
})

describe('imageBox (object-fit, centred)', () => {
  const box = { x: 10, y: 20, w: 100, h: 20 }
  it('contain fits the whole picture, centred', () => {
    expect(imageBox('contain', box, { w: 400, h: 100 })).toEqual({ x: 20, y: 20, w: 80, h: 20 })
  })
  it('fill stretches to the box', () => {
    expect(imageBox('fill', box, { w: 400, h: 100 })).toEqual(box)
  })
  it('cover fills the box and spills over', () => {
    expect(imageBox('cover', box, { w: 400, h: 100 })).toEqual({ x: 10, y: 17.5, w: 100, h: 25 })
  })
  it('none keeps the natural size, scale-down never enlarges', () => {
    expect(imageBox('none', box, { w: 40, h: 10 })).toEqual({ x: 40, y: 25, w: 40, h: 10 })
    expect(imageBox('scale-down', box, { w: 40, h: 10 })).toEqual({ x: 40, y: 25, w: 40, h: 10 })
    expect(imageBox('scale-down', box, { w: 400, h: 100 })).toEqual({ x: 20, y: 20, w: 80, h: 20 })
  })
})

describe('hideImages', () => {
  it('hides for the capture and puts back what was there', () => {
    const a = document.createElement('img')
    const b = document.createElement('img')
    b.style.setProperty('visibility', 'visible')
    const show = hideImages([a, b])
    expect(a.style.visibility).toBe('hidden')
    expect(b.style.getPropertyPriority('visibility')).toBe('important')
    show()
    expect(a.style.visibility).toBe('')
    expect(b.style.visibility).toBe('visible')
  })
})
