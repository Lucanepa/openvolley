import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';

interface ServiceRound {
  position: number; // 0-5 for I-VI
  box: number; // 1-8
  ticked: boolean; // Has tick (4) when player starts serving
  points: number | null; // Points scored when service lost (null if still serving)
  rotation8: boolean; // Has "8" when opponent must rotate
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
}

// Static Point Box: Display only, not interactive
export const PointBox: React.FC<{ num: number; filledState?: 0 | 1 | 2; isCircled?: boolean }> = ({ num, filledState = 0, isCircled = false }) => {
    // type: 0 = none, 1 = slash, 2 = vertical bar
    return (
        <div 
            className="flex-1 w-full relative flex items-center justify-center"
            
        >
            {/* Background Number - don't render if cancelled (filledState === 2) */}
            {filledState !== 2 && (
                <span className={`text-[8px] leading-none text-black ${filledState !== 0 ? 'opacity-100' : ''}`}>{num}</span>
            )}

            {/* Overlays */}
            {/* Only show slash if not circled (penalty points should only have circle, no slash) */}
            {filledState === 1 && !isCircled && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="0" y1="100" x2="100" y2="0" stroke="black" strokeWidth="15" />
                 </svg>
            )}
            {/* Circle for points scored due to sanctions (penalty points) - no slash, only circle */}
            {isCircled && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="48" fill="none" stroke="black" strokeWidth="12" />
                </svg>
            )}
        </div>
    );
};

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
                            <line x1="20" y1="20" x2="80" y2="80" stroke="black" strokeWidth="15" />
                            <line x1="80" y1="20" x2="20" y2="80" stroke="black" strokeWidth="15" />
                        </svg>
                    )}
                </div>
            ))}
        </div>
    );
};

// The 1-48 Point Column for a single team
export const PointsColumn: React.FC<{ 
  isLast?: boolean, 
  currentScore?: number, 
  timeouts?: [string, string], 
  startsReceiving?: boolean, 
  markedPoints?: number[],
  isSetFinished?: boolean,
  circledPoints?: number[]
}> = ({ isLast, currentScore = 0, timeouts = ["", ""], markedPoints = [], isSetFinished = false, circledPoints = [] }) => {
    return (
        <div className={`flex flex-col h-full shrink-0 ${isLast ? '' : 'border-r border-black'}`} style={{ width: '15mm' }}>
            <div 
                className="grid grid-cols-4 bg-white border-b border-l border-black" 
                style={{ height: '3.0cm' }}
            >
                {[0, 12, 24, 36].map((offset) => (
                    <div 
                        key={offset} 
                        className="flex flex-col border-r border-black last:border-none h-full"
                        style={{ minWidth: 0, flex: 1 }}
                    >
                        {Array.from({ length: 12 }).map((_, i) => {
                            const num = offset + i + 1;
                            // Mark point if it's in the markedPoints array
                            // If set is finished, cancel (vertical bar) all unmarked points
                            let state: 0 | 1 | 2 = 0;
                            if (markedPoints.includes(num)) {
                                state = 1; // Slashed (scored)
                            } else if (isSetFinished) {
                                // Find the maximum marked point
                                const maxMarkedPoint = markedPoints.length > 0 ? Math.max(...markedPoints) : 0;
                                // All points after the last marked point should be cancelled
                                if (num > maxMarkedPoint) {
                                    state = 2; // Vertical bar (cancelled - not scored)
                                }
                            }
                            return (
                                <div 
                                    key={i} 
                                    style={{ minHeight: '0', height: 'calc(100% / 12)' }} 
                                    className="flex-1 flex items-center justify-center"
                                >
                                    <PointBox num={num} filledState={state} isCircled={circledPoints.includes(num)} />
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
            {/* TO Boxes - Standardized Size */}
            <div className="bg-white flex flex-col items-center justify-start gap-1 border-l border-black py-1" style={{ height: '1.5cm' }}>
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
            <div className="flex border-b border-black shrink-0" style={{ height: '5mm' }}>
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map((roman, idx) => (
                    <div 
                        key={roman} 
                        ref={idx === 0 ? positionBoxRef : undefined}
                        className="border-r border-b border-black last:border-r-0 flex items-center justify-center font-bold bg-gray-100 text-[10px]"
                        style={{ width: '10mm', height: '5mm' }}
                    >
                        {roman}
                    </div>
                ))}
            </div>

            {/* Starting Players Row */}
            <div className="flex border-b border-black shrink-0" style={{ height: '5mm' }}>
                {positions.map((i) => (
                    <div key={i} className="border-r border-black last:border-none p-0.5 flex items-center justify-center relative" style={{ width: '10mm', height: '5mm' }}>
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
                        <div key={colIdx} className="border-r border-black last:border-none flex flex-col h-full" style={{ width: '10mm' }}>
                            {/* Substitution Row - Only PlayerIn (PlayerOut is already in lineup row) */}
                            <div className="border-b border-black shrink-0 p-0.5 flex items-center justify-center relative" style={{ height: '0.5cm' }}>
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
                            <div className="border-b border-black flex items-center justify-center" style={{ height: '0.5cm' }}>
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
                            <div className="flex items-center border-b border-black justify-center bg-white" style={{ height: '0.5cm' }}>
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
            <div className="flex shrink-0 border-b-0 border-black" style={{ height: rotationHeight }}>
                {positions.map((colIdx, colArrIdx) => {
                    // For receiving team, position I (colIdx === 0), box 1 gets an X
                    const isLastPosition = colArrIdx === positions.length - 1;
                    return (
                        <div 
                            key={colIdx} 
                            className={`flex flex-col h-full ${isLastPosition ? '' : 'border-r border-black'}`}
                            style={{ 
                                width: '10mm',
                            }}
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
                                    className="absolute top-0 bottom-0 left-1/2 border-l border-black pointer-events-none"
                                    style={{ transform: 'translateX(-50%)' }}
                                />
                                
                                {rotationNumbers.map((num, boxIdx) => {
                                    const showX = startsReceiving && colIdx === 0 && num === 1;
                                    
                                    // Find service round data for this position and box
                                    const serviceRound = serviceRounds.find(sr => sr.position === colIdx && sr.box === num);
                                    const hasPoints = serviceRound && serviceRound.points !== null && serviceRound.points !== undefined;
                                    const hasRotation8 = serviceRound?.rotation8 || false;
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
                                        !isLastRow ? 'border-b border-black' : '',
                                    ]
                                    .filter(Boolean)
                                    .join(' ');

                                    return (
                                        <div 
                                            key={num} 
                                            className={boxClass}
                                            style={{
                                                width: '5mm', 
                                                height: '5.1mm',
                                            }}
                                        >
                                            <span className="absolute top-[0.5px] right-[1px] text-[6px] leading-none text-black font-medium pointer-events-none">
                                                {num}
                                            </span>
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
                                            {/* Rotation "8" when opponent must rotate - but not if this is the initial X box */}
                                            {hasRotation8 && !showX && (
                                                <span className="absolute inset-0 flex items-center justify-center text-[10.5px] font-bold text-black pointer-events-none">
                                                    8
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
  // Only show labels if team names are provided (for Set 4, this means shouldShowSet4 is true)
  const leftTeamLabel = teamNameLeft ? (isSwapped ? 'B' : 'A') : '';
  const rightTeamLabel = teamNameRight ? (isSwapped ? 'A' : 'B') : '';
  
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

  return (
    <div className="border border-black bg-white flex flex-col overflow-hidden shadow-sm shrink-0" style={{ width: '150.8mm' }}>
        {/* Header Strip */}
        <div className="flex border-b border-black bg-gray-100 shrink-0" style={{ height: '0.8cm', width: '150mm' }}>
             {/* Start Time */}
             <div className="border-r border-black flex items-center px-2 gap-2 bg-white shrink-0" style={{ width: '20mm' }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
             </div>
             {/* Team Left (A or B) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40.3mm' }}>
                 <div className="flex items-center gap-1 w-full">
                     <div className="flex items-center gap-1">
                         <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                            {leftTeamLabel}
                         </div>
                         <SRSelector initialSelection={leftServes} />
                     </div>
                     <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1">{teamNameLeft}</div>
                 </div>
             </div>
             <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '14.7mm' }}>Points</div>
              {/* Team Right (B or A) - matches TeamServiceGrid (60mm) + PointsColumn (15mm) = 75mm */}
             <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm' }}>
                 <div className="flex items-center gap-1 w-full justify-end">
                     <div className="w-full text-xs uppercase font-bold text-center bg-white mr-1">{teamNameRight}</div>
                     <div className="flex items-center gap-1">
                        <SRSelector initialSelection={rightServes} />
                        <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
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
             <div className="flex items-center border-l border-black justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>
        </div>

        {/* Main Body - Teams side by side with points on their right */}
        <div className="flex flex-1 justify-start shrink-0" style={{ width: '150mm' }}>
            {/* Team Left Block - fixed width to match header */}
            <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={leftLineup} subs={leftSubs} startsReceiving={leftServes === 'R'} positionBoxRef={positionBoxRef} serviceRounds={leftServiceRounds} />
                <PointsColumn currentScore={leftPoints} timeouts={leftTimeouts} markedPoints={leftMarkedPoints} circledPoints={leftCircledPoints} isSetFinished={!!endTime} />
            </div>

            {/* Team Right Block - fixed width to match header */}
             <div className="flex shrink-0" style={{ width: '75mm' }}>
                <TeamServiceGrid lineup={rightLineup} subs={rightSubs} startsReceiving={rightServes === 'R'} serviceRounds={rightServiceRounds} />
                <PointsColumn isLast={true} currentScore={rightPoints} timeouts={rightTimeouts} markedPoints={rightMarkedPoints} circledPoints={rightCircledPoints} isSetFinished={!!endTime} />
            </div>
        </div>
    </div>
  );
};