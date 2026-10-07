import React from 'react';
import { SubRecord } from '../types_scoresheet';
import { PointsColumn5, PointsColumn30 } from './PointsColumn';
import { StrikeZ } from './StrikeZ';
import { FitText } from './FitText';
import { ServiceBox, SubstitutionCells } from './ServiceBox';
import { MARK_STROKE } from './Marks';

interface ServiceRound {
  position: number; // 0-5 for I-VI
  box: number; // 1-6 for Set 5
  ticked: boolean; // Has tick (4) when player starts serving
  points: number | null; // Points scored when service lost (null if still serving)
  circled: boolean; // Circled at end of set for last point
}

interface SetFiveProps {
    teamNameA?: string;
    teamNameB?: string;
    teamALabel?: string;
    teamBLabel?: string;
    firstServeTeamA?: boolean;
    startTime?: string;
    endTime?: string;
    setFinished?: boolean; // Set ended: void unused point numbers like sets 1-4

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
    /** The left (panel 1/3) team's points at the change of courts; null before the change. */
    pointsAtChangeA?: number | null;
    /** Not printed (the box holds the left team's points only, field-spec 6 step 1). */
    pointsAtChangeB?: number | null;
    /** A deciding set awarded by default: the grid is struck off, nothing else drawn. */
    struckOff?: boolean;

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
                    className="relative w-3 h-3 rounded-full border border-black flex items-center justify-center text-[7px] font-bold bg-white select-none leading-none"
                >
                    {item}
                    {initialSelection === item && (
                        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                            <line x1="18" y1="18" x2="82" y2="82" stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
                            <line x1="82" y1="18" x2="18" y2="82" stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
                        </svg>
                    )}
                </div>
            ))}
        </div>
    );
};

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
    const rotationHeight = '15mm';
    const totalHeight = '40mm'; // 5 mm numerals + 5 mm line-up + 15 mm substitutions + 15 mm service rounds

    return (
        <div className="flex flex-col shrink-0" style={{ width: '60mm', height: totalHeight }}>
            {/* Roman Numerals Header */}
            <div className="flex shrink-0" style={{ height: '5mm' }}>
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map((roman, idx, arr) => {
                    const isLast = idx === arr.length - 1;
                    return (
                        <div
                            key={roman}
                            ref={idx === 0 ? positionBoxRef : undefined}
                            className={`flex items-center justify-center font-bold bg-gray-100 text-[10px] border-black border-b border-t ${isLast ? 'border-r-0' : 'border-r'}`}
                            style={{ width: '10mm', height: '5mm' }}
                        >
                            {roman}
                        </div>
                    );
                })}
            </div>

            {/* Starting Players Row */}
            <div className="flex shrink-0" style={{ height: '5mm' }}>
                {positions.map((i, idx, arr) => {
                    const isLast = idx === arr.length - 1;
                    return (
                        <div key={i} className={`p-0.5 flex items-center justify-center relative bg-white border-black border-b ${isLast ? 'border-r-0' : 'border-r'}`} style={{ width: '10mm', height: '5mm' }}>
                            <div className="font-bold text-sm text-center print:text-base">{lineup[i] || ''}</div>
                        </div>
                    );
                })}
            </div>

            {/* Substitutions Area */}
            <div className="flex shrink-0" style={{ height: '15mm' }}>
                {positions.map((colIdx, colArrIdx) => (
                    <SubstitutionCells key={colIdx} subs={subs[colIdx] || []} lastCol={colArrIdx === positions.length - 1} />
                ))}
            </div>

            {/* Service Rotation Area - per position two columns of round boxes (1-3 | 4-6) */}
            <div className="flex shrink-0" style={{ height: rotationHeight }}>
                {positions.map((colIdx, colArrIdx) => {
                    const isLastPosition = colArrIdx === positions.length - 1;
                    return (
                        <div
                            key={colIdx}
                            className={`grid h-full ${isLastPosition ? '' : 'border-r border-black'}`}
                            style={{ width: '10mm', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(3, 5mm)', gridAutoFlow: 'column' }}
                        >
                            {[1, 2, 3, 4, 5, 6].map((num) => (
                                <div key={num} className={num <= 3 ? 'border-r ss-rule' : ''}>
                                    <ServiceBox
                                        num={num}
                                        showX={startsReceiving && colIdx === 0 && num === 1}
                                        round={serviceRounds.find(sr => sr.position === colIdx && sr.box === num)}
                                        lastRow={num % 3 === 0}
                                    />
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export const SetFive: React.FC<SetFiveProps> = ({
    teamNameA,
    teamNameB,
    teamALabel = 'A',
    teamBLabel = 'B',
    firstServeTeamA,
    startTime,
    endTime,
    setFinished = false,
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
    pointsAtChangeA = null,
    positionBoxRef,
    struckOff = false
}) => {
  // Left (panel 1/3) team's full score: panel 1 holds 1-8, panel 3 the rest (pointsA_Right = score - 8)
  const finalScoreA = (pointsA_Left || 0) + (pointsA_Right || 0);
  const finalScoreB = pointsB || 0;
  // Calculate max score for dynamic points column sizing (Panel 2 and 3 use PointsColumn30;
  // panel 3 numbers the left team's points from 1, so size it on the full score)
  const maxScore = Math.max(finalScoreB, finalScoreA);

  return (
    <div className="border border-black bg-white flex flex-col overflow-hidden shadow-sm shrink-0 relative" style={{ width: 'calc(229mm + 2px)' }} data-testid="set5-box">
       {/* Header Strip */}
       <div className="flex bg-gray-100 text-xs shrink-0" style={{ height: '0.8cm', width: '229mm' }}>
           {/* Start Time */}
           <div className="border-r border-black flex items-center pr-2 gap-2 bg-white shrink-0" style={{ width: '20mm', paddingLeft: '3px' }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
           </div>

           {/* Panel 1 Header: Team A (Left) */}
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm' }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center">{teamALabel}</div>
                        <SRSelector initialSelection={firstServeTeamA === true ? 'S' : firstServeTeamA === false ? 'R' : null} />
                    </div>
                    <FitText max={12} min={5} multiline style={{ height: '0.7cm' }} className="w-full uppercase leading-none flex items-center justify-center text-center font-bold bg-white ml-1">{teamNameA || ''}</FitText>
                </div>
           </div>
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>

           {/* Panel 2 Header: Team RIGHT */}
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm' }}>
                <div className="flex items-center gap-1 w-full justify-end">
                    <FitText max={12} min={5} multiline style={{ height: '0.7cm' }} className="w-full uppercase leading-none flex items-center justify-center text-center font-bold bg-white mr-1">{teamNameB || ''}</FitText>
                    <div className="flex items-center gap-1">
                        <SRSelector initialSelection={firstServeTeamA === true ? 'R' : firstServeTeamA === false ? 'S' : null} />
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center">{teamBLabel}</div>
                    </div>
                </div>
           </div>
           {/* End Time */}
           <div className="flex items-center border-r border-black pl-1 pr-1 gap-1 justify-start bg-white shrink-0" style={{ width: '20mm' }}>
                <span className="font-bold text-[9px]">End:</span>
                <div className="bg-transparent text-center font-mono text-xs">{endTime}</div>
           </div>
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>
           {/* Panel 3 Header: Team LEFT (Swapped) */}
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '30mm', marginLeft: '3.5mm' }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center">{teamALabel}</div>
                    </div>
                    <FitText max={12} min={5} multiline style={{ height: '0.7cm' }} className="w-full uppercase leading-none flex items-center justify-center text-center font-bold bg-white ml-1">{teamNameA || ''}</FitText>
                </div>
           </div>

           {/* Points at Change */}
           <div className="border-r border-black flex items-center px-1 gap-2 bg-white shrink-0" style={{ width: '30mm' }}>
                <div className="h-6 border border-black flex items-center justify-center bg-white font-bold text-sm relative" style={{ width: '35px' }} data-testid="set5-points-at-change">
                    {pointsAtChangeA !== null && pointsAtChangeA !== undefined ? pointsAtChangeA : ''}
                </div>
                <span className="text-[8px] font-bold leading-none text-center">Points at change</span>
           </div>
           <div className="flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15.5mm' }}>Points</div>
       </div>

       {/* Court Change Box - spans full height of Set 5 (positioned at container level) */}
       <div className="absolute flex items-center justify-center border-l border-r border-black bg-gray-100 z-10" style={{ width: '3.5mm', top: 0, bottom: 0, left: '150mm' }}>
            <div className="transform -rotate-90 text-[7px] font-bold uppercase tracking-wider whitespace-nowrap">
                Court Change
            </div>
       </div>

       {/* Main Body - 3 Panels */}
       <div className="flex justify-start shrink-0" style={{ width: '229mm', height: '4cm' }}>
            {/* Panel 1: Team A */}
            <div className="flex shrink-0" style={{ width: '75mm' }}>
                 <TeamServiceGridSet5 lineup={lineupA} subs={subsA} startsReceiving={firstServeTeamA === false} positionBoxRef={positionBoxRef} serviceRounds={serviceRoundsA_Left} />
                 <PointsColumn5 timeouts={timeoutsA || ["", ""]} markedPoints={markedPointsA_Left || []} circledPoints={circledPointsA_Left || []} setFinished={setFinished} finalScore={finalScoreA} pointsAtChange={pointsAtChangeA} />
            </div>

            {/* Panel 2: Team B */}
            <div className="flex border-l border-black shrink-0" style={{ width: '75mm' }}>
                 <TeamServiceGridSet5 lineup={lineupB} subs={subsB} startsReceiving={firstServeTeamA === true} serviceRounds={serviceRoundsB} />
                 <PointsColumn30 timeouts={timeoutsB || ["", ""]} markedPoints={markedPointsB || []} circledPoints={circledPointsB || []} maxScore={maxScore} setFinished={setFinished} finalScore={finalScoreB} />
            </div>

            {/* Panel 3: Team A (Swapped) */}
            <div className="flex shrink-0" style={{ width: '75.5mm', marginLeft: '3.5mm' }}>
                 <TeamServiceGridSet5 lineup={lineupA} subs={subsA_Right || subsA} startsReceiving={false} serviceRounds={serviceRoundsA_Right} />
                 <PointsColumn30 isLast={true} isPanel3={true} timeouts={timeoutsA_Right || timeoutsA || ["", ""]} markedPoints={markedPointsA_Right || []} circledPoints={circledPointsA_Right || []} preChangePoints={pointsAtChangeA ?? null} maxScore={maxScore} setFinished={setFinished} finalScore={finalScoreA} />
            </div>
       </div>
       {struckOff && <StrikeZ />}
    </div>
  );
};
