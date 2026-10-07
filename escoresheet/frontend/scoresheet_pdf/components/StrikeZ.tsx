import React from 'react';

/**
 * A "Z" struck across an unused area of the sheet (a set grid or result rows
 * that were never played, a set awarded by default): field-spec 3, 9 and 11,
 * as the scorer strikes them off on paper (SC p.18).
 */
export const StrikeZ: React.FC<{ className?: string }> = ({ className = '' }) => (
    <svg
        className={`absolute inset-0 w-full h-full pointer-events-none z-20 ${className}`}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        data-testid="strike-z"
        aria-hidden="true"
    >
        <polyline points="4,6 96,6 4,94 96,94" fill="none" stroke="black" strokeWidth="0.6" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 1.5 }} />
    </svg>
);
