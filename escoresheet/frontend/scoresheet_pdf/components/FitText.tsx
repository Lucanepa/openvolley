import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { propsEqual } from '../utils/propsEqual';

/**
 * Text that always fits its box on the fixed A3 sheet: the font shrinks
 * (from `max` down to `min` px) until the text no longer overflows. One line
 * (`multiline` false: never wraps; the width decides) or wrapped text in a box
 * of fixed height (`multiline`: the height decides). Long team names, leagues,
 * halls, officials' names and remarks must neither grow the sheet past the
 * page (the PDF cut its bottom off) nor be hidden behind a scrollbar.
 *
 * Layout sizes (scrollWidth / clientWidth) ignore the zoom transform, so the
 * result is the same at any zoom and in the PDF capture.
 *
 * A browser with a minimum font size (Android's WebView: 8px by default; a
 * user's "minimum font size" in Chrome, Safari or Firefox) draws a smaller
 * font size at its minimum, and the text was cut off without a word. FitText
 * reads the size the browser really used. When that is held at a floor and
 * the text does not fit there, the text goes into an inner box at the floor
 * size, laid out 1/k as large and scaled by k (a transform is not subject to
 * the minimum): it draws what the smaller font would have drawn. Where nothing
 * holds the font up, there is no inner box: the sheet is the same as before.
 */
const FitTextView: React.FC<{
    max: number;
    min?: number;
    multiline?: boolean;
    className?: string;
    style?: React.CSSProperties;
    title?: string;
    children?: React.ReactNode;
    'data-testid'?: string;
    /** Told whether the text still overflows at `min` (it is then cut off). */
    onClipped?: (clipped: boolean) => void;
}> = ({ max, min = 5, multiline = false, className = '', style, title, children, onClipped, ...rest }) => {
    const ref = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState(max);
    // this browser holds the font above the size the text needs: the inner box
    const [floored, setFloored] = useState(false);
    // the inner box as the last fit left it (font, scale, the box's content size)
    const [box, setBox] = useState<{ font: number; k: number; w: number; h: number } | null>(null);
    // The sheet's font (sheet.css) arrives after the first fit, which measured
    // the fallback font: fit again once a font has loaded
    const [fontsLoaded, setFontsLoaded] = useState(0);
    // What the last completed fit saw: the same text, limits and box size again
    // (a re-render that changed nothing here) need no new fit, which forced a
    // layout per 0.5 px step on every render (review 2026-11-16, F3)
    const lastFit = useRef('');
    useEffect(() => {
        const fonts = typeof document !== 'undefined' ? (document as any).fonts : null;
        if (!fonts?.addEventListener) return;
        const refit = () => setFontsLoaded(n => n + 1);
        fonts.addEventListener('loadingdone', refit);
        return () => fonts.removeEventListener('loadingdone', refit);
    }, []);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const inner = innerRef.current;
        const fitKey = () => [el.textContent, max, min, multiline ? 1 : 0, className, JSON.stringify(style || null), fontsLoaded, floored ? 1 : 0, inner ? 1 : 0, el.clientWidth, el.clientHeight].join('|');
        if (lastFit.current && lastFit.current === fitKey()) return;
        const win = el.ownerDocument.defaultView;
        // the size the browser really draws (its minimum font size may hold it higher)
        const used = (node: HTMLElement) => parseFloat(win?.getComputedStyle(node).fontSize || '') || 0;
        let w = 0;
        let h = 0;
        if (inner) {
            // the box's own content size, without what the last fit set on the inner box
            for (const p of ['width', 'height', 'margin-right', 'transform', 'font-size']) inner.style.removeProperty(p);
            // the used width and height (fractional, not rounded as clientWidth is, and
            // unaffected by the zoom transform), less padding (and borders, border-box)
            const cs = win?.getComputedStyle(el);
            const px = (p: string) => parseFloat(cs?.getPropertyValue(p) || '') || 0;
            const borderBox = cs?.getPropertyValue('box-sizing') === 'border-box';
            const usedW = px('width') || el.clientWidth;
            const usedH = px('height') || el.clientHeight;
            w = Math.max(0, usedW - px('padding-left') - px('padding-right') - (borderBox ? px('border-left-width') + px('border-right-width') : 0));
            h = Math.max(0, usedH - px('padding-top') - px('padding-bottom') - (borderBox ? px('border-top-width') + px('border-bottom-width') : 0));
        }
        let held = false;
        let fit = { font: max, k: 1, w, h };
        const apply = (s: number) => {
            el.style.fontSize = `${s}px`;
            const floor = used(el);
            const k = floor > s + 0.05 ? s / floor : 1;
            if (k < 1) held = true;
            if (!inner) return;
            fit = { font: k < 1 ? floor : s, k, w, h };
            inner.style.fontSize = `${fit.font}px`;
            inner.style.width = `${w / k}px`;
            inner.style.marginRight = k < 1 ? `${w - w / k}px` : '';
            if (multiline) inner.style.height = `${h / k}px`;
            inner.style.transform = k < 1 ? `scale(${k})` : '';
        };
        // multiline: also the width, since one long word (no break opportunity) does not wrap
        const target = inner || el;
        const overflows = () => (multiline
            ? target.scrollHeight > target.clientHeight + 0.5 || target.scrollWidth > target.clientWidth + 0.5
            : target.scrollWidth > target.clientWidth + 0.5);
        let s = max;
        apply(s);
        // jsdom (tests) reports 0 for every size: nothing overflows there
        while (overflows() && s > min) {
            s = Math.max(min, Math.round((s - 0.5) * 10) / 10);
            apply(s);
        }
        const clipped = overflows();
        if (s !== size) setSize(s);
        if (inner) {
            if (!box || box.font !== fit.font || box.k !== fit.k || box.w !== fit.w || box.h !== fit.h) setBox(fit);
        } else if (held && clipped) {
            // cut off only because the browser would not go smaller: fit again, scaled
            setFloored(true);
            return;
        }
        onClipped?.(clipped);
        lastFit.current = fitKey();
    });

    const scaled = !!box && box.k < 1;
    return (
        <div
            ref={ref}
            className={className}
            title={title}
            data-testid={rest['data-testid']}
            style={{
                ...style,
                fontSize: `${size}px`,
                overflow: 'hidden',
                whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
                minWidth: 0
            }}
        >
            {floored ? (
                <div
                    ref={innerRef}
                    data-fit-scale={scaled ? String(Math.round(box!.k * 1000) / 1000) : '1'}
                    style={{
                        // the box's own layout (flex centring, alignment) carries on inside
                        display: 'inherit',
                        alignItems: 'inherit',
                        justifyContent: 'inherit',
                        // at the box's top left: the outer size (with the margin) is the box's own
                        alignSelf: 'flex-start',
                        flex: 'none',
                        overflow: 'hidden',
                        minWidth: 0,
                        fontSize: box ? `${box.font}px` : undefined,
                        width: box ? `${box.w / box.k}px` : undefined,
                        height: multiline && box ? `${box.h / box.k}px` : undefined,
                        marginRight: scaled ? `${box!.w - box!.w / box!.k}px` : undefined,
                        transform: scaled ? `scale(${box!.k})` : undefined,
                        transformOrigin: multiline ? '0 0' : '0 50%'
                    }}
                >
                    {children}
                </div>
            ) : children}
        </div>
    );
};

// Memoised (utils/propsEqual): a new sheet model with the same values for this
// section does not re-render it (review 2026-11-16, F2/F3)
export const FitText = React.memo(FitTextView, propsEqual);
