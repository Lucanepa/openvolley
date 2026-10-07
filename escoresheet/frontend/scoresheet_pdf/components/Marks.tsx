import React from 'react';

/**
 * The marks a scorer draws by hand, one size and one pen everywhere on the sheet
 * (preview and PDF): strokes keep their width at any box size
 * (non-scaling-stroke, ~0.3 mm), so they do not fade in the PDF capture.
 */
export const MARK_STROKE = 1.2;

/**
 * Circle around a number in the 5 mm cells (a substitute who came back, the final
 * points in the service boxes), one size everywhere. Owner request 2026-10-07:
 * "circle can be a little bigger", centred, never touching the cell's borders.
 * The cell leaves ~4.7 mm inside its rules, so the circle is as large as fits
 * (4.4 mm, outer edge of the stroke 4.7 mm) and the circled substitute's number
 * is set smaller (12 px instead of 14 px), so the ring no longer hugs the digits.
 */
export const NUMBER_CIRCLE_MM = 4.4;

/** A circle centred on its (relative) parent, `mm` wide. */
export const NumberCircle: React.FC<{ mm?: number; testId?: string }> = ({ mm = NUMBER_CIRCLE_MM, testId }) => (
    <svg
        className="absolute pointer-events-none"
        viewBox="0 0 100 100"
        style={{ width: `${mm}mm`, height: `${mm}mm`, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', overflow: 'visible' }}
        aria-hidden="true"
        data-testid={testId}
    >
        <circle cx="50" cy="50" r="50" fill="none" stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
    </svg>
);

/** A cross over the whole (relative) parent. */
export const CrossMark: React.FC<{ inset?: number }> = ({ inset = 18 }) => (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" aria-hidden="true" data-mark="X">
        <line x1={inset} y1={inset} x2={100 - inset} y2={100 - inset} stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
        <line x1={100 - inset} y1={inset} x2={inset} y2={100 - inset} stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
    </svg>
);
