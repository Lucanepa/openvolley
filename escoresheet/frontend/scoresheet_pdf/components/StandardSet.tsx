import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';
import { PointsColumn } from './PointsColumn';

interface ServiceRound {
  position: number; // 0-5 for I-VI
  box: number; // 1-8
  ticked: boolean; // Has tick (4) when player starts serving
  points: number | null; // Points scored when service lost (null if still serving)
  circled: boolean; // Circled at end of set for last point
}

// 75% black border color
const borderColor75 = { borderColor: 'rgba(0, 0, 0, 0.75)' };

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
}

// PointBox is now imported from ./PointsCol/87umn

// Service/Reception Selector (S above R) - Static version
export const SRSelector: React.FC<{ initialSelection?: 'S' | 'R' | null }> = ({ initialSelection = null }) => {
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
                            <line x1="20" y1="20" x2="80" y2="80" stroke="black" strokeWidth="15" />
                            <line x1="80" y1="20" x2="20" y2="80" stroke="black" strokeWidth="15" />
                        </svg>
                    )}
                </div>
            ))}
        </div>
    );
};

// PointsColumn is now imported from ./PointsColumn

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
    const rotationHeight = '2cm';
    const totalHeight = '4.5cm';

    return (
        <div className="flex flex-col shrink-0 border-b" style={{ width: '60mm', height: totalHeight }}>
            {/* Roman Numerals Header */}
            <div className="flex border-b shrink-0" style={{ height: '5mm', ...borderColor75 }}>
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map((roman, idx) => (
                    <div 
                        key={roman} 
                        ref={idx === 0 ? positionBoxRef : undefined}
                        className="border-r border-b last:border-r-0 flex items-center justify-center font-bold bg-gray-100 text-[10px]"
                        style={{ width: '10mm', height: '5mm', ...borderColor75 }}
                    >
                        {roman}
                    </div>
                ))}
            </div>

            {/* Starting Players Row */}
            <div className="flex border-b shrink-0" style={{ height: '5mm', ...borderColor75 }}>
                {positions.map((i) => (
                    <div key={i} className="border-r last:border-none p-0.5 flex items-center justify-center relative" style={{ width: '10mm', height: '5mm', ...borderColor75 }}>
                        <div className="font-bold text-sm text-center print:text-base">{lineup[i] || ''}</div>
                    </div>
                ))}
            </div>

            {/* Substitutions Area */}
            <div className="flex shrink-0" style={{ height: '1.5cm' }}>
                {positions.map((colIdx) => {
                    // Get subs for this specific position (I-VI)
                    const posSubs = subs[colIdx] || [];
                    const sub1 = posSubs[0];
                    const sub2 = posSubs[1];

                    return (
                        <div key={colIdx} className="border-r last:border-none flex flex-col h-full" style={{ width: '10mm', ...borderColor75 }}>
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

            {/* Service Rotation Area */}
            <div className="flex shrink-0 border-b-0" style={{ height: rotationHeight, ...borderColor75 }}>
                {positions.map((colIdx, colArrIdx) => {
                    // For receiving team, position I (colIdx === 0), box 1 gets an X
                    const isLastPosition = colArrIdx === positions.length - 1;
                    return (
                        <div 
                            key={colIdx} 
                            className={`flex flex-col h-full ${isLastPosition ? '' : 'border-r'}`}
                            style={{ width: '10mm', ...(isLastPosition ? {} : borderColor75) }}
                        >
                            {/* Rotation Box Grid for Service Order tracking */}
                            <div 
                                className="grid grid-flow-col h-full relative" 
                                style={{ 
                                    gridTemplateColumns: `repeat(${gridCols}, 1fr)`, 
                                    gridTemplateRows: `repeat(${gridRows}, 1fr)` 
                                }}
                            >
                                {/* Vertical divider between the two columns - spans full height */}
                                <div 
                                    className="absolute top-0 bottom-0 left-1/2 border-l pointer-events-none"
                                    style={{ transform: 'translateX(-50%)', borderColor: 'rgba(0, 0, 0, 0.50)' }}
                                />
                                
                                {rotationNumbers.map((num, boxIdx) => {
                                    // X marks position I box 1 for receiving team (they start there, never serve from I)
                                    const showX = startsReceiving && colIdx === 0 && num === 1;

                                    // Find service round data for this position and box
                                    const serviceRound = serviceRounds.find(sr => sr.position === colIdx && sr.box === num);
                                    const hasPoints = serviceRound && serviceRound.points !== null && serviceRound.points !== undefined;
                                    const isTicked = serviceRound?.ticked || false;
                                    const isCircled = serviceRound?.circled || false;
                                    
                                    // Calculate row position for horizontal borders
                                    const row = Math.floor(boxIdx / gridCols);
                                    const isLastRow = row === gridRows - 0;
                                    
                                    // Add horizontal borders between rows (3 borders for 4 rows, 2 for 3 rows)
                                    // Don't add border to last row (top and bottom are from overall structure)
                                    const boxClass = [
                                        'relative',
                                        'flex',
                                        'items-center',
                                        'justify-center',
                                        !isLastRow ? 'border-b-0.5' : '',
                                    ]
                                    .filter(Boolean)
                                    .join(' ');

                                    return (
                                        <div 
                                            key={num} 
                                            className={boxClass}
                                            style={{
                                                width: '5mm', 
                                                height: '5.05mm',
                                                borderBottom: '0.5px solid rgba(0, 0, 0, 0.75)',
                                            }}
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
    positionBoxRef
}) => {
  // A/B labels are always shown based on position (left=A when not swapped, left=B when swapped)
  const leftTeamLabel = isSwapped ? 'B' : 'A';
  const rightTeamLabel = isSwapped ? 'A' : 'B';
  
  // Determine who serves/receives based on coin toss (Set 1) or switched sides
  // Pattern: Set 1 (A serves if coinTossServeA), Set 2 (opposite - teams switch), Set 3 (same as Set 1 - teams back), Set 4 (opposite - teams switch)
  let leftServes: 'S' | 'R' | null = null;
  let rightServes: 'S' | 'R' | null = null;
  
  if (firstServeTeamA !== undefined) {
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
    <div className="border bg-white flex flex-col overflow-hidden shadow-sm shrink-0" style={{ width: '150mm', ...borderColor75 }}>
        {/* Header Strip */}
        <div className="flex border-b bg-gray-100 shrink-0" style={{ height: '0.8cm', width: '150mm', ...borderColor75 }}>
             {/* Start Time */}
             <div className="border-r flex items-center px-2 gap-2 bg-white shrink-0" style={{ width: '20mm', ...borderColor75 }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
             </div>
             {/* Team Left (A or B) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="border-r flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40.3mm', ...borderColor75 }}>
                 <div className="flex items-center gap-1 w-full">
                     <div className="flex items-center gap-1">
                         <div className="w-6 h-6 rounded-full border flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0" style={borderColor75}>
                            {leftTeamLabel}
                         </div>
                         <SRSelector initialSelection={leftServes} />
                     </div>
                     <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1">{teamNameLeft}</div>
                 </div>
             </div>
             <div className="border-r flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '14.7mm', ...borderColor75 }}>Points</div>
              {/* Team Right (B or A) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="border-r flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm', ...borderColor75 }}>
                 <div className="flex items-center gap-1 w-full justify-end">
                     <div className="w-full text-xs uppercase font-bold text-center bg-white mr-1">{teamNameRight}</div>
                     <div className="flex items-center gap-1">
                        <SRSelector initialSelection={rightServes} />
                        <div className="w-6 h-6 rounded-full border flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0" style={borderColor75}>
                            {rightTeamLabel}
                        </div>
                     </div>
                 </div>
             </div>
              {/* End Time */}
             <div className="flex items-center px-2 gap-2 justify-start bg-white shrink-0" style={{ width: '20mm' }}>
                <span className="font-bold text-[9px]">End:</span>
                <div className="bg-transparent text-center font-mono text-xs">{endTime}</div>
             </div>
             <div className="flex items-center border-l justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm', ...borderColor75 }}>Points</div>
        </div>

        {/* Main Body - Teams side by side with points on their right */}
        <div className="flex flex-1 justify-start shrink-0" style={{ width: '150mm' }}>
            {/* Team Left Block - fixed width to match header */}
            <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={leftLineup} subs={leftSubs} startsReceiving={leftServes === 'R'} positionBoxRef={positionBoxRef} serviceRounds={leftServiceRounds} />
                <PointsColumn timeouts={leftTimeouts} markedPoints={leftMarkedPoints} circledPoints={leftCircledPoints} maxScore={maxScore} />
            </div>

            {/* Team Right Block - fixed width to match header */}
             <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={rightLineup} subs={rightSubs} startsReceiving={rightServes === 'R'} serviceRounds={rightServiceRounds} />
                <PointsColumn isLast={true} timeouts={rightTimeouts} markedPoints={rightMarkedPoints} circledPoints={rightCircledPoints} maxScore={maxScore} />
            </div>
        </div>
    </div>
  );
};