import React, { useLayoutEffect, useRef, useState } from 'react';

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
 */
export const FitText: React.FC<{
    max: number;
    min?: number;
    multiline?: boolean;
    className?: string;
    style?: React.CSSProperties;
    title?: string;
    children?: React.ReactNode;
    'data-testid'?: string;
}> = ({ max, min = 5, multiline = false, className = '', style, title, children, ...rest }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState(max);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // multiline: also the width, since one long word (no break opportunity) does not wrap
        const overflows = () => (multiline
            ? el.scrollHeight > el.clientHeight + 0.5 || el.scrollWidth > el.clientWidth + 0.5
            : el.scrollWidth > el.clientWidth + 0.5);
        let s = max;
        el.style.fontSize = `${s}px`;
        // jsdom (tests) reports 0 for every size: nothing overflows there
        while (overflows() && s > min) {
            s = Math.max(min, Math.round((s - 0.5) * 10) / 10);
            el.style.fontSize = `${s}px`;
        }
        if (s !== size) setSize(s);
    });

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
            {children}
        </div>
    );
};
