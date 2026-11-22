import { describe, it, expect, afterEach, vi } from 'vitest'
import { ANDROID_APP_CAPTURE_PIXEL_RATIO, CAPTURE_PIXEL_RATIO, capturePixelRatio, fontFaceRules, hideImages, imageBox, isWebKitEngine, isWebKitGtk, missingPictures, nextFrames, physicalOf, picturesReady, resetSheetFontEmbedCSS, SHEET_FONT_FAMILY, sheetFontEmbedCSS, styleListFor, usedStyleProperties, wellFormedSheet, withoutLogicalAliases } from '../pdfCapture'

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

  it('copies the physical properties, not their logical second names', () => {
    const real = window.getComputedStyle.bind(window)
    const sides = ['top', 'right', 'bottom', 'left']
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === document.documentElement && !pseudo
        ? ([...sides.map(s => `margin-${s}`), 'margin-inline-start', 'margin-block-end'] as unknown as CSSStyleDeclaration)
        : real(el, pseudo))
    document.body.innerHTML = '<div id="sheet"><p style="margin: 3px 4px">A</p></div>'
    const used = usedStyleProperties(document.getElementById('sheet')!)
    expect(used).toEqual(expect.arrayContaining(['margin-top', 'margin-left']))
    expect(used).not.toContain('margin-inline-start')
    expect(used).not.toContain('margin-block-end')
  })
})

describe('logical properties (WebKit spent ~6 s rewriting them over their physical ones)', () => {
  it('names the physical property each logical one stands for in horizontal-tb', () => {
    expect(physicalOf('margin-inline-start')).toBe('margin-left')
    expect(physicalOf('border-block-end-color')).toBe('border-bottom-color')
    expect(physicalOf('border-inline-end-width')).toBe('border-right-width')
    expect(physicalOf('scroll-padding-block-start')).toBe('scroll-padding-top')
    expect(physicalOf('inset-inline-end')).toBe('right')
    expect(physicalOf('inline-size')).toBe('width')
    expect(physicalOf('max-block-size')).toBe('max-height')
    expect(physicalOf('contain-intrinsic-inline-size')).toBe('contain-intrinsic-width')
    expect(physicalOf('border-end-start-radius')).toBe('border-bottom-left-radius')
    expect(physicalOf('overflow-block')).toBe('overflow-y')
    expect(physicalOf('overscroll-behavior-inline')).toBe('overscroll-behavior-x')
    for (const p of ['margin-left', 'width', 'display', 'block-step-size', 'text-box-edge', 'border-bottom-width']) expect(physicalOf(p), p).toBeNull()
  })

  it('leaves a logical one out only when every side it can stand for is listed', () => {
    const borders = ['top', 'right', 'bottom', 'left'].map(s => `border-${s}-width`)
    expect(withoutLogicalAliases([...borders, 'border-block-end-width', 'color'])).toEqual([...borders, 'color'])
    // a vertical writing mode makes block-end left or right: without them it stays
    expect(withoutLogicalAliases(['border-bottom-width', 'border-block-end-width'])).toEqual(['border-bottom-width', 'border-block-end-width'])
    expect(withoutLogicalAliases(['width', 'height', 'inline-size', 'min-block-size'])).toEqual(['width', 'height', 'min-block-size'])
    expect(withoutLogicalAliases(['overflow-x', 'overflow-y', 'overflow-inline'])).toEqual(['overflow-x', 'overflow-y'])
  })
})

describe('the sheet font for the capture (only its own, built once)', () => {
  // jsdom's CSSOM drops a @font-face's src: the page's stylesheets as a browser lists them
  const face = (family: string, src: string, sheetHref: string | null = null) => ({
    type: 5,
    style: { getPropertyValue: (p: string) => (p === 'font-family' ? `"${family}"` : '') },
    cssText: `@font-face { font-family: "${family}"; src: ${src} format("woff2"); }`,
    parentStyleSheet: { href: sheetHref }
  })
  const pageSheets = [
    { href: null, cssRules: [face('OV Sheet Inter', 'url("/fonts/inter-latin.woff2")'), { type: 1, cssText: '.x { color: red }' }] },
    // in a build the CSS is a file of its own: its url()s are relative to it
    { href: 'http://localhost:3000/assets/index.css', cssRules: [{ type: 4, cssRules: [face('OV Sheet Inter', 'url(inter-cyrillic.woff2)', 'http://localhost:3000/assets/index.css')] }] },
    // the app's own fonts on the manager page: never in the PDF
    { href: null, cssRules: [face('Inter Variable', 'url("/fonts/app-inter.woff2")'), face('Orbitron', 'url("/fonts/orbitron.woff2")')] },
    // another origin's stylesheet cannot be read
    { href: 'https://fonts.example/x.css', get cssRules (): never { throw new DOMException('cross-origin', 'SecurityError') } }
  ]
  const fetched: string[] = []
  const okFetch = vi.fn(async (url: string) => {
    fetched.push(url)
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([119, 79, 70, 50])], { type: 'font/woff2' }) }
  })
  const withSheets = (sheets: unknown[]) => Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => sheets })
  afterEach(() => {
    delete (document as any).styleSheets
    fetched.length = 0
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetSheetFontEmbedCSS()
  })

  it('reads the @font-face rules of the sheet family only, also inside @media and @layer', () => {
    withSheets(pageSheets)
    const faces = fontFaceRules(document, SHEET_FONT_FAMILY)
    expect(faces).toHaveLength(2)
    expect(faces.map(f => f.cssText).join(' ')).not.toMatch(/app-inter|orbitron/)
  })

  it('inlines every file of the sheet font, fetches nothing else, and builds it once', async () => {
    withSheets(pageSheets)
    vi.stubGlobal('fetch', okFetch)
    const css = await sheetFontEmbedCSS()
    expect(css).not.toBeNull()
    expect(css!.match(/@font-face/g)).toHaveLength(2)
    expect(css).toMatch(/OV Sheet Inter/)
    expect(css).not.toMatch(/Inter Variable|Orbitron/)
    // every url() is a data: URL: nothing left to fetch from inside the SVG
    expect(css!.match(/url\(/g)).toHaveLength(2)
    expect(css!.match(/url\("data:font\/woff2;base64,/g)).toHaveLength(2)
    expect(fetched.map(u => new URL(u).pathname).sort()).toEqual(['/assets/inter-cyrillic.woff2', '/fonts/inter-latin.woff2'])
    // the next capture takes the same CSS without fetching again
    expect(await sheetFontEmbedCSS()).toBe(css)
    expect(fetched).toHaveLength(2)
  })

  it('a file that cannot be read: null (html-to-image embeds the fonts itself), and the next capture tries again', async () => {
    withSheets(pageSheets)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })))
    expect(await sheetFontEmbedCSS()).toBeNull()
    // an app's fallback page served for the font's path is not a font either
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['<!doctype html>'], { type: 'text/html' }) })))
    expect(await sheetFontEmbedCSS()).toBeNull()
    vi.stubGlobal('fetch', okFetch)
    expect(await sheetFontEmbedCSS()).toMatch(/data:font\/woff2/)
  })

  it('no sheet font on the page: null, nothing fetched', async () => {
    withSheets([pageSheets[2]])
    vi.stubGlobal('fetch', okFetch)
    expect(await sheetFontEmbedCSS()).toBeNull()
    expect(fetched).toHaveLength(0)
  })
})

describe('nextFrames', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('ends after two frames', async () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
    let done = false
    const p = nextFrames(5000).then(() => { done = true })
    queue.shift()!(0)
    await Promise.resolve()
    expect(done).toBe(false)
    queue.shift()!(16)
    await p
    expect(done).toBe(true)
  })
  it('a hidden tab gets no frames: it ends at the limit', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    const t0 = Date.now()
    await nextFrames(30)
    expect(Date.now() - t0).toBeLessThan(1000)
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

  it('every picture already loaded: no wait for the limit', async () => {
    const fine = () => pic('/ok.png', { complete: true, naturalWidth: 10, decode: () => Promise.resolve() })
    const t0 = Date.now()
    await picturesReady(sheet(fine(), fine(), fine(), pic(null)), 3000)
    expect(Date.now() - t0).toBeLessThan(500)
    // no picture with a source at all: nothing to wait for either
    const t1 = Date.now()
    await picturesReady(sheet(pic(null)), 3000)
    expect(Date.now() - t1).toBeLessThan(500)
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

// The capture's pixel ratio (owner 22.11.2026): 1.5 in the Android app only,
// the page itself or the sheet in the app's in-app view (a same-origin
// iframe: the app's window holds Capacitor); 2 everywhere else
describe('capturePixelRatio', () => {
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T220 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36'
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const appWindow = (native: boolean, userAgent: string, extra: Record<string, unknown> = {}): any => {
    const w: any = { navigator: { userAgent }, ...extra }
    w.parent = w
    w.frameElement = null
    if (native) w.Capacitor = { isNativePlatform: () => true }
    return w
  }
  // the sheet in the in-app view: an iframe marked data-ov-app-window
  const inView = (app: any): any => ({ parent: app, frameElement: { hasAttribute: (a: string) => a === 'data-ov-app-window' }, navigator: { userAgent: app.navigator.userAgent } })

  it('is 2 and 1.5', () => {
    expect(CAPTURE_PIXEL_RATIO).toBe(2)
    expect(ANDROID_APP_CAPTURE_PIXEL_RATIO).toBe(1.5)
  })

  it('1.5 in the Android app: its own page and the sheet in its in-app view', () => {
    const android = appWindow(true, ANDROID_UA)
    expect(capturePixelRatio(android)).toBe(1.5)
    expect(capturePixelRatio(inView(android))).toBe(1.5)
  })

  it('2 on the web (Android\'s Chrome too), in the iOS app, the desktop apps and the server render', () => {
    expect(capturePixelRatio(appWindow(false, ANDROID_UA))).toBe(2)
    expect(capturePixelRatio(inView(appWindow(false, ANDROID_UA)))).toBe(2)
    expect(capturePixelRatio(appWindow(true, IPAD_UA))).toBe(2)
    expect(capturePixelRatio(inView(appWindow(true, IPAD_UA)))).toBe(2)
    expect(capturePixelRatio(appWindow(false, DESKTOP_UA, { __TAURI__: {} }))).toBe(2)
    // headless Chromium, the render service and the pixel check (Playwright)
    expect(capturePixelRatio(appWindow(false, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36'))).toBe(2)
    // jsdom's own window
    expect(capturePixelRatio(window)).toBe(2)
    expect(capturePixelRatio(undefined)).toBe(2)
  })
})
