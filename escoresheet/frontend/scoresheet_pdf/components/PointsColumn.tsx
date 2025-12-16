import React from 'react';

// 75% black border color
const borderColor75 = { borderColor: 'rgba(0, 0, 0, 0.75)' };

// Unified PointBox component - uses SetFive styling (thinner strokes, better proportions)
export const PointBox: React.FC<{
    num: number;
    filledState?: 0 | 1;
    isCircled?: boolean;
    showNumberOnly?: boolean;
}> = ({ num, filledState = 0, isCircled = false, showNumberOnly = false }) => {
    // type: 0 = none (blank), 1 = slash (scored)
    // showNumberOnly: display number without slash (for pre-change points in Set 5 Panel 3)
    // Only show number if scored (filledState === 1), circled (penalty point), or showNumberOnly
    const showNumber = filledState === 1 || isCircled || showNumberOnly;

    return (
        <div
            className="flex-1 w-full relative flex items-center justify-center"
            style={{ borderColor: '#000' }}
        >
            {/* Background Number - only show if scored or circled */}
            {showNumber && (
                <span className="text-[8px] leading-none text-black">{num}</span>
            )}
            {/* Only show slash if scored and not circled (penalty points should only have circle, no slash) */}
            {filledState === 1 && !isCircled && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="15" y1="85" x2="85" y2="15" stroke="black" strokeWidth="4" />
                 </svg>
            )}
            {/* Circle for points scored due to sanctions (penalty points) - no slash, only circle */}
            {isCircled && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="black" strokeWidth="4" />
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
}> = ({ isLast, timeouts = ["", ""], markedPoints = [], circledPoints = [], maxScore = 0 }) => {
    const rowsPerColumn = calculateRowsPerColumn(maxScore);
    const offsets = [0, rowsPerColumn, rowsPerColumn * 2, rowsPerColumn * 3];
    const maxPoints = rowsPerColumn * 4;

    return (
        <div className={`flex flex-col h-full shrink-0 ${isLast ? '' : 'border-r'}`} style={{ width: '15mm', ...(isLast ? {} : borderColor75) }}>
            <div
                className="grid grid-cols-4 bg-white border-b border-l"
                style={{ height: '3.0cm', ...borderColor75 }}
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
                            return <PointBox key={i} num={num} filledState={state} isCircled={circledPoints.includes(num)} />;
                        })}
                    </div>
                ))}
            </div>
              {/* TO Boxes */}
            <div className="bg-white flex flex-col items-center justify-start gap-1 border-l py-1" style={{ height: '1.5cm', ...borderColor75 }}>
            <span className="text-[8px] font-bold leading-none" style={{ height: '0.5cm' }}>T</span>
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
}> = ({ timeouts = ["", ""], markedPoints = [], circledPoints = [] }) => {
    return (
        <div className="flex flex-col shrink-0" style={{ width: '15mm', height: '3.5cm' }}>
            <div className="grid grid-cols-3 bg-white border-b shrink-0" style={{ height: '2.48cm', ...borderColor75 }}>
                <div className="h-full"></div>
                <div className="flex flex-col h-full">
                    {Array.from({ length: 8 }).map((_, i) => {
                        const num = i + 1;
                        let state: 0 | 1 = 0;
                        if (markedPoints.includes(num)) {
                            state = 1;
                        }
                        return <PointBox key={i} num={num} filledState={state} isCircled={circledPoints.includes(num)} />;
                    })}
                </div>
                <div className="h-full"></div>
            </div>

            <div className="bg-white flex flex-col items-center justify-start gap-1 py-1 shrink-0" style={{ height: '1cm' }}>
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
    preChangePoints?: number;
    maxScore?: number;
}> = ({ isLast, isPanel3 = false, timeouts = ["", ""], markedPoints = [], circledPoints = [], preChangePoints = 0, maxScore = 0 }) => {
    const rowsPerColumn = calculateRowsPerColumn(maxScore);
    const offsets = [0, rowsPerColumn, rowsPerColumn * 2, rowsPerColumn * 3];
    const maxPoints = rowsPerColumn * 4;

    return (
        <div className={`flex flex-col shrink-0 ${isLast ? '' : 'border-l-0'}`} style={{ width: '15mm', height: '3.5cm', ...(isLast ? {} : borderColor75) }}>
            <div className="grid grid-cols-4 bg-white border-b shrink-0" style={{ height: '2.5cm', ...borderColor75 }}>
                {offsets.map((offset) => (
                    <div key={offset} className="flex flex-col border-t-0 h-full">
                        {Array.from({ length: rowsPerColumn }).map((_, i) => {
                             const num = offset + i + 1;
                             if (num > maxPoints) return <div key={i} className="flex-1"></div>;
                             let state: 0 | 1 = 0;
                             let showNumberOnly = false;

                             if (isPanel3) {
                                 // Panel 3 special logic:
                                 // Points 1 to preChangePoints: show number only (no slash) - these are pre-change points
                                 // Points preChangePoints+1 onwards: tick if in markedPoints (scored after change)
                                 if (num <= preChangePoints) {
                                     showNumberOnly = true;
                                 } else {
                                     if (markedPoints && markedPoints.includes(num)) {
                                         state = 1;
                                     }
                                 }
                             } else {
                                 // Normal logic for Panel 2
                                 if (markedPoints.includes(num)) {
                                     state = 1;
                                 }
                             }
                             const isCircled = circledPoints && circledPoints.includes(num);
                             return <PointBox key={i} num={num} filledState={state} isCircled={isCircled} showNumberOnly={showNumberOnly} />
                        })}
                    </div>
                ))}
            </div>
            <div className="bg-white flex flex-col items-center justify-start py-1 shrink-0 " style={{ height: '1.5cm' }}>
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
