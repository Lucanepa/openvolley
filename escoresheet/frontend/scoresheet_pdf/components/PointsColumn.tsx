import React from 'react';

// One printed number of a points column. As on the paper sheet every number is
// pre-printed (light grey); a mark makes it black:
//  - filledState 1: a tick (point won in a rally)
//  - isCircled: a circle, no tick (penalty / delay-penalty / awarded point)
// Owner decision 2026-10-07 (field-spec 4.4, 4.7, 6): no "T" through the unused
// numbers at set end and no reverse T in set-5 panel 3. The column shows only the
// points actually scored.
export const PointBox: React.FC<{
    num: number;
    filledState?: 0 | 1;
    isCircled?: boolean;
    fontPx?: number;
}> = ({ num, filledState = 0, isCircled = false, fontPx = 8 }) => {
    const marked = filledState === 1 || isCircled;
    return (
        <div
            className="flex-1 w-full relative flex items-center justify-center min-h-0"
            data-point={num}
            data-mark={isCircled ? 'circle' : filledState === 1 ? 'tick' : ''}
        >
            <span className="leading-none tabular-nums" style={{ fontSize: `${fontPx}px`, color: marked ? '#000' : '#a8a29e' }}>{num}</span>
            {filledState === 1 && !isCircled && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <line x1="18" y1="88" x2="82" y2="12" stroke="black" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
                </svg>
            )}
            {isCircled && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" aria-hidden="true">
                    <circle cx="50" cy="50" r="46" fill="none" stroke="black" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
                </svg>
            )}
        </div>
    );
};

/**
 * Rows per sub-column. Sets 1-4: 4 x 12 (1-48) as printed on the Matchblatt,
 * growing by whole rows only beyond 48 (field-spec 4.4). Set 5 panels 2 and 3:
 * 3 x 10 (1-30), growing beyond 30.
 */
export const calculateRowsPerColumn = (maxScore: number, columns = 4, baseRows = 12): number =>
    Math.max(baseRows, Math.ceil((maxScore || 0) / columns));

/** Number size that still fits a row of the given height (mm). */
const fontForRows = (gridMm: number, rows: number): number => {
    const rowPx = (gridMm / rows) * 3.78;
    return Math.max(5, Math.min(8, Math.floor(rowPx * 0.85 * 2) / 2));
};

/** The printed grid: `columns` sub-columns of `rows` numbers, ruled between them. */
const PointsGrid: React.FC<{
    columns: number;
    rows: number;
    gridMm: number;
    markedPoints: number[];
    circledPoints: number[];
}> = ({ columns, rows, gridMm, markedPoints, circledPoints }) => {
    const fontPx = fontForRows(gridMm, rows);
    return (
        <div
            className="grid bg-white border-b border-black shrink-0"
            // the column's top border takes 1px: the grid's bottom rule then lands on the service-row line
            style={{ height: `calc(${gridMm}mm - 1px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            data-testid="points-grid"
        >
            {Array.from({ length: columns }).map((_, c) => (
                <div key={c} className={`flex flex-col h-full min-w-0 ${c > 0 ? 'border-l ss-rule' : ''}`}>
                    {Array.from({ length: rows }).map((__, i) => {
                        const num = c * rows + i + 1;
                        return (
                            <PointBox
                                key={i}
                                num={num}
                                fontPx={fontPx}
                                filledState={markedPoints.includes(num) ? 1 : 0}
                                isCircled={circledPoints.includes(num)}
                            />
                        );
                    })}
                </div>
            ))}
        </div>
    );
};

/** A time-out score "req:opp" on its pre-printed ":" line. */
const TimeoutLine: React.FC<{ value?: string }> = ({ value }) => (
    <div className="flex items-center justify-center gap-0.5 text-[10px] font-bold leading-none shrink-0 tabular-nums" style={{ height: '5mm' }}>
        {value ? (
            <>
                <span>{value.split(':')[0]}</span>
                <span>:</span>
                <span>{value.split(':')[1]}</span>
            </>
        ) : (
            <span>:</span>
        )}
    </div>
);

/**
 * The "T" block under a points column: the label, then the two time-out lines,
 * each 5 mm so they line up with the service-round rows beside them (as on the
 * Matchblatt, field-spec 4.5).
 */
const TimeoutBlock: React.FC<{ timeouts: [string, string]; labelRow?: boolean }> = ({ timeouts, labelRow = true }) => (
    <div className="bg-white flex flex-col shrink-0" data-testid="timeout-block">
        {labelRow && (
            <div className="flex items-center justify-center text-[9px] font-bold leading-none shrink-0" style={{ height: '5mm' }}>"T"</div>
        )}
        <TimeoutLine value={timeouts[0]} />
        <TimeoutLine value={timeouts[1]} />
    </div>
);

// Sets 1-4: 1-48 (4 x 12) beside the team's block. The grid spans the roman
// numerals, the line-up, the substitutions and service row 1 (30 mm); the "T"
// block lines up with service rows 2-4.
export const PointsColumn: React.FC<{
    isLast?: boolean;
    compact?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    maxScore?: number;
    setFinished?: boolean;
    finalScore?: number;
}> = ({ isLast, timeouts = ["", ""], markedPoints = [], circledPoints = [], maxScore = 0 }) => {
    const rows = calculateRowsPerColumn(maxScore, 4, 12);
    return (
        <div className={`flex flex-col h-full shrink-0 border-t border-l border-black ${isLast ? '' : 'border-r'}`} style={{ width: '15mm' }}>
            <PointsGrid columns={4} rows={rows} gridMm={30} markedPoints={markedPoints} circledPoints={circledPoints} />
            <TimeoutBlock timeouts={timeouts} />
        </div>
    );
};

// Set 5 panel 1: points 1-8 only (one column in the centre), as they stood at the
// change of courts. The grid spans the header, line-up and substitutions (25 mm);
// the "T" block lines up with service rows 1-3.
export const PointsColumn5: React.FC<{
    compact?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    setFinished?: boolean;
    finalScore?: number;
    pointsAtChange?: number | null;
}> = ({ timeouts = ["", ""], markedPoints = [], circledPoints = [] }) => {
    const fontPx = fontForRows(25, 8);
    return (
        <div className="flex flex-col shrink-0 border-t border-l border-black" style={{ width: '15mm', height: '40mm' }}>
            <div className="grid grid-cols-3 bg-white shrink-0 border-b border-black" style={{ height: 'calc(25mm - 1px)' }} data-testid="points-grid">
                <div className="h-full"></div>
                <div className="flex flex-col h-full border-l border-r ss-rule">
                    {Array.from({ length: 8 }).map((_, i) => {
                        const num = i + 1;
                        return <PointBox key={i} num={num} fontPx={fontPx} filledState={markedPoints.includes(num) ? 1 : 0} isCircled={circledPoints.includes(num)} />;
                    })}
                </div>
                <div className="h-full"></div>
            </div>
            <TimeoutBlock timeouts={timeouts} />
        </div>
    );
};

// Set 5 panels 2 and 3: 1-30 (3 x 10), growing beyond 30.
export const PointsColumn30: React.FC<{
    isLast?: boolean;
    isPanel3?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    preChangePoints?: number | null;
    maxScore?: number;
    setFinished?: boolean;
    finalScore?: number;
}> = ({ timeouts = ["", ""], markedPoints = [], circledPoints = [], maxScore = 0 }) => {
    const rows = calculateRowsPerColumn(maxScore, 3, 10);
    return (
        <div className="flex flex-col shrink-0 border-t border-l border-black flex-1" style={{ minWidth: '15mm', height: '40mm' }}>
            <PointsGrid columns={3} rows={rows} gridMm={25} markedPoints={markedPoints} circledPoints={circledPoints} />
            <TimeoutBlock timeouts={timeouts} />
        </div>
    );
};
