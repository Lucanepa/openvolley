
import React, { useState, useEffect } from 'react';
import { SubRecord } from '../types_scoresheet';
import { PointBox, SRSelector, TeamServiceGrid } from './StandardSet';

interface SetFiveProps {
    teamNameA?: string;
    teamNameB?: string;
    
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
}


const PointBoxS: React.FC<{ num: number; filledState?: 0 | 1 | 2 }> = ({ num, filledState = 0 }) => {
    const [type, setType] = useState<0 | 1 | 2>(filledState);
    const [circled, setCircled] = useState(false);

    useEffect(() => {
        setType(filledState);
    }, [filledState]);

    const handleLeftClick = () => {
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
            className="flex-1 w-full relative cursor-pointer select-none flex items-center justify-center"
            style={{ borderColor: '#000' }}
            onClick={handleLeftClick}
            onContextMenu={handleRightClick}
        >
            <span className={`text-[10px] font-bold leading-none text-gray-400 ${type !== 0 ? 'opacity-50' : ''}`}>{num}</span>
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

const PointsColumn5: React.FC<{ currentScore?: number, timeouts?: [string, string] }> = ({ currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className="flex flex-col h-full w-[72px] border-r-2 border-black">
            <div className="flex-1 grid grid-cols-3 bg-white">
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
            
            <div className="h-16 bg-white flex flex-col items-center justify-start gap-1 border-t border-black py-1">
                <span className="text-[10px] font-bold leading-none">"T"</span>
                <div className="flex flex-col gap-1 w-full px-2 items-center">
                    <input className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" defaultValue={timeouts[0]} />
                    <input className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" defaultValue={timeouts[1]} />
                </div>
            </div>
        </div>
    );
};

const PointsColumn30: React.FC<{ isLast?: boolean, currentScore?: number, timeouts?: [string, string] }> = ({ isLast, currentScore = 0, timeouts = ["", ""] }) => {
    return (
        <div className={`flex flex-col h-full w-[72px] ${isLast ? '' : 'border-r-2 border-black'}`}>
            <div className="flex-1 grid grid-cols-3 bg-white border-b border-black">
                {[0, 10, 20].map((offset) => (
                    <div key={offset} className="flex flex-col border-r border-black last:border-none h-full">
                        {Array.from({ length: 10 }).map((_, i) => {
                             const num = offset + i + 1;
                             const state = num <= currentScore ? 1 : 0;
                             return <PointBox key={i} num={num} filledState={state} />
                        })}
                    </div>
                ))}
            </div>
            <div className="h-16 bg-white flex flex-col items-center justify-start gap-1 border-t border-black py-1">
                <span className="text-[10px] font-bold leading-none">"T"</span>
                <div className="flex flex-col gap-1 w-full px-2 items-center">
                    <input className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" defaultValue={timeouts[0]} />
                    <input className="w-full h-4 border border-black text-center text-[10px] font-bold bg-white leading-none outline-none" defaultValue={timeouts[1]} />
                </div>
            </div>
        </div>
    );
};

export const SetFive: React.FC<SetFiveProps> = ({
    teamNameA,
    teamNameB,
    lineupA,
    subsA,
    timeoutsA,
    pointsA_Left,
    lineupB,
    subsB,
    timeoutsB,
    pointsB,
    pointsA_Right,
    pointsAtChange
}) => {
  return (
    <div className="border-2 border-black bg-white flex flex-col h-[250px] w-full overflow-hidden shadow-sm">
       {/* Header Strip */}
       <div className="h-8 flex border-b-2 border-black bg-gray-100 text-xs">
           {/* Panel 1 Header: Team A */}
           <div className="flex-1 flex border-r-2 border-black items-center px-2 gap-2 bg-white">
                <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                    A
                </div>
                <SRSelector />
                <input className="w-full border-b border-gray-300 uppercase font-bold outline-none bg-white" defaultValue={teamNameA} />
           </div>

           {/* Panel 2 Header: Team B */}
           <div className="flex-1 flex border-r-2 border-black items-center px-2 gap-2 bg-white">
                <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                    B
                </div>
                <SRSelector />
                <input className="w-full border-b border-gray-300 uppercase font-bold outline-none bg-white" defaultValue={teamNameB} />
           </div>

           {/* Panel 3 Header: Team A (Swapped) + Points at Change */}
           <div className="flex-1 flex items-center px-2 gap-2 bg-white relative">
                <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-gray-200 text-black font-bold text-sm shrink-0">
                    A
                </div>
                <input className="w-full border-b border-gray-300 uppercase font-bold outline-none bg-white" defaultValue={teamNameA} />
                
                {/* Points at Change */}
                <div className="flex items-center gap-1 border-l border-black pl-2 ml-1 shrink-0">
                    <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center bg-white">
                         <input 
                            className="w-full h-full text-center font-bold text-sm outline-none bg-transparent rounded-full" 
                            defaultValue={pointsAtChange}
                         />
                    </div>
                    <span className="text-[8px] font-bold leading-none text-center w-8">Pts at Change</span>
                </div>
           </div>
       </div>

       {/* Main Body - 3 Panels */}
       <div className="flex flex-1">
            {/* Panel 1: Team A */}
            <div className="flex-1 flex border-r-2 border-black min-w-0">
                 <TeamServiceGrid lineup={lineupA} subs={subsA} />
                 <PointsColumn5 currentScore={pointsA_Left} timeouts={timeoutsA} />
            </div>

            {/* Panel 2: Team B */}
            <div className="flex-1 flex border-r-2 border-black min-w-0">
                 <TeamServiceGrid lineup={lineupB} subs={subsB} />
                 <PointsColumn30 currentScore={pointsB} timeouts={timeoutsB} />
            </div>

            {/* Panel 3: Team A (Swapped) */}
            <div className="flex-1 flex min-w-0">
                 {/* Usually Panel 3 service grid is a continuation or copy of Panel 1 */}
                 <TeamServiceGrid lineup={lineupA} subs={subsA} />
                 <PointsColumn30 isLast={true} currentScore={pointsA_Right} timeouts={timeoutsA} />
            </div>
       </div>
    </div>
  );
};
