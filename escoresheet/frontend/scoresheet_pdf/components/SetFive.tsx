
import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';
import { PointBox, SRSelector, TeamServiceGrid } from './StandardSet';

interface SetFiveProps {
    teamNameA?: string;
    teamNameB?: string;
    startTime?: string;
    endTime?: string;
    
    // Panel 1 (Left A)
    lineupA?: string[];
    subsA?: SubRecord[][];
    timeoutsA?: [string, string];
    pointsA_Left?: number; // 1-8

    // Panel 2 (Middle B)
    lineupB?: string[];
    subsB?: SubRecord[][];
    timeoutsB?: [string, string];
    pointsB?: number; // 1-15

    // Panel 3 (Right A Swapped)
    // Lineup A is usually same as Panel 1, but conceptually we might want to pass it if it differs visually
    pointsA_Right?: number; // 1-15
    pointsAtChange?: string;
    
    // Ref for measuring position box width
    positionBoxRef?: React.RefObject<HTMLDivElement>;
}


// Static Point Box for Set 5 - Display only
const PointBoxS: React.FC<{ num: number; filledState?: 0 | 1 | 2 }> = ({ num, filledState = 0 }) => {
    return (
        <div 
            className="flex-1 w-full relative flex items-center justify-center" 
            style={{ borderColor: '#000' }}
        >
            <span className={`text-[10px] leading-none text-black ${filledState !== 0 ? 'opacity-50' : ''}`}>{num}</span>
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

const PointsColumn5: React.FC<{ currentScore?: number, timeouts?: [string, string] }> = ({ currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className="flex flex-col shrink-0 border-l border-black" style={{ width: '15mm', height: '3.5cm' }}>
            <div className="grid grid-cols-3 bg-white border-black shrink-0" style={{ height: '2.48cm' }}>
                <div className="h-full"></div>
                <div className="flex flex-col h-full">
                    {Array.from({ length: 8 }).map((_, i) => {
                        const num = i + 1;
                        const state = num <= currentScore ? 1 : 0;
                        return <PointBoxS key={i} num={num} filledState={state} />;
                    })}
                </div>
                <div className="h-full"></div>
            </div>
            
            <div className="bg-white flex flex-col items-center justify-start gap-1 border-t border-black py-1 shrink-0" style={{ height: '1cm' }}>
                <span className="text-[8px] font-bold leading-none" style={{ height: '0.5cm' }}>"T"</span>
                <div className="flex flex-col w-full px-2 items-center ">
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center" style={{ height: '0.5cm' }}>{timeouts[0] || ":"}</div>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center" style={{ height: '0.5cm' }}>{timeouts[1] || ":"}</div>
                </div>
            </div>
        </div>
    );
};

const PointsColumn30: React.FC<{ isLast?: boolean, currentScore?: number, timeouts?: [string, string] }> = ({ isLast, currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className={`flex flex-col shrink-0 ${isLast ? '' : 'border-l-0 border-black'}`} style={{ width: '15mm', height: '3.5cm' }}>
            <div className="grid grid-cols-3 bg-white border-b border-black shrink-0" style={{ height: '2.5cm' }}>
                {[0, 10, 20].map((offset) => (
                    <div key={offset} className="flex flex-col border-l border-black border-t-0 h-full">
                        {Array.from({ length: 10 }).map((_, i) => {
                             const num = offset + i + 1;
                             const state = num <= currentScore ? 1 : 0;
                             return <PointBox key={i} num={num} filledState={state} />
                        })}
                    </div>
                ))}
            </div>
            <div className="bg-white flex flex-col items-center justify-start py-1 shrink-0 border-l border-black " style={{ height: '1cm' }}>
                <span className="text-[8px] font-bold leading-none  " style={{ height: '0.5cm' }}>"T"</span>
                <div className="flex flex-col w-full px-2 items-center   ">
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center" style={{ height: '0.5cm' }}>{timeouts[0] || ":"}</div>
                    <div className="w-full text-center text-[10px] font-bold bg-white leading-none flex items-center justify-center" style={{ height: '0.5cm' }}>{timeouts[1] || ":"}</div>
                </div>
            </div>
        </div>
    );
};

export const SetFive: React.FC<SetFiveProps> = ({
    teamNameA,
    teamNameB,
    startTime,
    endTime,
    lineupA,
    subsA,
    timeoutsA,
    pointsA_Left,
    lineupB,
    subsB,
    timeoutsB,
    pointsB,
    pointsA_Right,
    pointsAtChange,
    positionBoxRef
}) => {
  return (
    <div className="border border-black bg-white flex flex-col overflow-hidden shadow-sm shrink-0 relative" style={{ width: '229mm' }}>
       {/* Header Strip */}
       <div className="flex border-black bg-gray-100 text-xs shrink-0" style={{ height: '0.8cm', width: '229mm' }}>
           {/* Start Time */}
           <div className="border-r border-black flex items-center px-2 gap-2 bg-white shrink-0" style={{ width: '20.2mm' }}>
                <span className="font-bold text-[9px]">Start:</span>
                <div className="bg-transparent text-center font-mono text-xs">{startTime}</div>
           </div>
         
           {/* Panel 1 Header: Team Left */}
                   <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40.3mm' }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center"></div>
                        <SRSelector />
                    </div>
                    <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1"></div>
                </div>
           </div>
                   <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '14.8mm' }}>Points</div>

           {/* Panel 2 Header: Team Right */}
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '40mm' }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center"></div>
                        <SRSelector />
                    </div>
                    <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1"></div>
                </div>
           </div>
 {/* End Time */}
                   <div className="flex items-center border-r border-black px-2 gap-2 justify-start bg-white shrink-0" style={{ width: '20mm' }}>
                <span className="font-bold text-[9px]">End:</span>
                <div className="bg-transparent text-center font-mono text-xs">{endTime}</div>
           </div>
                   <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>
           {/* Panel 3 Header: Team left (Swapped) */}
           <div className="border-r border-black flex items-center justify-between px-2 bg-white shrink-0" style={{ width: '20mm', marginLeft: '3mm' }}>
                <div className="flex items-center gap-1 w-full">
                    <div className="flex items-center gap-1">
                        <div className="w-6 h-6 rounded-full border border-black text-center bg-gray-200 text-black font-bold text-sm shrink-0 flex items-center justify-center"></div>
                    </div>
                    <div className="w-full text-xs uppercase text-center font-bold bg-white ml-1"></div>
                </div>
           </div>
           
          
           
           {/* Points at Change */}
           <div className="border-r border-black flex items-center px-2 gap-2 bg-white shrink-0" style={{ width: '40mm' }}>
                <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-white font-bold text-sm">{pointsAtChange}</div>
                <span className="text-[8px] font-bold leading-none text-center">Points at change</span>
           </div>
           <div className="flex items-center justify-between px-2 bg-white shrink-0 text-center text-[8px]" style={{ width: '15mm' }}>Points</div>
       </div>

       {/* Court Change Box - spans full height of Set 5 (positioned at container level) */}
       <div className="absolute flex items-center justify-center border border-black border-b-0 border-t-0 bg-gray-100 z-10" style={{ width: '3mm', top: 0, bottom: 0, left: '150mm' }}>
            <div className="transform -rotate-90 text-[7px] font-bold uppercase tracking-wider whitespace-nowrap">
                Court Change
            </div>
       </div>

       {/* Main Body - 3 Panels */}
       <div className="flex justify-start shrink-0" style={{ width: '229mm', height: '4cm' }}>
            {/* Panel 1: Team A */}
            <div className="flex border border-black border-l-0 border-r-0 border-b-0 shrink-0" style={{ width: '75mm' }}>
                 <TeamServiceGrid lineup={lineupA} subs={subsA} positionBoxRef={positionBoxRef} maxRotationBoxes={6} />
                 <PointsColumn5 currentScore={pointsA_Left} timeouts={timeoutsA} />
            </div>

            {/* Panel 2: Team B */}
            <div className="flex border border-black border-r-0 border-b-0 shrink-0" style={{ width: '75mm' }}>
                 <TeamServiceGrid lineup={lineupB} subs={subsB} maxRotationBoxes={6} />
                 <PointsColumn30 currentScore={pointsB} timeouts={timeoutsB} />
            </div>

            {/* Panel 3: Team A (Swapped) */}
            <div className="flex border border-black border-l-0 border-r-0 border-b-0 shrink-0" style={{ width: '76mm', marginLeft: '3mm' }}>
                 <TeamServiceGrid lineup={lineupA} subs={subsA} maxRotationBoxes={6} />
                 <PointsColumn30 isLast={true} currentScore={pointsA_Right} timeouts={timeoutsA} />
            </div>
       </div>
    </div>
  );
};
