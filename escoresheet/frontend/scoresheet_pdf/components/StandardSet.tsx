import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';

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

  // Right Team Data
  rightLineup?: string[];
  rightSubs?: SubRecord[][];
  rightTimeouts?: [string, string];
  rightPoints?: number;
}

// Static Point Box: Display only, not interactive
export const PointBox: React.FC<{ num: number; filledState?: 0 | 1 | 2 }> = ({ num, filledState = 0 }) => {
    // type: 0 = none, 1 = slash, 2 = vertical bar
    return (
        <div 
            className="flex-1 w-full border-b border-r border-gray-300 relative flex items-center justify-center"
            style={{ borderColor: '#000' }}
        >
            {/* Background Number */}
            <span className={`text-[10px] font-bold leading-none text-gray-400 ${filledState !== 0 ? 'opacity-50' : ''}`}>{num}</span>
            
            {/* Overlays */}
            {filledState === 1 && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="0" y1="100" x2="100" y2="0" stroke="black" strokeWidth="4" />
                 </svg>
            )}
            {filledState === 2 && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="50" y1="0" x2="50" y2="100" stroke="black" strokeWidth="4" />
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
export const PointsColumn: React.FC<{ isLast?: boolean, currentScore?: number, timeouts?: [string, string], startsReceiving?: boolean }> = ({ isLast, currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className={`flex flex-col h-full w-24 ${isLast ? '' : 'border-r-2 border-black'}`}>
            <div className="flex-1 grid grid-cols-4 bg-white border-b border-black">
                {[0, 12, 24, 36].map((offset) => (
                    <div key={offset} className="flex flex-col border-r border-black last:border-none h-full">
                        {Array.from({ length: 12 }).map((_, i) => {
                            const num = offset + i + 1;
                            // Determine state: 1 (slash) if num <= currentScore
                            const state: 0 | 1 | 2 = num <= currentScore ? 1 : 0;
                            return <PointBox key={i} num={num} filledState={state} />;
                        })}
                    </div>
                ))}
            </div>
            {/* TO Boxes - Standardized Size */}
            <div className="h-16 bg-white flex flex-col items-center justify-start gap-1 border-t border-black py-1">
                <span className="text-[10px] font-bold leading-none">"T"</span>
                <div className="flex flex-col gap-1 w-full px-2 items-center">
                    <div className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center">{timeouts[0]}</div>
                    <div className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center">{timeouts[1]}</div>
                </div>
            </div>
        </div>
    );
};

export const TeamServiceGrid: React.FC<{ lineup?: string[], subs?: SubRecord[][], startsReceiving?: boolean }> = ({ lineup = [], subs = [], startsReceiving = false }) => {
    // Ensure we have 6 positions for rendering even if data is missing
    const positions = [0, 1, 2, 3, 4, 5];

    return (
        <div className="flex-1 flex flex-col h-full border-r border-black min-w-0">
            {/* Roman Numerals Header */}
            <div className="grid grid-cols-6 border-b-2 border-black h-5 shrink-0">
                {['I', 'II', 'III', 'IV', 'V', 'VI'].map(roman => (
                    <div key={roman} className="border-r border-black last:border-none flex items-center justify-center font-bold bg-gray-100 text-[10px]">
                        {roman}
                    </div>
                ))}
            </div>

            {/* Starting Players Row */}
            <div className="grid grid-cols-6 border-b-2 border-black h-8 shrink-0">
                {positions.map((i) => (
                    <div key={i} className="border-r border-black last:border-none p-0.5 flex items-center justify-center">
                        <div className="font-bold text-sm text-center">{lineup[i] || ''}</div>
                    </div>
                ))}
            </div>

            {/* Substitutions Area */}
            <div className="flex-1 grid grid-cols-6 min-h-0">
                {positions.map((colIdx) => {
                    // Get subs for this specific position (I-VI)
                    const posSubs = subs[colIdx] || [];
                    const sub1 = posSubs[0];
                    const sub2 = posSubs[1];
                    // Get subsequent subs for the grid (Events 3, 4, etc.)
                    const extraSubs = posSubs.slice(2);

                    return (
                        <div key={colIdx} className="border-r border-black last:border-none flex flex-col h-full">
                            {/* Sub Player Number Row */}
                            <div className="border-b border-black h-8 shrink-0 p-0.5 flex items-center justify-center">
                                <div className="border-b border-gray-200 text-[10px] text-center font-bold">{sub1 ? sub1.playerIn : ''}</div>
                            </div>
                            {/* Sub 1 Score */}
                            <div className="h-6 border-b border-gray-400 flex items-center justify-center">
                                <div className="text-[9px] text-center">{sub1 ? sub1.score : ''}</div>
                            </div>
                            
                            {/* Sub 2 Score (Or Sub 2 Player if needed in a simpler sheet, usually represents score out) */}
                            <div className="h-6 border-b border-gray-400 flex items-center justify-center bg-white">
                                <div className="text-[9px] text-center">{sub2 ? sub2.score : ''}</div>
                            </div>
                            
                            {/* 8-Box Grid for Service Order tracking */}
                            <div className="flex-1 grid grid-cols-2 grid-rows-4 grid-flow-col border-b border-gray-200">
                                {[1, 2, 3, 4, 5, 6, 7, 8].map((num) => {
                                    // For receiving team, position I (colIdx === 0), box 1 gets an X
                                    const showX = startsReceiving && colIdx === 0 && num === 1;
                                    
                                    return (
                                    <div key={num} className="relative border-b border-r border-gray-200 last:border-b-0 last:border-r-0 flex items-center justify-center">
                                        <span className="absolute top-[0.5px] right-[1px] text-[6px] leading-none text-gray-500 font-medium pointer-events-none">
                                            {num}
                                        </span>
                                        {showX && (
                                            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                                <line x1="20" y1="20" x2="80" y2="80" stroke="black" strokeWidth="8" />
                                                <line x1="80" y1="20" x2="20" y2="80" stroke="black" strokeWidth="8" />
                                            </svg>
                                        )}
                                        <div className="text-[8px] text-center"></div>
                                    </div>
                                )})}
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
    rightLineup,
    rightSubs,
    rightTimeouts,
    rightPoints
}) => {
  const leftTeamLabel = isSwapped ? 'B' : 'A';
  const rightTeamLabel = isSwapped ? 'A' : 'B';
  
  // Determine who serves/receives based on coin toss (only for Set 1)
  let leftServes: 'S' | 'R' | null = null;
  let rightServes: 'S' | 'R' | null = null;
  
  if (setNumber === 1 && firstServeTeamA !== undefined) {
    // Team A is left when not swapped, right when swapped
    const teamAIsLeft = !isSwapped;
    
    if (teamAIsLeft) {
      // Left = Team A, Right = Team B
      leftServes = firstServeTeamA ? 'S' : 'R';
      rightServes = firstServeTeamA ? 'R' : 'S';
    } else {
      // Left = Team B, Right = Team A
      leftServes = firstServeTeamA ? 'R' : 'S';
      rightServes = firstServeTeamA ? 'S' : 'R';
    }
  }

  return (
    <div className="border-2 border-black bg-white flex flex-col h-[250px] w-full overflow-hidden shadow-sm">
        {/* Header Strip */}
        <div className="h-8 flex border-b-2 border-black bg-gray-100">
             {/* Start Time */}
             <div className="w-24 border-r border-black flex items-center px-2 gap-2 bg-white">
                <span className="font-bold text-[9px]">Start:</span>
                <div className="w-12 bg-transparent text-center font-mono text-xs">{startTime}</div>
             </div>
             {/* Team Left (A or B) */}
             <div className="flex-1 border-r-2 border-black flex items-center justify-between px-2 bg-white">
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
              {/* Team Right (B or A) */}
             <div className="flex-1 border-r border-black flex items-center justify-between px-2 bg-white">
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
             <div className="w-24 flex items-center px-2 gap-2 justify-end bg-white">
                <span className="font-bold text-[9px]">End:</span>
                <div className="w-12 bg-transparent text-center font-mono text-xs">{endTime}</div>
             </div>
        </div>

        {/* Main Body - Teams side by side with points on their right */}
        <div className="flex flex-1">
            {/* Team Left Block */}
            <div className="flex-1 flex">
                <TeamServiceGrid lineup={leftLineup} subs={leftSubs} startsReceiving={leftServes === 'R'} />
                <PointsColumn currentScore={leftPoints} timeouts={leftTimeouts} />
            </div>

            {/* Team Right Block */}
             <div className="flex-1 flex">
                <TeamServiceGrid lineup={rightLineup} subs={rightSubs} startsReceiving={rightServes === 'R'} />
                <div className="h-full"> 
                    <PointsColumn isLast={true} currentScore={rightPoints} timeouts={rightTimeouts} />
                </div>
            </div>
        </div>
    </div>
  );
};