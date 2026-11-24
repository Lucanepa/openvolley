// Which CSS properties html-to-image copies onto the cloned scoresheet.
//
// html-to-image draws the sheet by cloning it into an SVG <foreignObject> and
// copying every computed style property inline onto every cloned element, then
// loading that SVG from a data: URL. The sheet has ~4,700 elements, and WebKit
// lists ~600 properties per element (its computed style also enumerates every
// Tailwind custom property, --color-*), so the data URL is ~87 MB. WebKitGTK
// (the Linux desktop app) refuses data URLs above ~64 MB, and a blob: URL
// taints the canvas, so "Save PDF" failed there.
//
// usedStyleProperties() keeps only the properties that matter for this sheet:
// those where at least one element's computed value differs from what the same
// element gets from the browser's own stylesheet alone (a bare element of the
// same tag in an empty standards-mode iframe). A property every element has at
// its UA default renders the same without being written out, so dropping it
// does not change the picture. Custom properties (--*) are always dropped: the
// copied values are already resolved, nothing in the clone reads a var().
// On WebKitGTK this brings the SVG from ~87 MB to ~18 MB.
//
// It is also what makes the capture fast, so every engine uses it (2026-11-16):
// Chromium (Brave, Chrome, Edge, Android) took the full copy, ~750 properties
// on each of the ~4,400 elements in the manager (275 of them the app's custom
// properties), a ~100 MB SVG that took ~9.5 s to clone, serialise and decode
// on a fast desktop; the lean copy is ~100 properties and ~12 MB (~1 s).

import { wellFormedText } from '../../src/utils/stringUtils.js';
import { LIGHT_PDF_PIXEL_RATIO, pdfSharpFor, SHARP_PDF_PIXEL_RATIO } from '../../src/utils/lookSettings.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** WebKitGTK (Linux desktop app, Epiphany): WebKit on Linux, not Chromium. */
export function isWebKitGtk(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /AppleWebKit/.test(ua) && /(X11|Linux)/.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android)/.test(ua);
}

/**
 * Any WebKit engine: WebKitGTK, Safari and the macOS desktop app (WKWebView),
 * and every browser on iPhone / iPad (Chrome, Firefox and Edge there are WebKit
 * too: CriOS, FxiOS, EdgiOS). All of them refuse the full capture and paint the
 * pictures nested in the SVG only now and then, so the saved sheet lost its logo
 * and signatures on Safari (2026-10-13); they take the lean capture with the
 * pictures drawn afterwards, as WebKitGTK did.
 */
export function isWebKitEngine(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  if (/(iPhone|iPad|iPod)/.test(ua)) return true;
  // WebKit itself says AppleWebKit/605 and later; Chromium (and jsdom) keep 537.36
  const v = /AppleWebKit\/(\d+)/.exec(ua);
  return !!v && Number(v[1]) >= 600 && !/(Chrome|Chromium|Edg|OPR|Android|SamsungBrowser)/.test(ua);
}

/**
 * The capture's pixel ratio: 2, ~190 dpi on A3, sharp enough for print, a
 * reasonable file size; or 1.5 (~145 dpi), about half the pixels to draw,
 * encode and hold, where the hall tablet (Galaxy Tab A7 Lite) took 43 s for
 * the approval's PDF. Options › Effects and speed › Sharp PDF
 * (utils/lookSettings pdfSharpFor), read here when the PDF is made; never set,
 * today's default: 1.5 in the Android app (owner 22.11.2026), 2 on the web,
 * the desktop apps, iOS, the server render and the pixel check (a fresh
 * browser: nothing stored). The sheet is placed on the page in mm (SHEET_MM):
 * only the picture's resolution changes.
 */
export const CAPTURE_PIXEL_RATIO = SHARP_PDF_PIXEL_RATIO;
export const ANDROID_APP_CAPTURE_PIXEL_RATIO = LIGHT_PDF_PIXEL_RATIO;
export function capturePixelRatio(win: Window | undefined = typeof window !== 'undefined' ? window : undefined): number {
  return pdfSharpFor(win as (Window & typeof globalThis) | undefined) ? CAPTURE_PIXEL_RATIO : ANDROID_APP_CAPTURE_PIXEL_RATIO;
}

/** What html-to-image copies by default: every property of a computed style. */
export function allStyleProperties(doc: Document = document): string[] {
  return Array.from(doc.defaultView!.getComputedStyle(doc.documentElement));
}

// html-to-image keeps the first property list it is given for the rest of the
// page's life (module-level cache, by reference). Every capture therefore
// passes this one array, refilled for that capture.
const sharedList: string[] = [];

/** The array to pass as includeStyleProperties, filled with `props`. */
export function styleListFor(props: string[]): string[] {
  sharedList.length = 0;
  sharedList.push(...props);
  return sharedList;
}

// Pictures (logos, signatures) inside the SVG are a second WebKitGTK problem:
// it paints an <img> nested in an SVG image only now and then (seen: missing
// on the first capture, and even on a redraw of an already-good one). So on
// WebKitGTK the pictures are hidden in the capture and drawn onto the canvas
// from the page's own, already-loaded <img> elements, in the same box.

const sameOriginOrInline = (img: HTMLImageElement): boolean => {
  const src = img.currentSrc || img.src;
  if (/^(data|blob):/i.test(src)) return true;
  try { return new URL(src, img.ownerDocument.baseURI).origin === img.ownerDocument.defaultView!.location.origin; } catch { return false; }
};

/** The loaded, visible <img>s of `root` that can be drawn without tainting the canvas. */
export function drawableImages(root: Element): HTMLImageElement[] {
  const win = root.ownerDocument.defaultView!;
  return Array.from(root.querySelectorAll('img')).filter((img) =>
    img.complete && img.naturalWidth > 0 && sameOriginOrInline(img) &&
    win.getComputedStyle(img).visibility === 'visible' && img.getClientRects().length > 0);
}

// The capture used to start after fixed delays only: a picture still loading or
// decoding then (the logo in a fresh window or in the manager on a slow
// network, a large signature) was neither drawn nor noticed, and the PDF came
// out without it. The capture now waits for every picture, at most a few
// seconds, and says which ones did not come.

const hasSource = (img: HTMLImageElement): boolean => !!(img.getAttribute('src') || img.currentSrc);
const loaded = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0;

/** Wait until every picture of `root` has loaded and decoded, or failed; at most `timeoutMs`. */
export async function picturesReady(root: Element, timeoutMs = 3000): Promise<void> {
  const one = (img: HTMLImageElement): Promise<void> => {
    // decode() waits for the load and the decoding; it rejects for a broken picture
    if (typeof img.decode === 'function') return img.decode().then(() => undefined, () => undefined);
    if (img.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
      img.addEventListener('load', done);
      img.addEventListener('error', done);
    });
  };
  const imgs = Array.from(root.querySelectorAll('img')).filter(hasSource);
  if (imgs.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(imgs.map(one)),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
  ]);
  clearTimeout(timer);
}

/**
 * Two animation frames: a render React has committed is laid out. At most
 * `maxMs`, as a hidden tab (Rebuild PDF behind another tab) gets no frames.
 */
export function nextFrames(maxMs = 100): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
}

/** The pictures of `root` that have a source but did not load (they are missing from the PDF). */
export function missingPictures(root: Element): HTMLImageElement[] {
  return Array.from(root.querySelectorAll('img')).filter((img) => hasSource(img) && !loaded(img));
}

/** Hide `imgs` (visibility only: the layout stays); returns the undo. */
export function hideImages(imgs: HTMLImageElement[]): () => void {
  const before = imgs.map((img) => [img.style.getPropertyValue('visibility'), img.style.getPropertyPriority('visibility')] as const);
  imgs.forEach((img) => img.style.setProperty('visibility', 'hidden', 'important'));
  return () => imgs.forEach((img, i) => {
    if (before[i][0]) img.style.setProperty('visibility', before[i][0], before[i][1]);
    else img.style.removeProperty('visibility');
  });
}

// html-to-image serialises the clone and passes it through encodeURIComponent,
// which throws "URI malformed" on half of a surrogate pair. One such character
// anywhere on the sheet (a name cut through an emoji, an initial taken from
// one, before those were fixed; still in the matches stored then) and no PDF
// was made at all. The capture gets U+FFFD in its place.

/** Replace half emojis (lone surrogates) in `root`'s text and attributes by U+FFFD; returns the undo. */
export function wellFormedSheet(root: Element): () => void {
  const undo: Array<() => void> = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const before = text.data;
    const after = wellFormedText(before);
    // put back only what is still ours: React may have re-rendered it meanwhile
    if (after !== before) {
      text.data = after;
      undo.push(() => { if (text.data === after) text.data = before; });
    }
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const { name, value: before } of Array.from(el.attributes)) {
      const after = wellFormedText(before);
      if (after !== before) {
        el.setAttribute(name, after);
        undo.push(() => { if (el.getAttribute(name) === after) el.setAttribute(name, before); });
      }
    }
  }
  return () => undo.forEach((put) => put());
}

/** Where the picture of `img` sits in its content box (object-fit, centred). */
export function imageBox(
  fit: string, box: { x: number; y: number; w: number; h: number }, natural: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (fit === 'fill' || !natural.w || !natural.h) return box;
  const contain = Math.min(box.w / natural.w, box.h / natural.h);
  const scale = fit === 'contain' ? contain
    : fit === 'cover' ? Math.max(box.w / natural.w, box.h / natural.h)
      : fit === 'none' ? 1
        : fit === 'scale-down' ? Math.min(1, contain)
          : 0;
  if (!scale) return box;
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

// A canvas drawImage that shrinks a picture by more than half samples too few
// source pixels and comes out jagged (the 1024 px logos drawn at ~100 px). The
// browser's own rendering is smooth: halve step by step first, like a mipmap.
function downscaled(img: HTMLImageElement, w: number, h: number): CanvasImageSource {
  let src: CanvasImageSource = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  while (sw / 2 >= w && sh / 2 >= h) {
    const c = img.ownerDocument.createElement('canvas');
    c.width = Math.max(1, Math.round(sw / 2));
    c.height = Math.max(1, Math.round(sh / 2));
    const cx = c.getContext('2d');
    if (!cx) break;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    sw = c.width;
    sh = c.height;
  }
  return src;
}

/** Draw `imgs` onto `canvas`, which holds a capture of `root` from its top-left corner. */
export function drawImagesOnto(canvas: HTMLCanvasElement, root: Element, imgs: HTMLImageElement[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const win = root.ownerDocument.defaultView!;
  const r = root.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const sx = canvas.width / r.width;
  const sy = canvas.height / r.height;
  for (const img of imgs) {
    const s = win.getComputedStyle(img);
    const px = (p: string) => parseFloat(s.getPropertyValue(p)) || 0;
    const b = img.getBoundingClientRect();
    const box = {
      x: b.left - r.left + px('border-left-width') + px('padding-left'),
      y: b.top - r.top + px('border-top-width') + px('padding-top'),
      w: b.width - px('border-left-width') - px('padding-left') - px('padding-right') - px('border-right-width'),
      h: b.height - px('border-top-width') - px('padding-top') - px('padding-bottom') - px('border-bottom-width'),
    };
    if (box.w <= 0 || box.h <= 0) continue;
    const at = imageBox(s.getPropertyValue('object-fit') || 'fill', box, { w: img.naturalWidth, h: img.naturalHeight });
    const opacity = parseFloat(s.getPropertyValue('opacity'));
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
    // object-fit: cover / none may spill over the box: clip to it.
    ctx.beginPath();
    ctx.rect(box.x * sx, box.y * sy, box.w * sx, box.h * sy);
    ctx.clip();
    ctx.drawImage(downscaled(img, at.w * sx, at.h * sy), at.x * sx, at.y * sy, at.w * sx, at.h * sy);
    ctx.restore();
  }
}

// Logical properties (margin-inline-start, border-block-end-color, inline-size,
// ...) are second names for physical ones (margin-left, border-bottom-color,
// width, ...): their computed values are the physical ones', mapped by the
// element's own writing mode. Copying the physical properties is enough, and
// copying both made WebKit slow: each logical property set after its physical
// one rewrites the clone's inline style, which costs WebKit up to ~25 µs a time
// in the manager page, ~3 of its ~6 s for the whole clone. A
// logical property is left out only when the browser lists the physical
// property for every side it can stand for (in a vertical writing mode
// margin-block-start is margin-left or margin-right, not margin-top).

const SIDE: Record<string, string> = { 'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right' };

/** The physical property the logical `p` stands for in horizontal-tb, ltr; null when `p` is not logical. */
export function physicalOf(p: string): string | null {
  const radius = /^border-(start|end)-(start|end)-radius$/.exec(p);
  if (radius) return `border-${radius[1] === 'start' ? 'top' : 'bottom'}-${radius[2] === 'start' ? 'left' : 'right'}-radius`;
  const axis = /^(overflow|overscroll-behavior)-(block|inline)$/.exec(p);
  if (axis) return `${axis[1]}-${axis[2] === 'block' ? 'y' : 'x'}`;
  const inset = /^inset-((?:block|inline)-(?:start|end))$/.exec(p);
  if (inset) return SIDE[inset[1]];
  const q = p
    .replace(/(^|-)((?:block|inline)-(?:start|end))(?=-|$)/, (_m, pre: string, s: string) => `${pre}${SIDE[s]}`)
    .replace(/(^|-)block-size$/, '$1height')
    .replace(/(^|-)inline-size$/, '$1width');
  return q === p ? null : q;
}

/** Every physical property the logical one standing for `phys` in horizontal-tb can stand for in any writing mode. */
function physicalSides(phys: string): string[] {
  if (/^border-(top|bottom)-(left|right)-radius$/.test(phys)) {
    return ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((c) => `border-${c}-radius`);
  }
  const axis = /^(overflow|overscroll-behavior)-[xy]$/.exec(phys);
  if (axis) return [`${axis[1]}-x`, `${axis[1]}-y`];
  // a side first: border-bottom-width is a side's width, not a size
  const side = /(^|-)(top|bottom|left|right)(?=-|$)/;
  if (side.test(phys)) return ['top', 'bottom', 'left', 'right'].map((s) => phys.replace(side, `$1${s}`));
  return ['width', 'height'].map((d) => phys.replace(/(width|height)$/, d));
}

/** `props` without the logical properties whose physical properties are all in it. */
export function withoutLogicalAliases(props: string[]): string[] {
  const listed = new Set(props);
  return props.filter((p) => {
    const phys = physicalOf(p);
    return !phys || !physicalSides(phys).every((x) => listed.has(x));
  });
}

/** The properties of `root`'s subtree that differ from the UA defaults somewhere. */
export function usedStyleProperties(root: Element): string[] {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const props = withoutLogicalAliases(allStyleProperties(doc).filter((p) => !p.startsWith('--')));

  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;border:0;visibility:hidden';
  doc.body.appendChild(frame);
  try {
    const refDoc = frame.contentDocument!;
    const refWin = frame.contentWindow!;
    refDoc.open();
    refDoc.write('<!DOCTYPE html><html><head></head><body></body></html>');
    refDoc.close();
    let refSvg: Element | null = null;
    const refs = new Map<string, CSSStyleDeclaration>();
    const refFor = (el: Element): CSSStyleDeclaration => {
      const type = el.localName === 'input' ? (el.getAttribute('type') || 'text') : '';
      const key = `${el.namespaceURI} ${el.localName} ${type}`;
      let style = refs.get(key);
      if (!style) {
        const ref = refDoc.createElementNS(el.namespaceURI, el.localName);
        if (type) ref.setAttribute('type', type);
        if (el.namespaceURI === SVG_NS && el.localName !== 'svg') {
          if (!refSvg) refSvg = refDoc.body.appendChild(refDoc.createElementNS(SVG_NS, 'svg'));
          refSvg.appendChild(ref);
        } else {
          refDoc.body.appendChild(ref);
        }
        style = refWin.getComputedStyle(ref);
        refs.set(key, style);
      }
      return style;
    };

    // the elements' styles by their reference (a few tags): each reference value is read once
    const byRef = new Map<CSSStyleDeclaration, CSSStyleDeclaration[]>();
    const add = (ref: CSSStyleDeclaration, style: CSSStyleDeclaration) => {
      const list = byRef.get(ref);
      if (list) list.push(style); else byRef.set(ref, [style]);
    };
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const ref = refFor(el);
      add(ref, win.getComputedStyle(el));
      // ::before / ::after are cloned with the same property list.
      for (const pseudo of ['::before', '::after']) {
        const ps = win.getComputedStyle(el, pseudo);
        const content = ps.getPropertyValue('content');
        if (content && content !== 'none' && content !== 'normal') add(ref, ps);
      }
    }
    return props.filter((p) => {
      for (const [ref, styles] of byRef) {
        const uaDefault = ref.getPropertyValue(p);
        for (const style of styles) if (style.getPropertyValue(p) !== uaDefault) return true;
      }
      return false;
    });
  } finally {
    frame.remove();
  }
}

// The sheet's font in the capture. The SVG html-to-image draws is loaded as a
// picture, and a picture fetches nothing: the font files have to be inside it
// as data: URLs. html-to-image finds them itself on every capture, by reading
// every rule of every stylesheet of the page and walking the whole clone for
// the families it uses (~0.4 s in the manager), then fetching every file
// again. The sheet uses one web font, sheet.css's 'OV Sheet Inter' (seven
// unicode-range files; the rest of its families are system fonts), so the
// capture takes the CSS from those @font-face rules only, built once per page
// and handed to html-to-image as fontEmbedCSS. A file that cannot be read
// leaves it to html-to-image, as before.

/** The family sheet.css bundles for the sheet. */
export const SHEET_FONT_FAMILY = 'OV Sheet Inter';

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const FONT_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** The @font-face rules of `family` in `doc`'s stylesheets (in @layer, @media and @import too). */
export function fontFaceRules(doc: Document, family: string): CSSFontFaceRule[] {
  const found: CSSFontFaceRule[] = [];
  const seen = new Set<string>();
  const walk = (rules: CSSRuleList | undefined | null) => {
    for (const rule of Array.from(rules || [])) {
      if (rule.type === 5 /* CSSRule.FONT_FACE_RULE */) {
        const face = rule as CSSFontFaceRule;
        // the dev server and a build may both have put sheet.css on the page
        if (unquote(face.style.getPropertyValue('font-family')) === family && !seen.has(face.cssText)) {
          seen.add(face.cssText);
          found.push(face);
        }
      } else if (rule.type === 3 /* CSSRule.IMPORT_RULE */) {
        try { walk((rule as CSSImportRule).styleSheet?.cssRules); } catch { /* another origin's */ }
      } else if ('cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    // another origin's stylesheet cannot be read, and it is not the sheet's
    try { walk(sheet.cssRules); } catch { /* skip */ }
  }
  return found;
}

const asDataUrl = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  // a page instead of the file (an app's fallback route) would print the fallback font
  if (/^text\//i.test(blob.type)) throw new Error(`${url}: ${blob.type}, not a font`);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`${url}: not readable`));
    reader.readAsDataURL(blob);
  });
};

/** The @font-face CSS of `family` with every font file inlined as a data: URL; null without such rules. */
export async function inlineFontFaceCSS(doc: Document, family: string): Promise<string | null> {
  const faces = fontFaceRules(doc, family);
  if (faces.length === 0) return null;
  const css = await Promise.all(faces.map(async (face) => {
    const base = face.parentStyleSheet?.href || doc.baseURI;
    const text = face.cssText;
    const urls = [...new Set(Array.from(text.matchAll(FONT_URL), (m) => m[2]).filter((u) => !/^data:/i.test(u)))];
    const inlined = new Map(await Promise.all(urls.map(async (u) => [u, await asDataUrl(new URL(u, base).href)] as const)));
    return text.replace(FONT_URL, (whole, _q, u: string) => (inlined.has(u) ? `url("${inlined.get(u)}")` : whole));
  }));
  return css.join('\n');
}

let sheetFonts: { doc: Document; css: Promise<string | null> } | null = null;

/**
 * The sheet font's CSS for html-to-image's fontEmbedCSS, built once per page
 * (the same files on every capture). null when it could not be built: then
 * html-to-image embeds the fonts itself, and the next capture tries again.
 */
export function sheetFontEmbedCSS(doc: Document = document): Promise<string | null> {
  if (!sheetFonts || sheetFonts.doc !== doc) {
    const css = inlineFontFaceCSS(doc, SHEET_FONT_FAMILY).catch((err) => {
      console.warn('[Scoresheet] The sheet font could not be prepared for the PDF, html-to-image embeds it:', err);
      return null;
    });
    const entry = { doc, css };
    sheetFonts = entry;
    void css.then((value) => { if (value === null && sheetFonts === entry) sheetFonts = null; });
  }
  return sheetFonts.css;
}

/** Forget the prepared font CSS (tests). */
export function resetSheetFontEmbedCSS(): void {
  sheetFonts = null;
}
