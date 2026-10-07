import React from 'react';

// One printed number of a points column. As on the paper sheet every number is
// pre-printed (light grey); a mark makes it black:
//  - filledState 1: a tick (point won in a rally)
//  - isCircled: a circle, no tick (penalty / delay-penalty / awarded point)
//  - voided: a "T" through an unused number at set end (SC p.39), or in set-5
//    panel 1 above the left team's points at the change of courts
//  - reverseT: an inverted T through the numbers already scored before the
//    change of courts, in set-5 panel 3 (SC p.77)
export const PointBox: React.FC<{
    num: number;
    filledState?: 0 | 1;
    isCircled?: boolean;
    voided?: boolean;
    reverseT?: boolean;
}> = ({ num, filledState = 0, isCircled = false, voided = false, reverseT = false }) => {
    const marked = filledState === 1 || isCircled || voided || reverseT;
    return (
        <div
            className="flex-1 w-full relative flex items-center justify-center"
            data-point={num}
            data-mark={voided ? 'T' : reverseT ? 'reverseT' : isCircled ? 'circle' : filledState === 1 ? 'tick' : ''}
        >
            <span className="text-[8px] leading-none" style={{ color: marked ? '#000' : '#a8a29e' }}>{num}</span>
            {filledState === 1 && !isCircled && !voided && !reverseT && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="15" y1="85" x2="85" y2="15" stroke="black" strokeWidth="4" />
                 </svg>
            )}
            {isCircled && !voided && !reverseT && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="black" strokeWidth="4" />
                </svg>
            )}
            {voided && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="50" y1="14" x2="50" y2="86" stroke="black" strokeWidth="4" />
                    <line x1="28" y1="14" x2="72" y2="14" stroke="black" strokeWidth="4" />
                </svg>
            )}
            {reverseT && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="50" y1="14" x2="50" y2="86" stroke="black" strokeWidth="4" />
                    <line x1="28" y1="86" x2="72" y2="86" stroke="black" strokeWidth="4" />
                </svg>
            )}
        </div>
    );
};

// Helper function to calculate rows per column based on max score
export const calculateRowsPerColumn = (maxScore: number): number => {
    let rowsPerColumn = 8;
    if (maxScore > 32) rowsPerColumn = 12;
    if (maxScore > 48) rowsPerColumn = 16;
    if (maxScore > 64) rowsPerColumn = 20;
    if (maxScore > 80) rowsPerColumn = 24;
    return rowsPerColumn;
};

// Unified PointsColumn component for Sets 1-4 (4 columns x 8+ rows, expands dynamically)
export const PointsColumn: React.FC<{
    isLast?: boolean;
    compact?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    maxScore?: number;
    setFinished?: boolean;
    finalScore?: number;
}> = ({ isLast, timeouts = ["", ""], markedPoints = [], circledPoints = [], maxScore = 0, setFinished = false, finalScore = 0 }) => {
    const rowsPerColumn = calculateRowsPerColumn(maxScore);
    const offsets = [0, rowsPerColumn, rowsPerColumn * 2, rowsPerColumn * 3];
    const maxPoints = rowsPerColumn * 4;

    return (
        <div className={`flex flex-col h-full shrink-0 border-t border-black ${isLast ? '' : 'border-r border-black'}`} style={{ width: '15mm' }}>
            <div
                className="grid grid-cols-4 bg-white border-b border-black border-l border-black"
                style={{ height: '2.98cm' }}
            >
                {offsets.map((offset) => (
                    <div
                        key={offset}
                        className="flex flex-col h-full"
                        style={{ minWidth: 0, flex: 1 }}
                    >
                        {Array.from({ length: rowsPerColumn }).map((_, i) => {
                            const num = offset + i + 1;
                            if (num > maxPoints) return <div key={i} className="flex-1"></div>;
                            let state: 0 | 1 = 0;
                            if (markedPoints.includes(num)) {
                                state = 1;
                            }
                            // Set-end: void unused numbers above this team's final score with a "T"
                            // (also from 1 for a team that scored nothing).
                            const voided = setFinished && num > finalScore && num <= maxPoints;
                            return <PointBox key={i} num={num} filledState={state} isCircled={circledPoints.includes(num)} voided={voided} />;
                        })}
                    </div>
                ))}
            </div>
              {/* TO Boxes */}
            <div className="bg-white flex flex-col items-center justify-start gap-1 py-1 border-l border-black" style={{ height: '1.498cm' }}>
            <span className="text-[8px] font-bold leading-none" style={{ height: '0.5cm' }}>"T"</span>
                <div className="flex flex-col w-full px-2 items-center" style={{ height: '1cm' }}>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[0] ? (
                            <>
                                <span>{timeouts[0].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[0].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[1] ? (
                            <>
                                <span>{timeouts[1].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[1].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Set 5 Panel 1 - Points 1-8 only (single column in center)
export const PointsColumn5: React.FC<{
    compact?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    setFinished?: boolean;
    finalScore?: number;
    /** The left team's points at the change of courts; null before the change. */
    pointsAtChange?: number | null;
}> = ({ timeouts = ["", ""], markedPoints = [], circledPoints = [], setFinished = false, finalScore = 0, pointsAtChange = null }) => {
    return (
        <div className="flex flex-col shrink-0 border-t border-black" style={{ width: '15mm', height: '3.5cm' }}>
            <div className="grid grid-cols-3 bg-white shrink-0 border-b border-black border-l" style={{ height: '2.47cm' }}>
                <div className="h-full"></div>
                <div className="flex flex-col h-full">
                    {Array.from({ length: 8 }).map((_, i) => {
                        const num = i + 1;
                        let state: 0 | 1 = 0;
                        if (markedPoints.includes(num)) {
                            state = 1;
                        }
                        // At the change of courts: "T" over N+1..8 (field-spec 6 step 3);
                        // a set that ended before any change (default): above the final
                        const voided = pointsAtChange !== null && pointsAtChange !== undefined
                            ? num > pointsAtChange
                            : setFinished && num > finalScore;
                        return <PointBox key={i} num={num} filledState={state} isCircled={circledPoints.includes(num)} voided={voided} />;
                    })}
                </div>
                <div className="h-full"></div>
            </div>

            <div className="bg-white flex flex-col items-center justify-start gap-1 py-1 shrink-0 border-l border-black" style={{ height: '1.5cm' }}>
            <span className="text-[8px] font-bold leading-none" style={{ height: '0.5cm' }}>"T"</span>
                <div className="flex flex-col w-full px-2 items-center ">
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[0] ? (
                            <>
                                <span>{timeouts[0].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[0].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[1] ? (
                            <>
                                <span>{timeouts[1].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[1].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Set 5 Panels 2 & 3 - Points 1-32+ with dynamic expansion
export const PointsColumn30: React.FC<{
    isLast?: boolean;
    isPanel3?: boolean;
    timeouts?: [string, string];
    markedPoints?: number[];
    circledPoints?: number[];
    /** Panel 3: the left team's points at the change of courts, null before the change. */
    preChangePoints?: number | null;
    maxScore?: number;
    setFinished?: boolean;
    finalScore?: number;
}> = ({ isLast, isPanel3 = false, timeouts = ["", ""], markedPoints = [], circledPoints = [], preChangePoints = null, maxScore = 0, setFinished = false, finalScore = 0 }) => {
    const rowsPerColumn = calculateRowsPerColumn(maxScore);
    const offsets = [0, rowsPerColumn, rowsPerColumn * 2, rowsPerColumn * 3];
    const maxPoints = rowsPerColumn * 4;

    return (
        <div className={`flex flex-col shrink-0 border-t border-black`} style={{ width: '15mm', height: '3.5cm' }}>
            <div className="grid grid-cols-4 bg-white shrink-0 border-b border-black border-l" style={{ height: '2.47cm' }}>
                {offsets.map((offset) => (
                    <div key={offset} className="flex flex-col h-full">
                        {Array.from({ length: rowsPerColumn }).map((_, i) => {
                             const num = offset + i + 1;
                             if (num > maxPoints) return <div key={i} className="flex-1"></div>;
                             // Panel 3: the points scored before the change of courts (1..N)
                             // get an inverted T (SC p.77); later ones are ticked as usual
                             const reverseT = isPanel3 && preChangePoints !== null && num <= preChangePoints;
                             const state: 0 | 1 = !reverseT && markedPoints.includes(num) ? 1 : 0;
                             const isCircled = !reverseT && circledPoints.includes(num);
                             // Set-end: void unused numbers above this team's final score with a "T"
                             // (panel 3 only once it is in use, i.e. after the change)
                             const inUse = !isPanel3 || preChangePoints !== null;
                             const voided = inUse && setFinished && num > finalScore && num <= maxPoints;
                             return <PointBox key={i} num={num} filledState={state} isCircled={isCircled} voided={voided} reverseT={reverseT} />
                        })}
                    </div>
                ))}
            </div>
            <div className="bg-white flex flex-col items-center justify-start py-1 shrink-0 border-l border-black " style={{ height: '1.5cm' }}>
                <span className="text-[8px] font-bold leading-none" style={{ height: '0.5cm' }}>"T"</span>
                <div className="flex flex-col w-full px-2 items-center">
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[0] ? (
                            <>
                                <span>{timeouts[0].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[0].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center gap-0.5" style={{ height: '0.5cm' }}>
                        {timeouts[1] ? (
                            <>
                                <span>{timeouts[1].split(':')[0]}</span>
                                <span>:</span>
                                <span>{timeouts[1].split(':')[1]}</span>
                            </>
                        ) : (
                            <span>:</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
