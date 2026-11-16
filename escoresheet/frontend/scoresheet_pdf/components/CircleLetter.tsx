import React from 'react';

/**
 * A team letter (A / B) in a ring: the set headers, the teams header, RESULT,
 * the rosters, SANCTIONS, the captains' signatures.
 *
 * The letter is SVG text whose alphabetic baseline lies half a cap height below
 * the ring's centre, so a capital is centred exactly. As HTML text in a flex
 * box it sat on a baseline rounded to whole pixels, and the PDF capture moved
 * it up to 1.5px high in the rings (most at a display scaling; owner
 * 2026-11-16: "the A and B can be a couple pixels lower").
 */
export const CAP_HEIGHT_EM = 0.727; // Inter (the sheet's font): 1490 / 2048

export const CircleLetter: React.FC<{
    letter?: string;
    /** ring size, px (outer, border included) */
    size: number;
    /** letter size, px */
    fontPx: number;
    /** background and extra classes of the ring */
    className?: string;
    /** drawn over the letter (the improper-request X) */
    children?: React.ReactNode;
    'data-testid'?: string;
}> = ({ letter = '', size, fontPx, className = 'bg-white', children, ...rest }) => (
    <div
        className={`relative shrink-0 rounded-full border border-black select-none ${className}`}
        style={{ width: size, height: size }}
        data-testid={rest['data-testid']}
        data-circle-letter={letter}
    >
        {letter ? (
            <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" aria-hidden="true">
                <text
                    x="50%"
                    y="50%"
                    dy={CAP_HEIGHT_EM * fontPx / 2}
                    textAnchor="middle"
                    fontSize={fontPx}
                    fontWeight={700}
                    fill="currentColor"
                >{letter}</text>
            </svg>
        ) : null}
        {children}
    </div>
);
