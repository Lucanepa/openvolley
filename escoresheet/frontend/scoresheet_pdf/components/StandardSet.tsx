import React from 'react';
import { MARK_STROKE } from './Marks';
import { SubRecord } from '../types_scoresheet';
import { PointsColumn } from './PointsColumn';
import { StrikeZ } from './StrikeZ';
import { FitText } from './FitText';
import { ServiceBox, SubstitutionCells } from './ServiceBox';

interface ServiceRound {
  position: number; // 0-5 for I-VI
  box: number; // 1-8
  ticked: boolean; // Has tick (4) when player starts serving
  points: number | null; // Points scored when service lost (null if still serving)
  circled: boolean; // Circled at end of set for last point
}


interface StandardSetProps {
  setNumber: number;
  isSwapped?: boolean;
  firstServeTeamA?: boolean; // true if Team A serves first, false if Team B serves first
  // Data Props
  teamNameLeft?: string;
  teamNameRight?: string;
  startTime?: string;
  endTime?: string;
  
  // Left Team Data
  leftLineup?: string[];
  leftSubs?: SubRecord[][];
  leftTimeouts?: [string, string];
  leftPoints?: number;
  leftMarkedPoints?: number[];
  leftCircledPoints?: number[];
  leftServiceRounds?: ServiceRound[];

  // Right Team Data
  rightLineup?: string[];
  rightSubs?: SubRecord[][];
  rightTimeouts?: [string, string];
  rightPoints?: number;
  rightMarkedPoints?: number[];
  rightCircledPoints?: number[];
  rightServiceRounds?: ServiceRound[];
  
  // Ref for measuring position box width
  positionBoxRef?: React.RefObject<HTMLDivElement>;
  // True when the set is finished — enables T-bar finalization of unused numbers
  setFinished?: boolean;
  /** Unused grid (unplayed set, or a set awarded by default): struck off with a Z. */
  struckOff?: boolean;
}


// Service/Reception Selector (S above R) - Static version
export const SRSelector: React.FC<{ initialSelection?: 'S' | 'R' | null }> = ({ initialSelection = null }) => {
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


// TeamServiceGrid for Sets 1-4 (8 rotation boxes)
export const TeamServiceGrid: React.FC<{ 
  lineup?: string[], 
  subs?: SubRecord[][], 
  startsReceiving?: boolean, 
  positionBoxRef?: React.RefObject<HTMLDivElement>,
  serviceRounds?: ServiceRound[]
}> = ({ lineup = [], subs = [], startsReceiving = false, positionBoxRef, serviceRounds = [] }) => {
    // Ensure we have 6 positions for rendering even if data is missing
    const positions = [0, 1, 2, 3, 4, 5];
    
    // Sets 1-4: 8 boxes (2 columns x 4 rows)
    const rotationNumbers = Array.from({ length: 8 }, (_, i) => i + 1);
    const gridCols = 2;
    const gridRows = 4;

    // Calculate total height for Sets 1-4: 0.5cm + 0.5cm + 1.5cm + 2.0cm = 4.5cm to match PointsColumn
    const rotationHeight = '20mm';
    const totalHeight = '45mm';

    return (
        <div className="flex flex-col shrink-0" style={{ width: '60mm', height: totalHeight }} data-testid="service-grid">
            {/* Roman Numerals Header */}
            <div className="flex shrink-0" style={{ height: '5mm' }}>
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map((roman, idx, arr) => {
                    const isLast = idx === arr.length - 1;
                    return (
                        <div
                            key={roman}
                            ref={idx === 0 ? positionBoxRef : undefined}
                            className={`flex items-center justify-center font-bold bg-gray-100 text-[10px] border-black border-b border-t ${isLast ? 'border-r-0' : 'border-r'}`}
                            style={{ width: '10mm', height: '5mm'}}
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

            {/* Service Rotation Area: per position two columns of round boxes (1-4 | 5-8) */}
            <div className="flex shrink-0" style={{ height: rotationHeight }}>
                {positions.map((colIdx, colArrIdx) => {
                    const isLastPosition = colArrIdx === positions.length - 1;
                    return (
                        <div
                            key={colIdx}
                            className={`grid h-full ${isLastPosition ? '' : 'border-r border-black'}`}
                            style={{ width: '10mm', gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${gridRows}, 5mm)`, gridAutoFlow: 'column' }}
                        >
                            {rotationNumbers.map((num) => (
                                <div key={num} className={num <= gridRows ? 'border-r ss-rule' : ''}>
                                    <ServiceBox
                                        num={num}
                                        // X: the receiving team's position I, round 1 (it never serves from there)
                                        showX={startsReceiving && colIdx === 0 && num === 1}
                                        round={serviceRounds.find(sr => sr.position === colIdx && sr.box === num)}
                                        // the set box's own border is the bottom line
                                        lastRow={num % gridRows === 0}
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

export const StandardSet: React.FC<StandardSetProps> = ({ 
    setNumber, 
    isSwapped = false,
    firstServeTeamA,
    teamNameLeft,
    teamNameRight,
    startTime,
    endTime,
    leftLineup,
    leftSubs,
    leftTimeouts,
    leftPoints,
    leftMarkedPoints = [],
    leftCircledPoints = [],
    leftServiceRounds = [],
    rightLineup,
    rightSubs,
    rightTimeouts,
    rightPoints,
    rightMarkedPoints = [],
    rightCircledPoints = [],
    rightServiceRounds = [],
    positionBoxRef,
    setFinished = false,
    struckOff = false
}) => {
  // A/B labels are always shown based on position (left=A when not swapped, left=B when swapped)
  const leftTeamLabel = isSwapped ? 'B' : 'A';
  const rightTeamLabel = isSwapped ? 'A' : 'B';
  
  // Determine who serves/receives based on coin toss (Set 1) or switched sides
  // Pattern: Set 1 (A serves if coinTossServeA), Set 2 (opposite - teams switch), Set 3 (same as Set 1 - teams back), Set 4 (opposite - teams switch)
  let leftServes: 'S' | 'R' | null = null;
  let rightServes: 'S' | 'R' | null = null;
  
  if (firstServeTeamA !== undefined && firstServeTeamA !== null) {
    // Team A is left when not swapped, right when swapped
    const teamAIsLeft = !isSwapped;

    // Service alternates: Set 1 = firstServeTeamA, Set 2 = !firstServeTeamA, Set 3 = firstServeTeamA, Set 4 = !firstServeTeamA
    // This is because teams switch sides in sets 2 and 4
    const actualFirstServeTeamA = (setNumber % 2 === 1) ? firstServeTeamA : !firstServeTeamA;

    if (teamAIsLeft) {
      // Left = Team A, Right = Team B
      leftServes = actualFirstServeTeamA ? 'S' : 'R';
      rightServes = actualFirstServeTeamA ? 'R' : 'S';
    } else {
      // Left = Team B, Right = Team A
      leftServes = actualFirstServeTeamA ? 'R' : 'S';
      rightServes = actualFirstServeTeamA ? 'S' : 'R';
    }
  }

  // Calculate max score for dynamic points column sizing
  const maxScore = Math.max(leftPoints || 0, rightPoints || 0);

  return (
    <div className="bg-white flex flex-col overflow-hidden shadow-sm shrink-0 border border-black relative" style={{ width: 'calc(150mm + 2px)' }} data-testid="set-box">
        {/* Header Strip */}
        <div className="flex bg-gray-100 shrink-0" style={{ height: '0.8cm', width: '150mm' }}>
             {/* Start Time */}
             <div className="flex items-center pr-2 gap-2 bg-white shrink-0 border-r border-black" style={{ width: '20mm', paddingLeft: '3px' }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
             </div>
             {/* Team Left (A or B) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="flex items-center justify-between px-2 bg-white shrink-0 border-r border-black" style={{ width: '40mm' }}>
                 <div className="flex items-center gap-1 w-full">
                     <div className="flex items-center gap-1">
                         <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                            {leftTeamLabel}
                         </div>
                         <SRSelector initialSelection={leftServes} />
                     </div>
                     <FitText max={12} min={5} multiline style={{ height: '0.7cm' }} className="w-full uppercase leading-none flex items-center justify-center text-center font-bold bg-white ml-1">{teamNameLeft}</FitText>
                 </div>
             </div>
             <div className="flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px] border-r border-black" style={{ width: '15mm' }}>Points</div>
              {/* Team Right (B or A) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="flex items-center justify-between px-2 bg-white shrink-0 border-r border-black" style={{ width: '40mm' }}>
                 <div className="flex items-center gap-1 w-full justify-end">
                     <FitText max={12} min={5} multiline style={{ height: '0.7cm' }} className="w-full uppercase leading-none flex items-center justify-center font-bold text-center bg-white mr-1">{teamNameRight}</FitText>
                     <div className="flex items-center gap-1">
                        <SRSelector initialSelection={rightServes} />
                        <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                            {rightTeamLabel}
                        </div>
                     </div>
                 </div>
             </div>
              {/* End Time */}
             <div className="flex items-center pl-1 pr-1 gap-1 justify-start bg-white shrink-0" style={{ width: '20mm' }}>
                <span className="font-bold text-[9px]">End:</span>
                <div className="bg-transparent text-center font-mono text-xs">{endTime}</div>
             </div>
             <div className="flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px] border-l border-black" style={{ width: '15mm' }}>Points</div>
        </div>

        {/* Main Body - Teams side by side with points on their right */}
        <div className="flex flex-1 justify-start shrink-0" style={{ width: '150mm' }}>
            {/* Team Left Block - fixed width to match header */}
            <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={leftLineup} subs={leftSubs} startsReceiving={leftServes === 'R'} positionBoxRef={positionBoxRef} serviceRounds={leftServiceRounds} />
                <PointsColumn timeouts={leftTimeouts} markedPoints={leftMarkedPoints} circledPoints={leftCircledPoints} maxScore={maxScore} setFinished={setFinished} finalScore={typeof leftPoints === 'number' ? leftPoints : Number(leftPoints) || 0} />
            </div>

            {/* Team Right Block - fixed width to match header */}
             <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={rightLineup} subs={rightSubs} startsReceiving={rightServes === 'R'} serviceRounds={rightServiceRounds} />
                <PointsColumn isLast={true} timeouts={rightTimeouts} markedPoints={rightMarkedPoints} circledPoints={rightCircledPoints} maxScore={maxScore} setFinished={setFinished} finalScore={typeof rightPoints === 'number' ? rightPoints : Number(rightPoints) || 0} />
            </div>
        </div>
        {struckOff && <StrikeZ />}
    </div>
  );
};