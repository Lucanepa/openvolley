import React, { useState } from 'react';
import { SanctionRecord, Player } from '../types_scoresheet';

interface SanctionsProps {
    items?: SanctionRecord[];
}

export const Sanctions: React.FC<SanctionsProps> = ({ items = [] }) => {
    // We use a fixed count but allow flex-1 to stretch rows to fill the column height
    const rowCount = 8; 
    const [improperA, setImproperA] = useState(false);
    const [improperB, setImproperB] = useState(false);

    return (
        <div className="border-2 border-black bg-white flex flex-col h-full relative group overflow-hidden">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 relative shrink-0">
                SANCTIONS
            </div>

            {/* Improper Request Row */}
            <div className="flex items-center justify-between px-2 py-0.5 border-b border-black bg-white shrink-0 min-h-[24px]">
                <span className="text-[9px] font-bold uppercase">Improper Request</span>
                <div className="flex items-center gap-3">
                    {/* Team A */}
                    <div 
                        className="w-5 h-5 rounded-full border border-black flex items-center justify-center relative cursor-pointer select-none bg-white hover:bg-gray-50"
                        onClick={() => setImproperA(!improperA)}
                    >
                        <span className="text-[10px] font-bold leading-none mt-[1px]">A</span>
                        {improperA && (
                            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                <line x1="15" y1="15" x2="85" y2="85" stroke="black" strokeWidth="10" />
                                <line x1="85" y1="15" x2="15" y2="85" stroke="black" strokeWidth="10" />
                            </svg>
                        )}
                    </div>

                    {/* Team B */}
                    <div 
                        className="w-5 h-5 rounded-full border border-black flex items-center justify-center relative cursor-pointer select-none bg-white hover:bg-gray-50"
                        onClick={() => setImproperB(!improperB)}
                    >
                        <span className="text-[10px] font-bold leading-none mt-[1px]">B</span>
                        {improperB && (
                            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                <line x1="15" y1="15" x2="85" y2="85" stroke="black" strokeWidth="10" />
                                <line x1="85" y1="15" x2="15" y2="85" stroke="black" strokeWidth="10" />
                            </svg>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-7 text-[8px] font-bold text-center border-b border-black bg-white shrink-0">
                <div className="border-r border-black">W</div>
                <div className="border-r border-black">P</div>
                <div className="border-r border-black">E</div>
                <div className="border-r border-black">D</div>
                <div className="border-r border-black">A/B</div>
                <div className="border-r border-black">Set</div>
                <div>Score</div>
            </div>
            {/* flex-1 makes this container take remaining space */}
            <div className="flex-1 flex flex-col min-h-0">
                {Array.from({ length: rowCount }).map((_, i) => {
                    const item = items[i];
                    return (
                    <div key={i} className="grid grid-cols-7 flex-1 border-b border-gray-200 last:border-none text-xs min-h-[20px]">
                         <div className="border-r border-gray-200 flex items-center justify-center p-0.5">
                            <input 
                                className="input-dense font-bold text-center text-[10px]" 
                                defaultValue={item?.type === 'warning' ? 'X' : ''} 
                            />
                         </div>
                         <div className="border-r border-gray-200 flex items-center justify-center p-0.5">
                            <input 
                                className="input-dense font-bold text-center text-[10px]" 
                                defaultValue={item?.type === 'penalty' ? 'X' : ''} 
                            />
                         </div>
                         <div className="border-r border-gray-200 flex items-center justify-center p-0.5">
                            <input 
                                className="input-dense font-bold text-center text-[10px]" 
                                defaultValue={item?.type === 'expulsion' ? 'X' : ''} 
                            />
                         </div>
                         <div className="border-r border-gray-200 flex items-center justify-center p-0.5">
                            <input 
                                className="input-dense font-bold text-center text-[10px]" 
                                defaultValue={item?.type === 'disqualification' ? 'X' : ''} 
                            />
                         </div>
                         <input 
                            className="border-r border-gray-200 input-dense text-center uppercase font-bold" 
                            defaultValue={item?.team}
                         />
                         <input 
                            className="border-r border-gray-200 input-dense text-center" 
                            defaultValue={item?.set}
                         />
                         <input 
                            className="input-dense text-center text-[10px]" 
                            defaultValue={item?.score}
                         />
                    </div>
                )})}
            </div>
        </div>
    );
};

export const Remarks: React.FC = () => {
    return (
        <div className="border-2 border-black bg-white flex flex-col h-full">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">REMARKS</div>
            <div className="p-1 flex-1 flex flex-col">
                <textarea className="w-full flex-1 bg-transparent resize-none outline-none text-[9px] leading-tight h-full"></textarea>
            </div>
        </div>
    );
}

export const Results: React.FC = () => {
    return (
        <div className="border-2 border-black bg-white flex flex-col h-full">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">RESULT</div>
            <div className="grid grid-cols-[1fr_80px_1fr] gap-px bg-black border-b border-black flex-1 min-h-0">
                {/* Team A Stats */}
                <div className="bg-white flex flex-col">
                    <div className="flex items-center gap-1 px-1 border-b border-black h-5 bg-gray-50">
                         <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0">A</div>
                         <input className="text-[9px] font-bold uppercase outline-none w-full bg-transparent" placeholder="Team A" />
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b border-black">
                        <div className="border-r border-black">T</div><div className="border-r border-black">S</div><div className="border-r border-black">W</div><div className="border-r border-black">P</div>
                    </div>
                    <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => (
                             <div key={set} className="grid grid-cols-4 flex-1 border-b border-gray-200 text-xs min-h-[16px]">
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                             </div>
                        ))}
                        {/* Total Row */}
                        <div className="h-5 border-t border-black grid grid-cols-4 bg-gray-50">
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="input-dense text-center font-bold" />
                        </div>
                    </div>
                </div>

                {/* Center Duration & Set */}
                <div className="bg-white flex flex-col border-l border-r border-black">
                     <div className="h-5 border-b border-black bg-gray-200"></div>
                     <div className="bg-white text-[8px] font-bold text-center border-b border-black h-[13px] grid grid-cols-2">
                         <span className="border-r border-black">Set</span>
                         <span>Time</span>
                     </div>
                     <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => (
                            <div key={set} className="flex-1 border-b border-gray-200 grid grid-cols-2 font-bold text-xs bg-white min-h-[16px]">
                                <div className="flex items-center justify-center border-r border-gray-200">{set}</div>
                                <input className="input-dense" />
                            </div>
                        ))}
                        <div className="h-5 border-t border-black grid grid-cols-2 bg-white">
                            <div className="flex items-center justify-center font-bold text-[9px] border-r border-black">Total</div>
                            <input className="input-dense text-center font-bold" />
                        </div>
                     </div>
                </div>

                {/* Team B Stats */}
                 <div className="bg-white flex flex-col">
                    <div className="flex items-center gap-1 px-1 border-b border-black h-5 bg-gray-50 flex-row-reverse">
                         <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0">B</div>
                         <input className="text-[9px] font-bold uppercase outline-none w-full text-right bg-transparent" placeholder="Team B" />
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b border-black">
                        <div className="border-r border-black">P</div><div className="border-r border-black">W</div><div className="border-r border-black">S</div><div className="border-r border-black">T</div>
                    </div>
                    <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => (
                             <div key={set} className="grid grid-cols-4 flex-1 border-b border-gray-200 text-xs min-h-[16px]">
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                                <input className="border-r border-gray-200 input-dense" />
                             </div>
                        ))}
                        <div className="h-5 border-t border-black grid grid-cols-4 bg-gray-50">
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="border-r border-gray-300 input-dense text-center font-bold" />
                            <input className="input-dense text-center font-bold" />
                        </div>
                    </div>
                </div>
            </div>
            
            {/* Winner Area */}
            <div className="p-1 grid grid-cols-[1.5fr_1fr] gap-1 border-t-2 border-black h-14 shrink-0 bg-white">
                 <div className="border-b border-gray-300 relative">
                     <span className="text-[8px] absolute top-0 left-0 text-gray-500">WINNER</span>
                     <input className="w-full h-full text-center font-black uppercase text-lg bg-white outline-none" />
                 </div>
                 <div className="border-b border-gray-300 relative">
                     <span className="text-[8px] absolute top-0 left-0 text-gray-500">RESULT</span>
                     <input className="w-full h-full text-center font-black text-lg bg-white outline-none" />
                 </div>
            </div>
        </div>
    );
};

export const Approvals: React.FC = () => {
    const roles = ["1st Referee", "2nd Referee", "Scorer", "Assistant"];

    return (
        <div className="border-2 border-black bg-white flex flex-col h-full w-full">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">APPROVAL</div>
            
            {/* Column Headers */}
            <div className="flex items-center border-b border-black px-2 gap-2 text-[8px] font-bold text-center bg-white h-4 shrink-0">
                 <div className="w-20 text-left">Official</div>
                 <div className="w-28 text-left pl-1">Name</div>
                 <div className="w-16 text-left pl-1">Country</div>
                 <div className="w-16 text-left pl-1">DOB</div>
                 <div className="flex-1 text-center">Signature</div>
            </div>

            {/* Officials List */}
            <div className="flex flex-col border-b border-black flex-1 min-h-0">
                {roles.map((role, idx) => (
                    <div key={idx} className="flex items-center border-b border-gray-200 last:border-none px-2 gap-2 flex-1 min-h-[30px]">
                        <div className="w-20 font-bold text-[9px] shrink-0">{role}</div>
                        
                        <div className="flex flex-col justify-end w-28 shrink-0 h-full pb-1">
                            <input className="border-b border-gray-300 w-full text-[9px] outline-none bg-white" />
                        </div>
                        
                        <div className="flex flex-col justify-end w-16 shrink-0 h-full pb-1">
                            <input className="border-b border-gray-300 w-full text-[9px] outline-none bg-white" />
                        </div>

                         <div className="flex flex-col justify-end w-16 shrink-0 h-full pb-1">
                            <input className="border-b border-gray-300 w-full text-[9px] outline-none bg-white" />
                        </div>

                        <div className="flex-1 h-full relative border-b border-gray-300 mb-1 ml-1">
                            {/* Signature space */}
                        </div>
                    </div>
                ))}
            </div>

            {/* Captains - Central Layout */}
            <div className="flex justify-center items-end gap-4 px-4 py-2 h-14 shrink-0">
                 <div className="flex-1 border-b border-black relative">
                    <span className="absolute bottom-0 left-0 text-[7px] text-gray-400 uppercase">Captain Signature</span>
                 </div>
                 
                 <div className="flex items-center gap-3 pb-1">
                     <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center font-bold text-sm bg-white">A</div>
                     <div className="w-6 h-6 rounded-full border border-black flex items-center justify-center font-bold text-sm bg-white">B</div>
                 </div>
                 
                 <div className="flex-1 border-b border-black relative">
                    <span className="absolute bottom-0 right-0 text-[7px] text-gray-400 uppercase">Captain Signature</span>
                 </div>
            </div>
        </div>
    );
};

interface RosterProps {
  team: string;
  side: string;
  players?: Player[];
  benchStaff?: any[];
}

export const Roster: React.FC<RosterProps> = ({ team, side, players = [], benchStaff = [] }) => {
    // Expanded DOB column (50px), Number (25px), Name (Remaining)
    const gridClass = "grid grid-cols-[50px_25px_1fr]";
    // Unified height for Libero and Bench Official cells
    const rowHeight = "h-5";

    // Separate players and liberos
    const regularPlayers = players.filter(p => !p.libero).slice(0, 14);
    const liberos = players.filter(p => p.libero).slice(0, 2);
    
    return (
        <div className="border-2 border-black bg-white h-full flex flex-col min-w-0">
            <div className="bg-white text-black border-b border-black font-bold py-0.5 text-xs flex justify-between px-1 items-center h-7 shrink-0">
                <input 
                    className="font-bold text-xs outline-none placeholder-gray-400 uppercase w-full bg-white" 
                    placeholder={team} 
                    defaultValue={team}
                />
                <div className="w-5 h-5 rounded-full border border-black flex items-center justify-center shrink-0 ml-1">
                     <input 
                        className="w-full h-full text-center font-bold outline-none bg-transparent text-[10px] rounded-full uppercase" 
                        placeholder={side}
                        defaultValue={side}
                     />
                </div>
            </div>
            {/* Header */}
            <div className={`bg-white border-b border-black ${gridClass} text-[8px] font-bold h-4 items-center shrink-0`}>
                <div className="border-r border-black text-center h-full flex items-center justify-center">DoB</div>
                <div className="border-r border-black text-center h-full flex items-center justify-center">No</div>
                <div className="pl-1 h-full flex items-center">Name</div>
            </div>
            
            {/* Players List - 14 players */}
            <div className="flex-1 flex flex-col min-h-0">
                {Array.from({ length: 14 }).map((_, i) => {
                    const player = regularPlayers[i];
                    const isCaptain = player?.isCaptain;
                    return (
                    <div key={i} className={`${gridClass} border-b border-gray-200 last:border-none flex-1 text-[8px] min-h-[16px]`}>
                        <input 
                            className="border-r border-black input-dense text-center" 
                            defaultValue={player?.dob || ''}
                        />
                        <div className="border-r border-black flex items-center justify-center relative">
                            <input 
                                className="input-dense font-bold bg-white text-center w-full" 
                                defaultValue={player?.number || ''}
                            />
                            {isCaptain && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                    <circle cx="50" cy="50" r="40" fill="none" stroke="black" strokeWidth="6" />
                                </svg>
                            )}
                        </div>
                        <input 
                            className="input-dense text-left px-1 font-medium uppercase text-[7px]" 
                            defaultValue={player?.name || ''}
                        />
                    </div>
                )})}
            </div>
            
            {/* Liberos - 2 players */}
            <div className="border-t-2 border-black shrink-0">
                <div className="bg-gray-200 text-[8px] font-bold border-b border-black h-4 flex items-center justify-center">LIBERO</div>
                {Array.from({ length: 2 }).map((_, i) => {
                    const libero = liberos[i];
                    // Capitalize only (not UPPERCASE) for liberos
                    const liberoName = libero?.name ? libero.name.charAt(0).toUpperCase() + libero.name.slice(1).toLowerCase() : '';
                    return (
                        <div key={i} className={`${gridClass} ${i === 0 ? 'border-b border-gray-200' : ''} ${rowHeight} text-[8px]`}>
                            <input className="border-r border-black input-dense text-center" defaultValue={libero?.dob || ''} />
                            <input className="border-r border-black input-dense font-bold bg-white text-center" defaultValue={libero?.number || ''} />
                            <input className="input-dense text-left px-1 font-medium uppercase text-[7px]" defaultValue={liberoName} />
                        </div>
                    );
                })}
            </div>

            {/* Officials */}
             <div className="border-t-2 border-black bg-white shrink-0">
                 <div className="bg-gray-200 text-[8px] font-bold h-4 border-b border-black text-center flex items-center justify-center">BENCH OFFICIALS</div>
                 {['C', 'AC1', 'AC2', 'P', 'M'].map((roleLabel, idx) => {
                     const roleMap: { [key: string]: string } = {
                         'C': 'Coach',
                         'AC1': 'Assistant Coach 1',
                         'AC2': 'Assistant Coach 2',
                         'P': 'Physiotherapist',
                         'M': 'Medic'
                     };
                     const official = benchStaff.find(s => s.role === roleMap[roleLabel]);
                     const fullName = official ? `${official.lastName || ''} ${official.firstName || ''}`.trim() : '';
                     
                     return (
                         <div key={roleLabel} className={`${gridClass} text-[8px] items-center ${rowHeight} border-b border-gray-100 last:border-none`}>
                             <input className="border-r border-black input-dense text-center border-b border-gray-200" defaultValue={official?.dob || ''} />
                             <div className="font-bold text-center border-r border-black border-l border-black h-full flex items-center justify-center bg-white text-[7px]">{roleLabel}</div>
                             <input className="input-dense uppercase bg-white px-1 text-left" defaultValue={fullName} />
                         </div>
                     );
                 })}
             </div>

             {/* Signatures */}
             <div className="h-100 border-t-2 border-black bg-white shrink-0 p-1">
                 <div className="flex items-end gap-2 mb-1">
                    <span className="text-[8px] font-bold uppercase w-12">Captain</span>
                    <input className="flex-1 border-b border-black text-[9px] bg-white outline-none leading-none" />
                 </div>
                 <div className="flex items-end gap-2">
                    <span className="text-[8px] font-bold uppercase w-12">Coach</span>
                    <input className="flex-1 border-b border-black text-[9px] bg-white outline-none leading-none" />
                 </div>
             </div>
        </div>
    );
};

export const FooterSection: React.FC = () => <div />;