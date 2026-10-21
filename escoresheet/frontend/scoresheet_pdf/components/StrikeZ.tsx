import React from 'react';

/**
 * A "Z" struck across the grid of a set awarded by default (field-spec 11), as
 * the scorer strikes it off on paper (SC p.18). The grids and RESULT rows of
 * sets never played are left blank, not struck off (owner 2026-10-20).
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
