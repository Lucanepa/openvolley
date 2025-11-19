import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';

interface StandardSetProps {
  setNumber: number;
  isSwapped?: boolean;
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

// Interactive Point Box: Controlled via props but maintains interactivity
export const PointBox: React.FC<{ num: number; filledState?: 0 | 1 | 2 }> = ({ num, filledState = 0 }) => {
    // type: 0 = none, 1 = slash, 2 = vertical bar
    // If filledState is passed from parent (DB), use it. Otherwise allow local toggle.
    const [type, setType] = useState<0 | 1 | 2>(filledState);
    const [circled, setCircled] = useState(false);

    useEffect(() => {
        setType(filledState);
    }, [filledState]);

    const handleLeftClick = () => {
        // Cycle: None -> Slash -> Bar -> None
        setType(prev => {
            if (prev === 0) return 1;
            if (prev === 1) return 2;
            return 0;
        });
    };

    const handleRightClick = (e: React.MouseEvent) => {
        e.preventDefault();
        setCircled(prev => !prev);
    };

    return (
        <div 
            className="flex-1 w-full border-b border-r border-gray-300 relative cursor-pointer select-none flex items-center justify-center"
            style={{ borderColor: '#000' }}
            onClick={handleLeftClick}
            onContextMenu={handleRightClick}
        >
            {/* Background Number */}
            <span className={`text-[10px] font-bold leading-none text-gray-400 ${type !== 0 ? 'opacity-50' : ''}`}>{num}</span>
            
            {/* Overlays */}
            {type === 1 && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="0" y1="100" x2="100" y2="0" stroke="black" strokeWidth="4" />
                 </svg>
            )}
            {type === 2 && (
                 <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="50" y1="0" x2="50" y2="100" stroke="black" strokeWidth="4" />
                 </svg>
            )}
            {circled && (
                <div className="absolute inset-0.5 rounded-full border-2 border-black pointer-events-none"></div>
            )}
        </div>
    );
};

// Service/Reception Selector (S above R)
export const SRSelector: React.FC = () => {
    const [selection, setSelection] = useState<'S' | 'R' | null>(null);
    return (
        <div className="flex flex-col gap-0.5 mx-1 justify-center">
            {['S', 'R'].map((item) => (
                <div 
                    key={item}
                    onClick={() => setSelection(prev => prev === item ? null : item as 'S' | 'R')}
                    className="relative w-3 h-3 rounded-full border border-black flex items-center justify-center text-[7px] font-bold cursor-pointer bg-white hover:bg-gray-100 select-none leading-none"
                >
                    {item}
                    {selection === item && (
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
export const PointsColumn: React.FC<{ isLast?: boolean, currentScore?: number, timeouts?: [string, string] }> = ({ isLast, currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className={`flex flex-col h-full w-24 ${isLast ? '' : 'border-r-2 border-black'}`}>
            <div className="flex-1 grid grid-cols-4 bg-white border-b border-black">
                {[0, 12, 24, 36].map((offset) => (
                    <div key={offset} className="flex flex-col border-r border-black last:border-none h-full">
                        {Array.from({ length: 12 }).map((_, i) => {
                            const num = offset + i + 1;
                            // Determine state: 1 (slash) if num <= currentScore
                            const state = num <= currentScore ? 1 : 0;
                            return <PointBox key={i} num={num} filledState={state} />;
                        })}
                    </div>
                ))}
            </div>
            {/* TO Boxes - Standardized Size */}
            <div className="h-16 bg-white flex flex-col items-center justify-start gap-1 border-t border-black py-1">
                <span className="text-[10px] font-bold leading-none">"T"</span>
                <div className="flex flex-col gap-1 w-full px-2 items-center">
                    <input 
                        className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" 
                        defaultValue={timeouts[0]}
                    />
                    <input 
                        className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" 
                        defaultValue={timeouts[1]}
                    />
   
                </div>
            </div>
        </div>
    );
};

export const TeamServiceGrid: React.FC<{ lineup?: string[], subs?: SubRecord[][] }> = ({ lineup = [], subs = [] }) => {
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
                    <div key={i} className="border-r border-black last:border-none p-0.5">
                        <input 
                            className="input-dense font-bold text-sm" 
                            defaultValue={lineup[i] || ''}
                        />
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
                            <div className="border-b border-black h-8 shrink-0 p-0.5">
                                <input 
                                    className="input-dense border-b border-gray-200 text-[10px]" 
                                    placeholder="Nr" 
                                    defaultValue={sub1 ? sub1.playerIn : ''}
                                />
                            </div>
                            {/* Sub 1 Score */}
                            <div className="h-6 border-b border-gray-400 flex">
                                <input 
                                    className="input-dense text-[9px]" 
                                    placeholder="Score" 
                                    defaultValue={sub1 ? sub1.score : ''}
                                />
                            </div>
                            
                            {/* Sub 2 Score (Or Sub 2 Player if needed in a simpler sheet, usually represents score out) */}
                            <div className="h-6 border-b border-gray-400 flex bg-white">
                                <input 
                                    className="input-dense text-[9px]" 
                                    placeholder="Score" 
                                    defaultValue={sub2 ? sub2.score : ''}
                                />
                            </div>
                            
                            {/* 8-Box Score Grid (used for 3rd sub or deeper stats) */}
                            {/* We map the extra subs to these boxes: Box 1=Player, Box 2=Score, Box 3=Player, etc. */}
                            <div className="flex-1 grid grid-cols-2 grid-rows-4 grid-flow-col border-b border-gray-200">
                                {[1, 2, 3, 4, 5, 6, 7, 8].map((num) => {
                                    // Calculate index in extraSubs array. 
                                    // Box 1 & 2 -> extraSubs[0] (Player, Score)
                                    // Box 3 & 4 -> extraSubs[1] (Player, Score)
                                    const extraSubIndex = Math.floor((num - 1) / 2);
                                    const isScoreField = (num - 1) % 2 !== 0; // Odd nums (1,3,..) are Players, Even nums (2,4,..) are Scores
                                    const sub = extraSubs[extraSubIndex];
                                    
                                    let val = '';
                                    if (sub) {
                                        val = isScoreField ? sub.score : sub.playerIn;
                                    }

                                    return (
                                    <div key={num} className="relative border-b border-r border-gray-200 last:border-b-0 last:border-r-0 flex items-center justify-center">
                                        <span className="absolute top-[0.5px] right-[1px] text-[6px] leading-none text-gray-500 font-medium pointer-events-none">
                                            {num}
                                        </span>
                                        <input 
                                            className="input-dense text-[8px] p-0" 
                                            defaultValue={val}
                                        />
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

  return (
    <div className="border-2 border-black bg-white flex flex-col h-[250px] w-full overflow-hidden shadow-sm">
        {/* Header Strip */}
        <div className="h-8 flex border-b-2 border-black bg-gray-100">
             {/* Start Time */}
             <div className="w-24 border-r border-black flex items-center px-2 gap-2 bg-white">
                <span className="font-bold text-[9px]">Start:</span>
                <input 
                    className="w-12 border-b border-black bg-transparent text-center font-mono text-xs outline-none" 
                    defaultValue={startTime}
                />
             </div>
             {/* Team Left (A or B) */}
             <div className="flex-1 border-r-2 border-black flex items-center justify-between px-2 bg-white">
                 <div className="flex items-center gap-1 w-full">
                     <div className="flex items-center gap-1">
                         <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                            {leftTeamLabel}
                         </div>
                         <SRSelector />
                     </div>
                     <input 
                        className="w-full border-b border-gray-300 text-xs uppercase font-bold outline-none bg-white ml-1" 
                        defaultValue={teamNameLeft}
                     />
                 </div>
             </div>
              {/* Team Right (B or A) */}
             <div className="flex-1 border-r border-black flex items-center justify-between px-2 bg-white">
                 <div className="flex items-center gap-1 w-full justify-end">
                     <input 
                        className="w-full border-b border-gray-300 text-xs uppercase font-bold outline-none text-right bg-white mr-1" 
                        defaultValue={teamNameRight}
                     />
                     <div className="flex items-center gap-1">
                        <SRSelector />
                        <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                            {rightTeamLabel}
                        </div>
                     </div>
                 </div>
             </div>
              {/* End Time */}
             <div className="w-24 flex items-center px-2 gap-2 justify-end bg-white">
                <span className="font-bold text-[9px]">End:</span>
                <input 
                    className="w-12 border-b border-black bg-transparent text-center font-mono text-xs outline-none" 
                    defaultValue={endTime}
                />
             </div>
        </div>

        {/* Main Body - Teams side by side with points on their right */}
        <div className="flex flex-1">
            {/* Team Left Block */}
            <div className="flex-1 flex">
                <TeamServiceGrid lineup={leftLineup} subs={leftSubs} />
                <PointsColumn currentScore={leftPoints} timeouts={leftTimeouts} />
            </div>

            {/* Team Right Block */}
             <div className="flex-1 flex">
                <TeamServiceGrid lineup={rightLineup} subs={rightSubs} />
                <div className="h-full"> 
                    <PointsColumn isLast={true} currentScore={rightPoints} timeouts={rightTimeouts} />
                </div>
            </div>
        </div>
    </div>
  );
};