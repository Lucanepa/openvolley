import React from 'react';
import { SubRecord } from '../types_scoresheet';
import { PointsColumn5, PointsColumn30 } from './PointsColumn';

interface ServiceRound {
  position: number; // 0-5 for I-VI
  box: number; // 1-6 for Set 5
  ticked: boolean; // Has tick (4) when player starts serving
  points: number | null; // Points scored when service lost (null if still serving)
  circled: boolean; // Circled at end of set for last point
}

// Full black border color for PDF capture
const borderColor75 = { borderColor: '#000000' };

interface SetFiveProps {
    teamNameA?: string;
    teamNameB?: string;
    teamALabel?: string;
    teamBLabel?: string;
    firstServeTeamA?: boolean;
    startTime?: string;
    endTime?: string;

    // Panel 1 (Left A - Before Court Change)
    lineupA?: string[];
    subsA?: SubRecord[][];
    timeoutsA?: [string, string];
    pointsA_Left?: number; // 1-8
    markedPointsA_Left?: number[];
    circledPointsA_Left?: number[];
    serviceRoundsA_Left?: ServiceRound[];

    // Panel 2 (Middle B)
    lineupB?: string[];
    subsB?: SubRecord[][];
    timeoutsB?: [string, string];
    pointsB?: number; // 1-15
    markedPointsB?: number[];
    circledPointsB?: number[];
    serviceRoundsB?: ServiceRound[];

    // Panel 3 (Right A - After Court Change)
    // Lineup A is usually same as Panel 1, but conceptually we might want to pass it if it differs visually
    subsA_Right?: SubRecord[][];
    timeoutsA_Right?: [string, string];
    pointsA_Right?: number; // 1-15
    markedPointsA_Right?: number[];
    circledPointsA_Right?: number[];
    serviceRoundsA_Right?: ServiceRound[];
    pointsAtChangeA?: number; // Left panel team's points at court change
    pointsAtChangeB?: number; // Middle panel team's points at court change

    // Ref for measuring position box width
    positionBoxRef?: React.RefObject<HTMLDivElement>;
}

// S/R Selector for Set 5
const SRSelector: React.FC<{ initialSelection?: 'S' | 'R' | null }> = ({ initialSelection = null }) => {
    return (
        <div className="flex flex-col gap-0.5 mx-1 justify-center">
            {['S', 'R'].map((item) => (
                <div
                    key={item}
                    className="relative w-3 h-3 rounded-full border flex items-center justify-center text-[7px] font-bold bg-white select-none leading-none"
                    style={borderColor75}
                >
                    {item}
                    {initialSelection === item && (
                        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                            <line x1="20" y1="20" x2="80" y2="80" stroke="black" strokeWidth="12" />
                            <line x1="80" y1="20" x2="20" y2="80" stroke="black" strokeWidth="12" />
                        </svg>
                    )}
                </div>
            ))}
        </div>
    );
};

// PointBox is now imported from ./PointsColumn

// TeamServiceGrid for Set 5 - Standalone component with 6 rotation boxes
const TeamServiceGridSet5: React.FC<{
    lineup?: string[],
    subs?: SubRecord[][],
    startsReceiving?: boolean,
    positionBoxRef?: React.RefObject<HTMLDivElement>,
    serviceRounds?: ServiceRound[]
}> = ({ lineup = [], subs = [], startsReceiving = false, positionBoxRef, serviceRounds = [] }) => {
    const positions = [0, 1, 2, 3, 4, 5];

    // Set 5: 6 rotation boxes arranged in 2 columns × 3 rows
    const gridCols = 2;
    const gridRows = 3;
    const rotationHeight = '1.5cm';
    const totalHeight = '3.5cm'; // 0.5cm header + 0.5cm players + 1.5cm subs + 1.5cm rotation = 4.0cm

    return (
        <div className="flex flex-col shrink-0" style={{ width: '60mm', height: totalHeight }}>
            {/* Roman Numerals Header */}
            <div className="flex border-b shrink-0" style={{ height: '5mm', ...borderColor75 }}>
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map((roman, idx) => (
                    <div
                        key={roman}
                        ref={idx === 0 ? positionBoxRef : undefined}
                        className="border-r border-b flex items-center justify-center font-bold bg-gray-100 text-[10px]"
                        style={{ width: '10mm', height: '5mm', ...borderColor75 }}
                    >
                        {roman}
                    </div>
                ))}
            </div>

            {/* Starting Players Row */}
            <div className="flex border-b shrink-0" style={{ height: '5mm', ...borderColor75 }}>
                {positions.map((i) => (
                    <div key={i} className="border-r p-0.5 flex items-center justify-center" style={{ width: '10mm', height: '5mm', ...borderColor75 }}>
                        <div className="font-bold text-sm text-center print:text-base">{lineup[i] || ''}</div>
                    </div>
                ))}
            </div>

            {/* Substitutions Area */}
            <div className="flex shrink-0" style={{ height: '1.5cm' }}>
                {positions.map((colIdx) => {
                    const posSubs = subs[colIdx] || [];
                    const sub1 = posSubs[0];
                    const sub2 = posSubs[1];

                    return (
                        <div key={colIdx} className="border-r flex flex-col h-full" style={{ width: '10mm', ...borderColor75 }}>
                            {/* Substitution Row - Only PlayerIn (PlayerOut is already in lineup row) */}
                            <div className="border-b shrink-0 p-0.5 flex items-center justify-center relative" style={{ height: '0.5cm', ...borderColor75 }}>
                                {sub1 ? (
                                    <>
                                        <div className="text-[14px] text-center font-bold">
                                            {sub1.playerIn}
                                        </div>
                                        {/* Circle around playerIn if substitution is closed (can't re-enter) */}
                                        {sub1.isCircled && (
                                            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" style={{ overflow: 'visible' }}>
                                                <circle cx="50" cy="50" r="42" fill="none" stroke="black" strokeWidth="2" />
                                            </svg>
                                        )}
                                    </>
                                ) : sub2 ? (
                                    <>
                                        <div className="text-[14px] text-center font-bold">
                                            {sub2.playerIn}
                                        </div>
                                        {/* Circle around playerIn if substitution is closed (can't re-enter) */}
                                        {sub2.isCircled && (
                                            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" style={{ overflow: 'visible' }}>
                                                <circle cx="50" cy="50" r="42" fill="none" stroke="black" strokeWidth="2" />
                                            </svg>
                                        )}
                                    </>
                                ) : (
                                    <div className="text-[14px] text-center"></div>
                                )}
                            </div>
                            {/* Sub 1 Score - upper box */}
                            <div className="border-b flex items-center justify-center" style={{ height: '0.5cm', ...borderColor75 }}>
                                {sub1 && sub1.score ? (
                                    <div className="text-[12px] text-center leading-tight flex items-center gap-0.5">
                                        <span>{sub1.score.split(':')[0]}</span>
                                        <span>:</span>
                                        <span>{sub1.score.split(':')[1]}</span>
                                    </div>
                                ) : (
                                    <div className="text-[12px] text-center leading-tight">:</div>
                                )}
                            </div>

                            {/* Sub 2 Score - lower box (for return substitution) */}
                            <div className="flex items-center border-b justify-center bg-white" style={{ height: '0.5cm', ...borderColor75 }}>
                                {sub2 && sub2.score ? (
                                    <div className="text-[12px] text-center leading-tight flex items-center gap-0.5">
                                        <span>{sub2.score.split(':')[0]}</span>
                                        <span>:</span>
                                        <span>{sub2.score.split(':')[1]}</span>
                                    </div>
                                ) : (
                                    <div className="text-[12px] text-center leading-tight">:</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Service Rotation Area - 6 boxes (2 cols × 3 rows) */}
            <div className="flex shrink-0" style={{ height: rotationHeight }}>
                {positions.map((colIdx, colArrIdx) => {
                    const isLastPosition = colArrIdx === positions.length - 1;
                    return (
                        <div
                            key={colIdx}
                            className={`flex flex-col h-full border-r`}
                            style={{ width: '10mm', ...borderColor75 }}
                        >
                            {/* 2×3 Grid with rotation boxes 1-6 */}
                            <div
                                className="grid h-full relative"
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(2, 1fr)',
                                    gridTemplateRows: 'repeat(3, 1fr)',
                                    gridAutoFlow: 'column'
                                }}
                            >
                                {/* Vertical divider between columns */}
                                <div
                                    className="absolute top-0 bottom-0 border-l pointer-events-none"
                                    style={{ left: '50%', transform: 'translateX(-0.5px)', ...borderColor75 }}
                                />

                                {/* Horizontal divider after row 1 */}
                                <div
                                    className="absolute left-0 right-0 border-t pointer-events-none"
                                    style={{ top: 'calc(100% / 3)', transform: 'translateY(-0.5px)', ...borderColor75 }}
                                />

                                {/* Horizontal divider after row 2 */}
                                <div
                                    className="absolute left-0 right-0 border-t pointer-events-none"
                                    style={{ top: 'calc(100% / 3 * 2)', transform: 'translateY(-0.5px)', ...borderColor75 }}
                                />

                                {/* Rotation boxes 1-6 */}
                                {[1, 2, 3, 4, 5, 6].map((num, boxIdx) => {
                                    const showX = startsReceiving && colIdx === 0 && num === 1;

                                    // Find service round data for this position and box
                                    const serviceRound = serviceRounds.find(sr => sr.position === colIdx && sr.box === num);
                                    const hasPoints = serviceRound && serviceRound.points !== null && serviceRound.points !== undefined;
                                    const isTicked = serviceRound?.ticked || false;
                                    const isCircled = serviceRound?.circled || false;

                                    return (
                                        <div
                                            key={num}
                                            className="relative flex items-center justify-center"
                                            style={{ height: '5mm' }}
                                        >
                                            <span className="absolute top-[0.5px] right-[1px] text-[6px] leading-none text-black font-medium pointer-events-none">
                                                {num}
                                            </span>
                                            {/* Tick/slash through the box number when this position served */}
                                            {isTicked && !showX && (
                                                <svg className="absolute top-0 right-0 w-[1.5mm] h-[1.5mm] pointer-events-none" viewBox="0 0 100 100">
                                                    <line x1="15" y1="85" x2="85" y2="15" stroke="black" strokeWidth="10" />
                                                </svg>
                                            )}
                                            {showX && (
                                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                                    <line x1="20" y1="20" x2="80" y2="80" stroke="black" strokeWidth="8" />
                                                    <line x1="80" y1="20" x2="20" y2="80" stroke="black" strokeWidth="8" />
                                                </svg>
                                            )}
                                            {/* Points scored when service lost - but not if this is the initial X box */}
                                            {hasPoints && serviceRound && !showX && (
                                                <span className="absolute inset-0 flex items-center justify-center text-[10.5px] font-bold text-black pointer-events-none">
                                                    {serviceRound.points}
                                                </span>
                                            )}
                                            {/* Circle for last point at end of set */}
                                            {isCircled && (
                                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                                    <circle cx="50" cy="50" r="45" fill="none" stroke="black" strokeWidth="3" />
                                                </svg>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// PointsColumn5 and PointsColumn30 are now imported from ./PointsColumn

export const SetFive: React.FC<SetFiveProps> = ({
    teamNameA,
    teamNameB,
    teamALabel = 'A',
    teamBLabel = 'B',
    firstServeTeamA,
    startTime,
    endTime,
    lineupA,
    subsA,
    timeoutsA,
    pointsA_Left,
    markedPointsA_Left = [],
    circledPointsA_Left = [],
    serviceRoundsA_Left = [],
    lineupB,
    subsB,
    timeoutsB,
    pointsB,
    markedPointsB = [],
    circledPointsB = [],
    serviceRoundsB = [],
    subsA_Right,
    timeoutsA_Right,
    pointsA_Right,
    markedPointsA_Right = [],
    circledPointsA_Right = [],
    serviceRoundsA_Right = [],
    pointsAtChangeA = 0,
    pointsAtChangeB = 0,
    positionBoxRef
}) => {
  // Calculate max score for dynamic points column sizing (Panel 2 and 3 use PointsColumn30)
  const maxScore = Math.max(pointsB || 0, pointsA_Right || 0);

  return (
    <div className="border bg-white flex flex-col overflow-hidden shadow-sm shrink-0 relative" style={{ width: '229mm', ...borderColor75 }}>
       {/* Header Strip */}
       <div className="flex bg-gray-100 text-xs shrink-0" style={{ height: '0.8cm', width: '229mm', ...borderColor75 }}>
           {/* Start Time */}
           <div className="border-r flex items-center px-2 gap-2 bg-white shrink-0" style={{ width: '20mm', ...borderColor75 }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
           </div>

           {/* Panel 1 Header: Team A (Left) */}
                   <div className="border-r flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm', ...borderColor75 }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center" style={borderColor75}>{teamALabel}</div>
                        <SRSelector initialSelection={firstServeTeamA === true ? 'S' : firstServeTeamA === false ? 'R' : null} />
                    </div>
                    <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1">{teamNameA || ''}</div>
                </div>
           </div>
                   <div className="border-r flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15.2mm', ...borderColor75 }}>Points</div>

           {/* Panel 2 Header: Team RIGHT */}
           <div className="border-r flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm', ...borderColor75 }}>
                <div className="flex items-center gap-1 w-full justify-end">
                    <div className="w-full text-xs uppercase text-center font-bold bg-white mr-1">{teamNameB || ''}</div>
                    <div className="flex items-center gap-1">
                        <SRSelector initialSelection={firstServeTeamA === true ? 'R' : firstServeTeamA === false ? 'S' : null} />
                        <div className="w-6 h-6 rounded-full border text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center" style={borderColor75}>{teamBLabel}</div>
                    </div>
                </div>
           </div>
 {/* End Time */}
                   <div className="flex items-center border-r px-2 gap-2 justify-start bg-white shrink-0" style={{ width: '20.05mm', ...borderColor75 }}>
                <span className="font-bold text-[9px]">End:</span>
                <div className="bg-transparent text-center font-mono text-xs">{endTime}</div>
           </div>
                   <div className="border-r flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm', ...borderColor75 }}>Points</div>
           {/* Panel 3 Header: Team LEFT (Swapped) */}
           <div className="border-r flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '29.75mm', marginLeft: '3mm', ...borderColor75 }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center" style={borderColor75}>{teamALabel}</div>
                    </div>
                    <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1">{teamNameA || ''}</div>
                </div>
           </div>



           {/* Points at Change */}
           <div className="border-r flex items-center px-1 gap-2 bg-white shrink-0" style={{ width: '30mm', ...borderColor75 }}>
                <div className="h-6 border flex items-center justify-center bg-white font-bold text-sm relative" style={{ width: '35px', ...borderColor75 }}>
                    <span className="w-1/2 text-center">{pointsAtChangeA || ''}</span>
                    <span className="text-center text-[10px] font-bold leading-none">:</span>
                    <span className="w-1/2 text-center">{pointsAtChangeB || ''}</span>
                </div>
                <span className="text-[8px] font-bold leading-none text-center">Points at change</span>
           </div>
           <div className="flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>
       </div>

       {/* Court Change Box - spans full height of Set 5 (positioned at container level) */}
       <div className="absolute flex items-center justify-center border border-b-0 border-t-0 bg-gray-100 z-10" style={{ width: '3mm', top: 0, bottom: 0, left: '150mm', ...borderColor75 }}>
            <div className="transform -rotate-90 text-[7px] font-bold uppercase tracking-wider whitespace-nowrap">
                Court Change
            </div>
       </div>

       {/* Main Body - 3 Panels */}
       <div className="flex justify-start shrink-0" style={{ width: '229mm', height: '4cm' }}>
            {/* Panel 1: Team A */}
            <div className="flex border border-l-0 border-r-0 border-b-0 shrink-0" style={{ width: '75mm', ...borderColor75 }}>
                 <TeamServiceGridSet5 lineup={lineupA} subs={subsA} startsReceiving={firstServeTeamA === false} positionBoxRef={positionBoxRef} serviceRounds={serviceRoundsA_Left} />
                 <PointsColumn5 timeouts={timeoutsA || ["", ""]} markedPoints={markedPointsA_Left || []} circledPoints={circledPointsA_Left || []} />
            </div>

            {/* Panel 2: Team B */}
            <div className="flex border border-r-0 border-b-0 shrink-0" style={{ width: '75mm', ...borderColor75 }}>
                 <TeamServiceGridSet5 lineup={lineupB} subs={subsB} startsReceiving={firstServeTeamA === true} serviceRounds={serviceRoundsB} />
                 <PointsColumn30 timeouts={timeoutsB || ["", ""]} markedPoints={markedPointsB || []} circledPoints={circledPointsB || []} maxScore={maxScore} />
            </div>

            {/* Panel 3: Team A (Swapped) */}
            <div className="flex border border-l-0 border-r-0 border-b-0 shrink-0" style={{ width: '76mm', marginLeft: '3mm', ...borderColor75 }}>
                 <TeamServiceGridSet5 lineup={lineupA} subs={subsA_Right || subsA} startsReceiving={false} serviceRounds={serviceRoundsA_Right} />
                 <PointsColumn30 isLast={true} isPanel3={true} timeouts={timeoutsA_Right || timeoutsA || ["", ""]} markedPoints={markedPointsA_Right || []} circledPoints={circledPointsA_Right || []} preChangePoints={pointsAtChangeA} maxScore={maxScore} />
            </div>
       </div>
    </div>
  );
};
