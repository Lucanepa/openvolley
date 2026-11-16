import { describe, it, expect, afterEach, vi } from 'vitest'
import { hideImages, imageBox, isWebKitEngine, isWebKitGtk, missingPictures, picturesReady, styleListFor, usedStyleProperties, wellFormedSheet } from '../pdfCapture'

describe('isWebKitEngine', () => {
  it('every WebKit: Safari, the macOS app, WebKitGTK and all iPhone / iPad browsers; never Chromium or Firefox', () => {
    const webkit = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15',
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15'
    ]
    const other = [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0'
    ]
    for (const ua of webkit) expect(isWebKitEngine(ua), ua).toBe(true)
    for (const ua of other) expect(isWebKitEngine(ua), ua).toBe(false)
  })
})

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
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps what the sheet sets, drops UA defaults and custom properties, and cleans up', () => {
    // A browser lists every property in <html>'s computed style; jsdom 30
    // only the ones set there. Give the function a browser's kind of list.
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === document.documentElement && !pseudo
        ? (['color', 'display', 'width', '--color-x'] as unknown as CSSStyleDeclaration)
        : real(el, pseudo))
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

describe('wellFormedSheet', () => {
  it('replaces half an emoji in the text and attributes for the capture, and puts it back', () => {
    // a name cut through an emoji before the fix is still in the stored match:
    // html-to-image throws "URI malformed" on it and no PDF is made
    const root = document.createElement('div')
    root.innerHTML = '<span title="Damen 2 \ud83c">Damen 2 \ud83c</span><b>Hofmann, \ud83c. M.</b><i>🏐 Max</i>'
    const span = root.querySelector('span')!
    const undo = wellFormedSheet(root)
    expect(span.textContent).toBe('Damen 2 \ufffd')
    expect(span.getAttribute('title')).toBe('Damen 2 \ufffd')
    expect(root.querySelector('b')!.textContent).toBe('Hofmann, \ufffd. M.')
    expect(root.querySelector('i')!.textContent).toBe('🏐 Max')
    expect(() => encodeURIComponent(new XMLSerializer().serializeToString(root))).not.toThrow()
    undo()
    expect(span.textContent).toBe('Damen 2 \ud83c')
    expect(span.getAttribute('title')).toBe('Damen 2 \ud83c')
    expect(root.querySelector('b')!.textContent).toBe('Hofmann, \ud83c. M.')
  })

  it('touches nothing on a sheet without half emojis', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span title="Zürich">🏐 Max</span>'
    const html = root.innerHTML
    wellFormedSheet(root)()
    expect(root.innerHTML).toBe(html)
  })
})

describe('pictures before the capture (logo, signatures)', () => {
  const pic = (src: string | null, state: { complete?: boolean; naturalWidth?: number; decode?: () => Promise<void> } = {}) => {
    const img = document.createElement('img')
    if (src !== null) img.setAttribute('src', src)
    Object.defineProperty(img, 'complete', { configurable: true, get: () => state.complete ?? true })
    Object.defineProperty(img, 'naturalWidth', { configurable: true, get: () => state.naturalWidth ?? 0 })
    Object.defineProperty(img, 'decode', { configurable: true, value: state.decode })
    return img
  }
  const sheet = (...imgs: HTMLImageElement[]) => { const d = document.createElement('div'); imgs.forEach(i => d.appendChild(i)); return d }

  it('waits for a picture that is still loading and decoding', async () => {
    let finish!: () => void
    const state: any = { complete: false, naturalWidth: 0 }
    state.decode = () => new Promise<void>(r => { finish = () => { state.complete = true; state.naturalWidth = 400; r() } })
    const img = pic('/logo.svg', state)
    let ready = false
    const p = picturesReady(sheet(img), 5000).then(() => { ready = true })
    await new Promise(r => setTimeout(r, 20))
    expect(ready).toBe(false)
    finish()
    await p
    expect(ready).toBe(true)
    expect(missingPictures(sheet(img))).toHaveLength(0)
  })

  it('without decode(): the load or error event', async () => {
    const img = pic('/sig.png', { complete: false })
    let ready = false
    const p = picturesReady(sheet(img), 5000).then(() => { ready = true })
    await new Promise(r => setTimeout(r, 10))
    expect(ready).toBe(false)
    img.dispatchEvent(new Event('error'))
    await p
    expect(ready).toBe(true)
  })

  it('never waits longer than the limit, and names the picture that did not come', async () => {
    const stuck = pic('/slow.png', { complete: false, decode: () => new Promise<void>(() => {}) })
    stuck.alt = 'Captain A signature'
    const broken = pic('data:image/png;base64,xx', { complete: true, naturalWidth: 0, decode: () => Promise.reject(new Error('broken')) })
    const fine = pic('/ok.png', { complete: true, naturalWidth: 10, decode: () => Promise.resolve() })
    const none = pic(null)
    const root = sheet(stuck, broken, fine, none)
    const t0 = Date.now()
    await picturesReady(root, 60)
    expect(Date.now() - t0).toBeLessThan(1000)
    // an <img> without a source is not a missing picture
    expect(missingPictures(root)).toEqual([stuck, broken])
  })
})
