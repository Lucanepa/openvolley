import React from 'react';

/**
 * The marks a scorer draws by hand, one size and one pen everywhere on the sheet
 * (preview and PDF): strokes keep their width at any box size
 * (non-scaling-stroke, ~0.3 mm), so they do not fade in the PDF capture.
 */
export const MARK_STROKE = 1.2;

/**
 * Circle around the final points in a service box. The box is ~4.6 mm wide
 * inside its rules, so a ring of 4.0 mm plus its ~0.3 mm stroke keeps ~0.15 mm
 * clear of the rules; the number keeps the box's own size (SERVICE_NUMBER_PX)
 * and its ink (radius ~1.74 mm for two bold digits) stays clear of the ring.
 */
export const NUMBER_CIRCLE_MM = 4.0;

/** A number written in a service box (team score at the loss of service, final points). */
export const SERVICE_NUMBER_PX = 10.5;

/**
 * Starting line-up and substitute numbers, the circled substitute included
 * (owner 2026-10-13: one size in those rows; of 9.5, 9 and 8.5 pt the owner
 * chose 8.5 pt, the size at which the ring can clear both digits and rules).
 */
export const LINEUP_NUMBER_PT = 8.5;

/**
 * Circle around a substitute who came back (owner 2026-10-13: a bigger ring,
 * not a smaller number). Two bold digits at LINEUP_NUMBER_PT have an ink radius
 * of ~1.87 mm, so the ring (inner radius ~1.99 mm) clears them by ~0.12 mm,
 * and with its stroke (~4.62 mm) it stays ~0.06 mm inside the row's rules
 * (4.74 mm apart).
 */
export const SUB_CIRCLE_MM = 4.3;

/** Ink radius of two bold digits, in em (measured in Chromium: 1.74 mm at 10.5 px, 2.08 mm at 12.67 px). */
export const TWO_DIGIT_INK_RADIUS_EM = 0.63;

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
