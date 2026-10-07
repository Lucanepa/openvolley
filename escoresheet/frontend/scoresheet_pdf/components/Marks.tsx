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
 * The cells leave ~4.74 mm inside their rules (rows) and ~4.6 mm (service-box
 * width), so a ring of 4.0 mm plus its ~0.3 mm stroke keeps ~0.15 mm clear of
 * every rule (a 4.4 mm ring touched them). "Bigger" is met against the digits:
 * the circled number is set at CIRCLED_NUMBER_PX, so the ring sits well clear of
 * it instead of hugging it.
 */
export const NUMBER_CIRCLE_MM = 4.0;

/** Font size of a circled number (substitute who came back, final points). */
export const CIRCLED_NUMBER_PX = 9.5;

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
