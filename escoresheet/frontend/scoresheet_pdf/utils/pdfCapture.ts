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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** WebKitGTK (Linux desktop app, Epiphany): WebKit on Linux, not Chromium. */
export function isWebKitGtk(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /AppleWebKit/.test(ua) && /(X11|Linux)/.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android)/.test(ua);
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

/** Hide `imgs` (visibility only: the layout stays); returns the undo. */
export function hideImages(imgs: HTMLImageElement[]): () => void {
  const before = imgs.map((img) => [img.style.getPropertyValue('visibility'), img.style.getPropertyPriority('visibility')] as const);
  imgs.forEach((img) => img.style.setProperty('visibility', 'hidden', 'important'));
  return () => imgs.forEach((img, i) => {
    if (before[i][0]) img.style.setProperty('visibility', before[i][0], before[i][1]);
    else img.style.removeProperty('visibility');
  });
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

/** The properties of `root`'s subtree that differ from the UA defaults somewhere. */
export function usedStyleProperties(root: Element): string[] {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const props = allStyleProperties(doc).filter((p) => !p.startsWith('--'));

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

    const pairs: Array<[CSSStyleDeclaration, CSSStyleDeclaration]> = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const ref = refFor(el);
      pairs.push([win.getComputedStyle(el), ref]);
      // ::before / ::after are cloned with the same property list.
      for (const pseudo of ['::before', '::after']) {
        const ps = win.getComputedStyle(el, pseudo);
        const content = ps.getPropertyValue('content');
        if (content && content !== 'none' && content !== 'normal') pairs.push([ps, ref]);
      }
    }
    return props.filter((p) => pairs.some(([s, r]) => s.getPropertyValue(p) !== r.getPropertyValue(p)));
  } finally {
    frame.remove();
  }
}
