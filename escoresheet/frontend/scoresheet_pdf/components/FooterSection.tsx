import React, { useState, useEffect } from 'react';
import { SanctionRecord, Player } from '../types_scoresheet';
import { SignatureModal } from './SignatureModal';

// 75% black border color
const borderColor75 = { borderColor: 'rgba(0, 0, 0, 0.75)' };

interface SanctionsProps {
    items?: SanctionRecord[];
    improperRequests?: { teamA: boolean; teamB: boolean };
}

export const Sanctions: React.FC<SanctionsProps> = ({ items = [], improperRequests = { teamA: false, teamB: false } }) => {
    const rowCount = 10; 

    return (
        <div className="border bg-white flex flex-col h-full relative group overflow-hidden" style={borderColor75}>
            <div className="bg-gray-200 border-b text-center font-bold text-[10px] py-0.5 relative shrink-0" style={borderColor75}>
                SANCTIONS
            </div>

            {/* Improper Request Row - Static */}
            <div className="flex items-center justify-between px-2 py-0.5 border-b bg-white shrink-0" style={borderColor75}>
                <span className="text-[9px] font-bold uppercase">Improper Request</span>
                <div className="flex items-center gap-3">
                    {/* Team A */}
                    <div className="w-5 h-5 rounded-full border flex items-center justify-center relative select-none bg-white" style={borderColor75}>
                        <span className="text-[20px] font-bold leading-none relative z-0">A</span>
                        {improperRequests.teamA && (
                            <span className="absolute inset-0 flex items-center justify-center text-[30px] text-gray-500 leading-none z-10">X</span>
                        )}
                    </div>

                    {/* Team B */}
                    <div className="w-5 h-5 rounded-full border flex items-center justify-center relative select-none bg-white" style={borderColor75}>
                        <span className="text-[20px] font-bold leading-none relative z-0">B</span>
                        {improperRequests.teamB && (
                            <span className="absolute inset-0 flex items-center justify-center text-[30px] text-gray-500 leading-none z-10">X</span>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-7 text-[9px] font-bold text-center border-b bg-white shrink-0" style={{ height: '0.7cm', ...borderColor75 }}>
                <div className="border-r flex items-center justify-center" style={borderColor75}>W</div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>P</div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>E</div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>D</div>
                <div className="border-r flex items-center justify-center h-full" style={borderColor75}>
                    <div className="flex flex-col items-center justify-center min-h-0 py-0.5 gap-0.5">
                        <div className="w-2.5 h-2.5 rounded-full border flex items-center justify-center text-[7px] font-bold bg-white" style={borderColor75}>A</div>
                        <div className="w-2.5 h-2.5 rounded-full border flex items-center justify-center text-[7px] font-bold bg-white" style={borderColor75}>B</div>
                    </div>
                    <div className="flex flex-col items-center justify-center h-full ml-1">
                        <span className="text-[8px] font-normal text-gray-700" style={{ lineHeight: '100%' }}>or</span>
                    </div>
                </div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>Set</div>
                <div className=" flex items-center justify-center">Score</div>
            </div>
            {/* flex-1 makes this container take remaining space and rows distribute evenly */}
            <div className="flex-1 flex flex-col min-h-0">
                {Array.from({ length: rowCount }).map((_, i) => {
                    const item = items[i];
                    return (
                    <div key={i} className="grid grid-cols-7 flex-1 last:border-none text-xs min-h-0">
                         <div className="flex items-center justify-center p-0.5" style={{ aspectRatio: '1' }}>
                            <div className="text-center text-[10px]">
                                {item?.type === 'warning' ? (item.playerNr || '') : ''}
                            </div>
                         </div>
                         <div className=" flex items-center justify-center p-0.5" style={{ aspectRatio: '1' }}>
                            <div className="text-center text-[10px]">
                                {item?.type === 'penalty' ? (item.playerNr || '') : ''}
                            </div>
                         </div>
                         <div className=" flex items-center justify-center p-0.5" style={{ aspectRatio: '1' }}>
                            <div className=" text-center text-[10px]">
                                {item?.type === 'expulsion' ? (item.playerNr || '') : ''}
                            </div>
                         </div>
                         <div className=" flex items-center justify-center p-0.5" style={{ aspectRatio: '1' }}>
                            <div className="text-center text-[10px]">
                                {item?.type === 'disqualification' ? (item.playerNr || '') : ''}
                            </div>
                         </div>
                         <div className="text-center uppercase flex items-center justify-center text-[10px] px-0.5" style={{ aspectRatio: '1' }}>
                            {item?.team || ''}
                         </div>
                         <div className="text-center flex items-center justify-center text-[10px]" style={{ aspectRatio: '1' }}>{item?.set || ''}</div>
                         <div className="text-center flex items-center justify-center text-[9px]" style={{ aspectRatio: '1' }}>{item?.score || ''}</div>
                    </div>
                )})}
            </div>
        </div>
    );
};

interface RemarksProps {
    overflowSanctions?: SanctionRecord[];
    remarks?: string;
}

export const Remarks: React.FC<RemarksProps> = ({ overflowSanctions = [], remarks = '' }) => {
    const formatSanction = (sanction: SanctionRecord): string => {
        // Check if it's a delay sanction (playerNr === 'D')
        const isDelay = sanction.playerNr === 'D';
        
        // Capitalize sanction type
        const typeLabel = sanction.type === 'warning' 
            ? (isDelay ? 'Delay Warning' : 'Warning')
            : sanction.type === 'penalty' 
            ? (isDelay ? 'Delay Penalty' : 'Penalty')
            : sanction.type === 'expulsion' 
            ? 'Expulsion'
            : sanction.type === 'disqualification' 
            ? 'Disqualification'
            : '';
        
        // Format: Team A/B, Set X, Score X:X, sanction and player n/function if necessarily
        const teamLabel = `Team ${sanction.team}`;
        const setLabel = `Set ${sanction.set}`;
        const scoreLabel = `Score ${sanction.score}`;
        
        // Include player number/function if it exists and is not a delay sanction
        // For delay sanctions, we already wrote "Delay" in the type, so no player info needed
        // For non-delay sanctions, include the player number or function
        const playerInfo = !isDelay && sanction.playerNr 
            ? `, ${sanction.playerNr}` 
            : '';
        
        return `${teamLabel}, ${setLabel}, ${scoreLabel}, ${typeLabel}${playerInfo}`;
    };

    const hasContent = remarks.trim() || overflowSanctions.length > 0;

    return (
        <div className="border bg-white flex flex-col h-full" style={borderColor75}>
            <div className="bg-gray-200 border-b text-center font-bold text-[10px] py-0.5 shrink-0" style={borderColor75}>REMARKS</div>
            <div className="p-1 flex-1 flex flex-col overflow-y-auto">
                {hasContent ? (
                    <div className="w-full flex-1 bg-transparent text-[9px] leading-tight h-full">
                        {remarks.trim() && (
                            <div className="text-[9px] leading-tight whitespace-pre-wrap mb-1">
                                {remarks.trim()}
                            </div>
                        )}
                        {overflowSanctions.length > 0 && (
                            <>
                                {remarks.trim() && <div className="mb-1"></div>}
                        <div className="font-bold mb-1 text-[9px]">Sanctions (overflow):</div>
                        {overflowSanctions.map((sanction, index) => (
                            <div key={index} className="text-[9px] leading-tight">
                                {formatSanction(sanction)}
                            </div>
                        ))}
                            </>
                        )}
                    </div>
                ) : (
                    <div className="w-full flex-1 bg-transparent text-[9px] leading-tight h-full"></div>
                )}
            </div>
        </div>
    );
}

interface SetResult {
  setNumber: number;
  teamATimeouts: number;
  teamASubstitutions: number;
  teamAWon: number;
  teamAPoints: number;
  teamBTimeouts: number;
  teamBSubstitutions: number;
  teamBWon: number;
  teamBPoints: number;
  duration: string;
  endTime?: string; // Add endTime to track when set ended
}

interface ResultsProps {
  teamAShortName?: string;
  teamBShortName?: string;
  setResults?: SetResult[];
  matchStart?: string;
  matchEnd?: string;
  matchDuration?: string;
  winner?: string;
  result?: string;
  coinTossConfirmed?: boolean;
}

// Component to display set duration (removed countdown functionality - duration should only show the set length)
const SetIntervalCountdown: React.FC<{ endTime?: string; duration?: string }> = ({ duration }) => {
  // Simply show the duration - no countdown needed for Results table
  // The duration is the length of the set, calculated from start to end time
  return <span>{duration || ''}</span>;
};

export const Results: React.FC<ResultsProps> = ({
  teamAShortName = '',
  teamBShortName = '',
  setResults = [],
  matchStart = '',
  matchEnd = '',
  matchDuration = '',
  winner = '',
  result = '',
  coinTossConfirmed = false
}) => {
    return (
        <div className="border bg-white flex flex-col h-full" style={borderColor75}>
            <div className="bg-gray-200 border-b text-center font-bold text-[10px] py-0.5 shrink-0" style={borderColor75}>RESULT</div>
            <div className="grid grid-cols-[1fr_80px_1fr] gap-px bg-black border-b flex-1 min-h-0" style={borderColor75}>
                {/* Team A Stats */}
                <div className="bg-white flex flex-col">
                    <div className="flex items-center gap-1 px-1 border-b h-5 bg-gray-50" style={borderColor75}>
                         <div className="w-4 h-4 rounded-full border flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0" style={borderColor75}>A</div>
                         <div className="text-[9px] font-bold text-center uppercase w-full bg-transparent">{coinTossConfirmed ? teamAShortName : ''}</div>
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b" style={borderColor75}>
                        <div className="border-r" style={borderColor75}>T</div><div className="border-r" style={borderColor75}>S</div><div className="border-r" style={borderColor75}>W</div><div className="border-r">P</div>
                    </div>
                    <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => {
                            const setData = setResults.find(r => r.setNumber === set);
                            const isFinished = setData && setData.teamATimeouts !== null;
                            return (
                             <div key={set} className="grid grid-cols-4 flex-1 border-b border-gray-200 text-xs">
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamATimeouts ?? 0) : ''}
                                </div>
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamASubstitutions ?? 0) : ''}
                                </div>
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamAWon ?? 0) : ''}
                                </div>
                                <div className="flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamAPoints ?? 0) : ''}
                                </div>
                             </div>
                            );
                        })}
                        {/* Total Row */}
                        <div className="border-t grid grid-cols-4 bg-gray-50" style={{ height: '0.7cm', ...borderColor75 }}>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamATimeouts !== null ? (r.teamATimeouts || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamASubstitutions !== null ? (r.teamASubstitutions || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamAWon !== null ? (r.teamAWon || 0) : 0), 0) || 0}
                            </div>
                            <div className="text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamAPoints !== null ? (r.teamAPoints || 0) : 0), 0) || 0}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Center Duration & Set */}
                <div className="bg-white flex flex-col" style={borderColor75}>
                     <div className="h-5 border-b bg-gray-200" style={borderColor75}></div>
                     <div className="bg-white text-[8px] font-bold text-center border-b h-[13px] grid" style={{ gridTemplateColumns: '1fr 2fr', ...borderColor75 }}>
                         <span className="border-r flex-1" style={borderColor75}>Set</span>
                         <span className="flex-1">Time</span>
                     </div>
                     <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => {
                            const setData = setResults.find(r => r.setNumber === set);
                            // Only show set 4 and 5 numbers if they were actually played
                            const showSetNumber = set <= 3 || (setData && setData.teamATimeouts !== null);
                            return (
                            <div key={set} className="flex-1 border-b border-gray-200 grid font-bold text-xs bg-white" style={{ gridTemplateColumns: '1fr 2fr' }}>
                                <div className="flex items-center justify-center border-r text-[9px]" style={borderColor75}>{showSetNumber ? set : ''}</div>
                                <div className="flex items-center justify-center text-[9px]">
                                    <SetIntervalCountdown endTime={setData?.endTime} duration={setData?.duration} />
                                </div>
                            </div>
                            );
                        })}
                        <div className="border-t grid bg-white" style={{ gridTemplateColumns: '1fr 2fr', height: '0.7cm', ...borderColor75 }}>
                            <div className="flex items-center justify-center font-bold text-[9px] border-r" style={borderColor75}>Total</div>
                            <div className="text-center font-bold flex items-center justify-center text-[9px]">
                                {(() => {
                                    // Total is the sum of all set durations (in minutes)
                                    const totalMinutes = setResults.reduce((sum, r) => {
                                        if (!r.duration) return sum;
                                        // Parse duration string like "25'" to get minutes
                                        const match = r.duration.match(/(\d+)'/);
                                        return sum + (match ? parseInt(match[1], 10) : 0);
                                    }, 0);
                                    return totalMinutes > 0 ? `${totalMinutes}'` : '';
                                })()}
                            </div>
                        </div>
                     </div>
                </div>

                {/* Team B Stats */}
                 <div className="bg-white flex flex-col">
                    <div className="flex items-center gap-1 px-1 border-b h-5 bg-gray-50 flex-row-reverse" style={borderColor75}>
                         <div className="w-4 h-4 rounded-full border flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0" style={borderColor75}>B</div>
                         <div className="text-[9px] font-bold text-center uppercase w-full bg-transparent">{coinTossConfirmed ? teamBShortName : ''}</div>
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b" style={borderColor75}>
                        <div className="border-r" style={borderColor75}>P</div><div className="border-r" style={borderColor75}>W</div><div className="border-r" style={borderColor75}>S</div><div>T</div>
                    </div>
                    <div className="flex-1 flex flex-col">
                        {[1,2,3,4,5].map(set => {
                            const setData = setResults.find(r => r.setNumber === set);
                            const isFinished = setData && setData.teamBTimeouts !== null;
                            return (
                             <div key={set} className="grid grid-cols-4 flex-1 border-b border-gray-200 text-xs min-h-[16px]">
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBPoints ?? 0) : ''}
                                </div>
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBWon ?? 0) : ''}
                                </div>
                                <div className="border-r border-gray-200 flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBSubstitutions ?? 0) : ''}
                                </div>
                                <div className="flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBTimeouts ?? 0) : ''}
                                </div>
                             </div>
                            );
                        })}
                        <div className="border-t grid grid-cols-4 bg-gray-50" style={{ height: '0.7cm', ...borderColor75 }}>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBPoints !== null ? (r.teamBPoints || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBWon !== null ? (r.teamBWon || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r border-gray-300 text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBSubstitutions !== null ? (r.teamBSubstitutions || 0) : 0), 0) || 0}
                            </div>
                            <div className="text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBTimeouts !== null ? (r.teamBTimeouts || 0) : 0), 0) || 0}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            {/* Set Start/End/Duration Row - spans full width */}
            <div className="border-t grid grid-cols-6 bg-white shrink-0" style={{ height: '0.5cm', ...borderColor75 }}>
                <div className="border-r text-[6px] font-bold flex items-center justify-start pl-1" style={borderColor75}>Match Start</div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>
                    <div className="w-full text-center text-[6px] font-bold bg-white">{matchStart}</div>
                </div>
                <div className="border-r text-[6px] font-bold flex items-center justify-start pl-1" style={borderColor75}>Match End</div>
                <div className="border-r flex items-center justify-center" style={borderColor75}>
                    <div className="w-full text-center text-[6px] font-bold bg-white">{matchEnd}</div>
                </div>
                <div className="border-r text-[6px] font-bold flex items-center justify-start pl-1" style={borderColor75}>Match Duration</div>
                <div className="flex items-center justify-center">
                    <div className="w-full text-center text-[6px] font-bold bg-white">{matchDuration}</div>
                </div>
            </div>
            
            {/* Winner Area */}
            <div className="p-1 grid grid-cols-[3fr_1fr] gap-1 border-t h-14 shrink-0 bg-white" style={borderColor75}>
                 <div className="relative">
                     <span className="text-[12px] absolute top-0 left-0 text-gray-500">WINNER</span>
                     <div className="w-full h-full text-center font-black uppercase text-lg bg-white flex items-end justify-center pb-0.5">{winner}</div>
                 </div>
                 <div className="relative border-l border-gray-300" >
                     <span className="text-[12px] absolute top-0 left-0 right-0 text-center text-gray-500">RESULT</span>
                     <div className="w-full h-full font-black text-lg bg-white flex items-end justify-center pb-0.5">
                         {(() => {
                             // Calculate sets won by each team from setResults
                             const teamASetsWon = setResults.reduce((sum, r) => sum + (r.teamAWon || 0), 0);
                             const teamBSetsWon = setResults.reduce((sum, r) => sum + (r.teamBWon || 0), 0);
                             // Winner has 3 sets, loser has the remaining
                             const winnerSets = Math.max(teamASetsWon, teamBSetsWon);
                             const loserSets = Math.min(teamASetsWon, teamBSetsWon);
                             return (
                                 <>
                                     <span className="w-1/2 text-right">{winnerSets}</span>
                                     <span className="px-0.5">:</span>
                                     <span className="w-1/2 text-left">{loserSets}</span>
                                 </>
                             );
                         })()}
                     </div>
                 </div>
            </div>
        </div>
    );
};

interface ApprovalsProps {
  officials?: any[];
  match?: any;
  teamAKey?: 'home' | 'away';
}

export const Approvals: React.FC<ApprovalsProps> = ({ officials = [], match, teamAKey = 'home' }) => {
    const roles = ["1st Referee", "2nd Referee", "Scorer", "Assistant Scorer"];
    
    // Load signatures from match data
    const getSignatureForRole = (role: string): string | null => {
        if (role === '1st Referee') return match?.ref1Signature || null;
        if (role === '2nd Referee') return match?.ref2Signature || null;
        if (role === 'Scorer') return match?.scorerSignature || null;
        if (role === 'Assistant Scorer') return match?.asstScorerSignature || null;
        return null;
    };

    const getCaptainSignature = (side: 'home' | 'away'): string | null => {
        if (side === 'home') return match?.homeCaptainSignature || null;
        return match?.awayCaptainSignature || null;
    };

    // Determine which team is A and which is B
    const homeIsA = teamAKey === 'home';
    const homeCaptainSignature = getCaptainSignature('home');
    const awayCaptainSignature = getCaptainSignature('away');
    const captainASignature = homeIsA ? homeCaptainSignature : awayCaptainSignature;
    const captainBSignature = homeIsA ? awayCaptainSignature : homeCaptainSignature;
    
    const getOfficial = (role: string) => {
        return officials.find(o => 
            o.role?.toLowerCase() === role.toLowerCase() || 
            (role === 'Assistant Scorer' && o.role?.toLowerCase() === 'assistant scorer')
        );
    };

    return (
        <div className="border bg-white flex flex-col h-full w-full" style={borderColor75}>
            <div className="bg-gray-200 border-b text-center font-bold text-[10px] py-0.5 shrink-0" style={borderColor75}>APPROVAL</div>
            
            {/* Column Headers */}
            <div className="flex items-center border-b px-2 gap-2 text-[8px] font-bold bg-white h-4 shrink-0" style={borderColor75}>
                 <div className="w-20 text-left text-[9px]">Official</div>
                 <div className="w-28 text-left text-[9px]">Name</div>
                 <div className="w-16 text-center text-[9px]">Country</div>
                 <div className="w-16 text-center text-[9px]">DOB</div>
                 <div className="flex-1 text-center text-[9px]">Signature</div>
            </div>

            {/* Officials List */}
            <div className="flex flex-col border-b flex-1 min-h-0" style={borderColor75}>
                {roles.map((role, idx) => {
                    const official = getOfficial(role);
                    const fullName = official ? `${official.lastName || ''} ${official.firstName || ''}`.trim() : '';
                    
                    return (
                    <div key={idx} className="flex items-center border-b border-gray-200 last:border-none px-2 gap-2 flex-1 min-h-0">
                        <div className="w-20 font-bold text-[9px] shrink-0 flex items-center">{role}</div>
                        
                        <div className="w-28 shrink-0 flex items-center">
                            <div className="w-full text-[9px] bg-white pb-0.5">{fullName}</div>
                        </div>
                        
                        <div className="w-16 shrink-0 flex items-center justify-center">
                            <div className="text-center w-full text-[9px] bg-white pb-0.5">{official?.country || ''}</div>
                        </div>

                         <div className="w-16 shrink-0 flex items-center justify-center">
                            <div className="text-center w-full text-[9px] bg-white pb-0.5">{official?.dob || ''}</div>
                        </div>

                        <div 
                            className="flex-1 h-full relative flex items-end pb-1 min-h-0"
                        >
                            {/* Signature space - read-only in PDF */}
                            {getSignatureForRole(role) ? (
                                <img 
                                    src={getSignatureForRole(role)!} 
                                    alt={`${role} signature`}
                                    className="w-full h-6 object-contain"
                                    style={{ maxHeight: '24px' }}
                                />
                            ) : (
                                <div className="w-full h-6 border-b border-gray-300"></div>
                            )}
                        </div>
                    </div>
                );
                })}
            </div>

            {/* Captains - Central Layout */}
            <div className="flex justify-center items-end gap-4 px-4 py-2 h-14 shrink-0">
                 <div className="flex-1 flex flex-col">
                    <span className="text-[7px] text-gray-400 uppercase mb-1">Captain Signature</span>
                    <div 
                        className="flex-1 border-b relative min-h-[24px]"
                    >
                        {captainASignature ? (
                            <img 
                                src={captainASignature} 
                                alt="Captain A signature"
                                className="w-full h-6 object-contain"
                                style={{ maxHeight: '24px' }}
                            />
                        ) : (
                            <div className="w-full h-6 border-b border-gray-300"></div>
                        )}
                    </div>
                 </div>
                 
                 <div className="flex items-center gap-3 pb-1">
                     <div className="w-6 h-6 rounded-full border flex items-center justify-center font-bold text-sm bg-white" style={borderColor75}>A</div>
                     <div className="w-6 h-6 rounded-full border flex items-center justify-center font-bold text-sm bg-white" style={borderColor75}>B</div>
                 </div>
                 
                 <div className="flex-1 flex flex-col">
                    <span className="text-[7px] text-gray-400 uppercase mb-1 text-right">Captain Signature</span>
                    <div 
                        className="flex-1 border-b relative min-h-[24px]"
                    >
                        {captainBSignature ? (
                            <img 
                                src={captainBSignature} 
                                alt="Captain B signature"
                                className="w-full h-6 object-contain"
                                style={{ maxHeight: '24px' }}
                            />
                        ) : (
                            <div className="w-full h-6 border-b border-gray-300"></div>
                        )}
                    </div>
                 </div>
            </div>

            {/* Signature Modal - removed, signatures are managed in MatchEnd */}
        </div>
    );
};

interface RosterProps {
  team: string;
  side: string;
  players?: Player[];
  benchStaff?: any[];
  preGameCaptainSignature?: string;
  preGameCoachSignature?: string;
  coinTossConfirmed?: boolean;
  isHome?: boolean;
}

export const Roster: React.FC<RosterProps> = ({ team, side, players = [], benchStaff = [], preGameCaptainSignature, preGameCoachSignature, coinTossConfirmed, isHome = true }) => {
    const [openSignature, setOpenSignature] = useState<string | null>(null);
    
    // Create unique signature keys based on side
    const captainSignatureKey = `roster-${side.toLowerCase()}-captain`;
    const coachSignatureKey = `roster-${side.toLowerCase()}-coach`;
    
    // Initialize signatures with pre-game signatures from coin toss
    const [signatures, setSignatures] = useState<Record<string, string>>(() => {
        const initial: Record<string, string> = {};
        if (preGameCaptainSignature) {
            initial[captainSignatureKey] = preGameCaptainSignature;
        }
        if (preGameCoachSignature) {
            initial[coachSignatureKey] = preGameCoachSignature;
        }
        return initial;
    });
    
    // Update signatures when pre-game signatures change
    useEffect(() => {
        if (preGameCaptainSignature) {
            setSignatures(prev => ({ ...prev, [captainSignatureKey]: preGameCaptainSignature }));
        }
        if (preGameCoachSignature) {
            setSignatures(prev => ({ ...prev, [coachSignatureKey]: preGameCoachSignature }));
        }
    }, [preGameCaptainSignature, preGameCoachSignature, captainSignatureKey, coachSignatureKey]);

    const handleSignatureClick = (signatureType: string) => {
        // Don't allow editing pre-game signatures
        if (signatureType === captainSignatureKey && preGameCaptainSignature) {
            return;
        }
        if (signatureType === coachSignatureKey && preGameCoachSignature) {
            return;
        }
        setOpenSignature(signatureType);
    };

    const handleSignatureSave = (signatureType: string, signatureDataUrl: string) => {
        // Don't allow overwriting pre-game signatures
        if (signatureType === captainSignatureKey && preGameCaptainSignature) {
            setOpenSignature(null);
            return;
        }
        if (signatureType === coachSignatureKey && preGameCoachSignature) {
            setOpenSignature(null);
            return;
        }
        setSignatures(prev => ({ ...prev, [signatureType]: signatureDataUrl }));
        setOpenSignature(null);
    };

    // Expanded DOB column (50px), Number (25px), Name (Remaining)
    const gridClass = "grid grid-cols-[50px_25px_1fr]";
    // Unified height for Libero and Bench Official cells
    const rowHeight = "h-4";

    // Include all players in roster (including liberos) - up to 14 players total
    const regularPlayers = players.slice(0, 14);
    // Get liberos separately for the libero section, sorted by jersey number
    const liberos = players
        .filter(p => p.libero)
        .sort((a, b) => parseInt(String(a.number || '0')) - parseInt(String(b.number || '0')))
        .slice(0, 2);
    
    return (
        <div className="border bg-white h-full flex flex-col min-w-0" style={borderColor75}>
            <div className="bg-white text-black border-b font-bold py-0.5 text-xs flex justify-between px-1 items-center h-6 shrink-0" style={borderColor75}>
                {isHome ? (
                    <>
                        <div className="w-5 h-5 rounded-full border flex items-center justify-center shrink-0 font-bold text-[10px] uppercase" style={borderColor75}>{coinTossConfirmed ? side : ''}</div>
                        <div className="font-bold text-xs uppercase flex-1 text-center bg-white text-left pl-2">{team}</div>
                    </>
                ) : (
                    <>
                        <div className="font-bold text-xs uppercase flex-1 text-center bg-white pr-2">{team}</div>
                        <div className="w-5 h-5 rounded-full border border-black flex items-center justify-center shrink-0 font-bold text-[10px] uppercase ml-1">{coinTossConfirmed ? side : ''}</div>
                    </>
                )}
            </div>
            {/* Header */}
            <div className={`bg-white border-b ${gridClass} text-[11px] font-bold h-4 items-center shrink-0`} style={borderColor75}>
                <div className="border-r text-center h-full flex items-center justify-center" style={borderColor75}>DoB</div>
                <div className="border-r text-center h-full flex items-center justify-center" style={borderColor75}>No</div>
                <div className="pl-1 h-full flex items-center">Name</div>
            </div>
            
            {/* Players List - 14 players */}
            <div className="flex-1 flex flex-col h-4">
                {Array.from({ length: 14 }).map((_, i) => {
                    const player = regularPlayers[i];
                    const isCaptain = player?.isCaptain;
                    return (
                    <div key={i} className={`${gridClass} last:border-none flex-1 h-4`}>
                        <div className="border-r flex items-center justify-center text-center text-[9px]" style={borderColor75}>{player?.dob || ''}</div>
                        <div className="border-r flex items-center justify-center relative font-bold" style={borderColor75}>
                            <div className="font-bold bg-white text-center w-full text-[10px]">{player?.number || ''}</div>
                            {isCaptain && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                    <circle cx="50" cy="50" r="40" fill="none" stroke="black" strokeWidth="6" />
                                </svg>
                            )}
                        </div>
                        <div className="text-left px-1 font-medium uppercase text-[9px] flex items-center">{player?.name || ''}</div>
                    </div>
                )})}
            </div>
            
            {/* Liberos - 2 players */}
            <div className="border-t shrink-0" style={borderColor75}>
                <div className="bg-gray-200 text-[12px] font-bold border-b h-4 flex items-center justify-center" style={borderColor75}>LIBERO</div>
                {Array.from({ length: 2 }).map((_, i) => {
                    const libero = liberos[i];
                    // Capitalize only (not UPPERCASE) for liberos
                    const liberoName = libero?.name ? libero.name.charAt(0).toUpperCase() + libero.name.slice(1).toLowerCase() : '';
                    return (
                        <div key={i} className={`${gridClass} ${i === 0 ? 'border-none' : ''} ${rowHeight} text-[9px]`}>
                            <div className="border-r text-center flex items-center justify-center" style={borderColor75}>{libero?.dob || ''}</div>
                            <div className="border-r font-bold bg-white text-center flex items-center justify-center" style={borderColor75}>{libero?.number || ''}</div>
                            <div className="text-left px-1 font-medium uppercase text-[9px] flex items-center">{liberoName}</div>
                        </div>
                    );
                })}
            </div>

            {/* Officials */}
             <div className="border-t bg-white shrink-0" style={borderColor75}>
                 <div className="bg-gray-200 text-[12px] font-bold h-4 border-b text-center flex items-center justify-center" style={borderColor75}>BENCH OFFICIALS</div>
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
                         <div key={roleLabel} className={`${gridClass} text-[9px] items-center ${rowHeight}`}>
                             <div className="text-center flex items-center justify-center">{official?.dob || ''}</div>
                             <div className="font-bold text-center border-r border-l h-full flex items-center justify-center bg-white text-[9px]" style={borderColor75}>{roleLabel}</div>
                             <div className="uppercase bg-white px-1 text-left flex items-center">{fullName}</div>
                         </div>
                     );
                 })}
             </div>

             {/* Signatures */}
             <div className="border-t bg-white shrink-0 p-0.5" style={borderColor75}>
                 <div className="flex flex-col gap-1">
                    {/* Captain Signature */}
                    <div className="flex items-center gap-1">
                        <span className="text-[6px] uppercase text-center font-bold w-12 shrink-0">Captain</span>
                        <div 
                            className={`flex-1 border-b relative min-h-[20px] ${
                                preGameCaptainSignature 
                                    ? 'cursor-default' 
                                    : 'cursor-pointer hover:bg-gray-50 print:cursor-default print:hover:bg-white'
                            }`}
                            style={borderColor75}
                            onClick={preGameCaptainSignature ? undefined : () => handleSignatureClick(captainSignatureKey)}
                            title={preGameCaptainSignature ? 'Pre-game signature (read-only)' : 'Click to sign'}
                        >
                            {signatures[captainSignatureKey] ? (
                                <img 
                                    src={signatures[captainSignatureKey]} 
                                    alt="Captain signature"
                                    className="w-full h-5 object-contain pointer-events-none"
                                    style={{ maxHeight: '20px' }}
                                />
                            ) : (
                                <div className="w-full h-5 border-b border-gray-300"></div>
                            )}
                        </div>
                    </div>
                    {/* Coach Signature */}
                    <div className="flex items-center gap-1">
                        <span className="text-[6px] uppercase text-center font-bold w-12 shrink-0">Coach</span>
                        <div 
                            className={`flex-1 border-b relative min-h-[20px] ${
                                preGameCoachSignature 
                                    ? 'cursor-default' 
                                    : 'cursor-pointer hover:bg-gray-50 print:cursor-default print:hover:bg-white'
                            }`}
                            onClick={preGameCoachSignature ? undefined : () => handleSignatureClick(coachSignatureKey)}
                            title={preGameCoachSignature ? 'Pre-game signature (read-only)' : 'Click to sign'}
                        >
                            {signatures[coachSignatureKey] ? (
                                <img 
                                    src={signatures[coachSignatureKey]} 
                                    alt="Coach signature"
                                    className="w-full h-5 object-contain pointer-events-none"
                                    style={{ maxHeight: '20px' }}
                                />
                            ) : (
                                <div className="w-full h-5"></div>
                            )}
                        </div>
                    </div>
                 </div>

                 {/* Signature Modal - only show if signature is not pre-filled */}
                 {openSignature && (
                     (openSignature === captainSignatureKey && !preGameCaptainSignature) ||
                     (openSignature === coachSignatureKey && !preGameCoachSignature)
                 ) && (
                     <SignatureModal
                         open={true}
                         onClose={() => setOpenSignature(null)}
                         onSave={(signatureDataUrl) => handleSignatureSave(openSignature, signatureDataUrl)}
                         title={`${team} ${openSignature.includes('captain') ? 'Captain' : 'Coach'} Signature`}
                     />
                 )}
             </div>
        </div>
    );
};

export const FooterSection: React.FC = () => <div />;