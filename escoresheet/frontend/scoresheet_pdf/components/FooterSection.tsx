import React, { useState } from 'react';
import { SanctionRecord, Player } from '../types_scoresheet';
import { SignatureModal } from './SignatureModal';
import { isApprovalValid, formatApprovalStamp } from '../../src/domain/accountApproval.js';
import { FitText } from './FitText';
import { findOfficial, formatDob, formatPersonName, type SheetOfficial } from '../utils/sheetFormat';

/** Sanction rows in the box; further sanctions continue in REMARKS (field-spec 7.2). */
export const SANCTION_ROWS = 9;

interface SanctionsProps {
    items?: SanctionRecord[];
    improperRequests?: { teamA: boolean; teamB: boolean };
}

/** A member code in a sanction cell; a bench player's number is circled (SC p.62). */
const SanctionCode: React.FC<{ item?: SanctionRecord; type: SanctionRecord['type'] }> = ({ item, type }) => {
    if (!item || item.type !== type) return null;
    return (
        <span className="relative inline-flex items-center justify-center leading-none" style={{ minWidth: '14px', minHeight: '14px' }}>
            {item.playerNr || ''}
            {item.onBench && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" data-testid="sanction-bench-circle">
                    <circle cx="50" cy="50" r="44" fill="none" stroke="black" strokeWidth="6" />
                </svg>
            )}
        </span>
    );
};

export const Sanctions: React.FC<SanctionsProps> = ({ items = [], improperRequests = { teamA: false, teamB: false } }) => {
    const rowCount = SANCTION_ROWS;
    const cell = 'border-r border-black flex items-center justify-center text-[10px] min-w-0';

    return (
        <div className="border border-black bg-white flex flex-col h-full relative group overflow-hidden">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 relative shrink-0">
                SANCTIONS
            </div>

            {/* Improper Request Row - Static */}
            <div className="flex items-center justify-between px-2 py-0.5 border-b border-black bg-white shrink-0">
                <span className="text-[9px] font-bold uppercase">Improper Request</span>
                <div className="flex items-center gap-3">
                    {/* Team A */}
                    <div className="w-5 h-5 rounded-full border border-black flex items-center justify-center relative select-none bg-white">
                        <span className="text-[12px] font-bold leading-none relative z-0">A</span>
                        {improperRequests.teamA && (
                            <span className="absolute inset-0 flex items-center justify-center text-[20px] leading-none z-10">X</span>
                        )}
                    </div>

                    {/* Team B */}
                    <div className="w-5 h-5 rounded-full border border-black flex items-center justify-center relative select-none bg-white">
                        <span className="text-[12px] font-bold leading-none relative z-0">B</span>
                        {improperRequests.teamB && (
                            <span className="absolute inset-0 flex items-center justify-center text-[20px] leading-none z-10">X</span>
                        )}
                    </div>
                </div>
            </div>

            {/* W(arning) P(enalty) E(xpulsion) DQ (disqualification): "DQ", not "D",
                which the W / P columns use for a delay */}
            <div className="grid grid-cols-7 text-[9px] font-bold text-center border-b border-black bg-white shrink-0" style={{ height: '0.7cm' }}>
                <div className="border-r border-black flex items-center justify-center" title="Warning">W</div>
                <div className="border-r border-black flex items-center justify-center" title="Penalty">P</div>
                <div className="border-r border-black flex items-center justify-center" title="Expulsion">E</div>
                <div className="border-r border-black flex items-center justify-center" title="Disqualification">DQ</div>
                <div className="border-r border-black flex items-center justify-center h-full">
                    <div className="flex flex-col items-center justify-center min-h-0 py-0.5 gap-0.5">
                        <div className="w-2.5 h-2.5 rounded-full border border-black flex items-center justify-center text-[7px] font-bold bg-white">A</div>
                        <div className="w-2.5 h-2.5 rounded-full border border-black flex items-center justify-center text-[7px] font-bold bg-white">B</div>
                    </div>
                    <div className="flex flex-col items-center justify-center h-full ml-1">
                        <span className="text-[8px] font-normal text-gray-700" style={{ lineHeight: '100%' }}>or</span>
                    </div>
                </div>
                <div className="border-r border-black flex items-center justify-center">Set</div>
                <div className="flex items-center justify-center">Score</div>
            </div>
            {/* Ruled rows and columns, as the Matchblatt: a referee can still add an entry by hand */}
            <div className="flex-1 flex flex-col min-h-0">
                {Array.from({ length: rowCount }).map((_, i) => {
                    const item = items[i];
                    return (
                    <div key={i} className="grid grid-cols-7 flex-1 text-xs min-h-0 border-b border-black last:border-b-0" data-testid="sanction-row">
                         <div className={cell}><SanctionCode item={item} type="warning" /></div>
                         <div className={cell}><SanctionCode item={item} type="penalty" /></div>
                         <div className={cell}><SanctionCode item={item} type="expulsion" /></div>
                         <div className={cell}><SanctionCode item={item} type="disqualification" /></div>
                         <div className={`${cell} uppercase px-0.5`}>{item?.team || ''}</div>
                         <div className={cell}>{item?.set || ''}</div>
                         <div className="flex items-center justify-center text-[9px] min-w-0">{item?.score || ':'}</div>
                    </div>
                )})}
            </div>
        </div>
    );
};

interface RemarksProps {
    overflowSanctions?: SanctionRecord[];
    remarks?: string;
    /** Remarks the sheet writes itself (a default, an incomplete team), printed first. */
    generated?: string[];
}

/** One overflow sanction as a remark line, in the sanction-row format (field-spec 7.2). */
export const formatSanctionRemark = (sanction: SanctionRecord): string => {
    const isDelay = sanction.playerNr === 'D';
    const typeLabel = sanction.type === 'warning'
        ? (isDelay ? 'Delay Warning' : 'Warning')
        : sanction.type === 'penalty'
        ? (isDelay ? 'Delay Penalty' : 'Penalty')
        : sanction.type === 'expulsion'
        ? 'Expulsion'
        : sanction.type === 'disqualification'
        ? 'Disqualification'
        : '';
    const member = sanction.onBench ? `(${sanction.playerNr})` : sanction.playerNr;
    const playerInfo = !isDelay && sanction.playerNr ? `, ${member}` : '';
    return `Team ${sanction.team}, Set ${sanction.set}, Score ${sanction.score}, ${typeLabel}${playerInfo}`;
};

export const Remarks: React.FC<RemarksProps> = ({ overflowSanctions = [], remarks = '', generated = [] }) => {
    // One text: generated remarks, the scorer's own, then the sanctions beyond the box.
    // It wraps and shrinks to fit the box: never hidden, never a scrollbar in the PDF.
    const parts: string[] = [];
    for (const line of generated) if (line.trim()) parts.push(line.trim());
    if (remarks.trim()) parts.push(remarks.trim());
    if (overflowSanctions.length > 0) {
        parts.push(['Sanctions (overflow):', ...overflowSanctions.map(formatSanctionRemark)].join('\n'));
    }
    const text = parts.join('\n');

    return (
        <div className="border border-r-0 border-black bg-white flex flex-col h-full">
            <div className="bg-gray-200 border-b border-r border-black text-center font-bold text-[10px] py-0.5 shrink-0">REMARKS</div>
            <div className="border-r border-black p-1 flex-1 flex flex-col overflow-hidden min-h-0 relative">
                {/* the 4 ruled writing lines of the Matchblatt, behind the text */}
                {[1, 2, 3].map(k => (
                    <div key={k} className="absolute left-0 right-0 border-t ss-rule pointer-events-none" style={{ top: `${k * 25}%` }} data-testid="remarks-rule" aria-hidden="true" />
                ))}
                <FitText max={9} min={4} multiline className="w-full h-full leading-tight relative" data-testid="remarks-text">
                    {text}
                </FitText>
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
  bestOf?: number;
  /**
   * Official sheet: leave RESULT blank until the match is finished (`result` set).
   * Default false keeps the live set count for the match-entry view (MatchEntry.jsx).
   */
  blankResultUntilFinished?: boolean;
}

/** A single line through an unused row (SC p.18: one line for one empty row). */
const RowStrike: React.FC = () => (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-10" viewBox="0 0 100 100" preserveAspectRatio="none" data-testid="row-strike" aria-hidden="true">
        <line x1="0" y1="50" x2="100" y2="50" stroke="black" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
);

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
  coinTossConfirmed = false,
  bestOf = 5,
  blankResultUntilFinished = false
}) => {
    // Once the match is decided, the rows of sets never played are struck off (field-spec 9, 11)
    const matchOver = !!result;
    // For best-of-3: show 3 rows (sets 1, 2, and the deciding set which is stored at index 5)
    // For best-of-5: show 5 rows (sets 1-5)
    const isBestOf3 = bestOf === 3;
    const displaySets = isBestOf3 ? [1, 2, 5] : [1, 2, 3, 4, 5];
    return (
        <div className="border border-r-0 border-black bg-white flex flex-col mr-1 h-full">
            <div className="bg-gray-200 border-b border-r border-black text-center font-bold text-[10px] py-0.5 shrink-0">RESULT</div>
            <div className="grid grid-cols-[1fr_80px_1fr] gap-px bg-black flex-1 min-h-0">
                {/* Team A Stats */}
                <div className="bg-white flex flex-col">
                    <div className="flex items-center gap-1 px-1 border-b border-black h-5 bg-gray-50">
                         <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0">A</div>
                         <FitText max={9} min={5} className="font-bold text-center uppercase w-full bg-transparent">{coinTossConfirmed ? teamAShortName : ''}</FitText>
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b border-black">
                        <div className="border-r border-black">T</div><div className="border-r border-black">S</div><div className="border-r border-black">W</div><div >P</div>
                    </div>
                    <div className="flex-1 flex flex-col">
                        {displaySets.map((set, idx) => {
                            const setData = setResults.find(r => r.setNumber === set);
                            const isFinished = setData && setData.teamATimeouts !== null;
                            return (
                             <div key={set} className={`grid grid-cols-4 flex-1 ${idx < displaySets.length - 1 ? 'border-b ss-rule' : ''} text-xs relative`}>
                                {matchOver && !isFinished && <RowStrike />}
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamATimeouts ?? 0) : ''}
                                </div>
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamASubstitutions ?? 0) : ''}
                                </div>
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamAWon ?? 0) : ''}
                                </div>
                                <div className="flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamAPoints ?? 0) : ''}
                                </div>
                             </div>
                            );
                        })}
                        {/* Total Row */}
                        <div className="border-t border-black grid grid-cols-4 bg-gray-50" style={{ height: '0.7cm' }}>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamATimeouts !== null ? (r.teamATimeouts || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamASubstitutions !== null ? (r.teamASubstitutions || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamAWon !== null ? (r.teamAWon || 0) : 0), 0) || 0}
                            </div>
                            <div className="text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamAPoints !== null ? (r.teamAPoints || 0) : 0), 0) || 0}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Center Duration & Set */}
                <div className="bg-white flex flex-col">
                     <div className="h-5 border-b border-black bg-gray-200"></div>
                     <div className="bg-white text-[8px] font-bold text-center border-b border-black h-[13px] grid" style={{ gridTemplateColumns: '1fr 2fr' }}>
                         <span className="border-r border-black flex-1">Set</span>
                         <span className="flex-1">(Duration)</span>
                     </div>
                     <div className="flex-1 flex flex-col">
                        {displaySets.map((set, idx) => {
                            const setData = setResults.find(r => r.setNumber === set);
                            // For best-of-3 the deciding set is stored internally at index 5
                            // but is the 3rd set played, so it is numbered "3" on the sheet
                            // (Swiss Matchblatt records sets in play order 1,2,3).
                            const displayLabel = isBestOf3 && set === 5 ? "3" : set;
                            // every set label is pre-printed, as on the paper (unplayed rows are struck off)
                            const showSetNumber = true;
                            return (
                            <div key={set} className={`flex-1 ${idx < displaySets.length - 1 ? 'border-b ss-rule' : ''} grid font-bold text-xs bg-white relative`} style={{ gridTemplateColumns: '1fr 2fr' }}>
                                {matchOver && !(setData && setData.teamATimeouts !== null) && <RowStrike />}
                                <div className="flex items-center justify-center border-r border-black text-[9px]">{showSetNumber ? displayLabel : ''}</div>
                                <div className="flex items-center justify-center text-[9px]">
                                    <SetIntervalCountdown endTime={setData?.endTime} duration={setData?.duration} />
                                </div>
                            </div>
                            );
                        })}
                        <div className="border-t border-black grid bg-white" style={{ gridTemplateColumns: '1fr 2fr', height: '0.7cm' }}>
                            <div className="flex items-center justify-center font-bold text-[9px] border-r border-black">Total</div>
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
                    <div className="flex items-center gap-1 px-1 border-b border-r border-black h-5 bg-gray-50 flex-row-reverse">
                         <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center bg-white text-black text-[9px] font-bold shrink-0">B</div>
                         <FitText max={9} min={5} className="font-bold text-center uppercase w-full bg-transparent">{coinTossConfirmed ? teamBShortName : ''}</FitText>
                    </div>
                    <div className="grid grid-cols-4 text-[8px] text-center font-bold bg-white border-b border-black">
                        <div className="border-r border-black">P</div><div className="border-r border-black">W</div><div className="border-r border-black">S</div><div className="border-r border-black">T</div>
                    </div>
                    <div className="flex-1 flex flex-col border-r border-black">
                        {displaySets.map((set, idx) => {
                            const setData = setResults.find(r => r.setNumber === set);
                            const isFinished = setData && setData.teamBTimeouts !== null;
                            return (
                             <div key={set} className={`grid grid-cols-4 flex-1 ${idx < displaySets.length - 1 ? 'border-b ss-rule' : ''} text-xs min-h-[16px] relative`}>
                                {matchOver && !isFinished && <RowStrike />}
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBPoints ?? 0) : ''}
                                </div>
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBWon ?? 0) : ''}
                                </div>
                                <div className="border-r ss-rule flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBSubstitutions ?? 0) : ''}
                                </div>
                                <div className="flex items-center justify-center text-[9px] font-bold">
                                    {isFinished ? (setData.teamBTimeouts ?? 0) : ''}
                                </div>
                             </div>
                            );
                        })}
                        <div className="border-t border-black grid grid-cols-4 bg-gray-50" style={{ height: '0.7cm' }}>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBPoints !== null ? (r.teamBPoints || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBWon !== null ? (r.teamBWon || 0) : 0), 0) || 0}
                            </div>
                            <div className="border-r ss-rule text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBSubstitutions !== null ? (r.teamBSubstitutions || 0) : 0), 0) || 0}
                            </div>
                            <div className="text-center font-bold flex items-center justify-center text-[9px]">
                                {setResults.reduce((sum, r) => sum + (r.teamBTimeouts !== null ? (r.teamBTimeouts || 0) : 0), 0) || 0}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Match start / end / duration: "HH h MM min" / "H h MM min" (field-spec 9) */}
            <div className="border-t border-black grid bg-white shrink-0" style={{ height: '0.6cm', gridTemplateColumns: 'auto 1fr auto 1fr auto 1fr' }}>
                <div className="border-r border-black text-[8px] font-bold flex items-center justify-start px-1">Start</div>
                <div className="border-r border-black flex items-center justify-center min-w-0">
                    <FitText max={8} min={5} className="w-full text-center font-bold bg-white">{matchStart}</FitText>
                </div>
                <div className="border-r border-black text-[8px] font-bold flex items-center justify-start px-1">End</div>
                <div className="border-r border-black flex items-center justify-center min-w-0">
                    <FitText max={8} min={5} className="w-full text-center font-bold bg-white">{matchEnd}</FitText>
                </div>
                <div className="border-r border-black text-[8px] font-bold flex items-center justify-start px-1">Duration</div>
                <div className="border-r border-black flex items-center justify-center min-w-0">
                    <FitText max={8} min={5} className="w-full text-center font-bold bg-white">{matchDuration}</FitText>
                </div>
            </div>

            {/* Winner Area */}
            {/* one row of exactly the box's height (minmax(0,1fr)): an auto row grew with the
                unshrunk name (3 lines at 18px), so FitText measured no overflow */}
            <div className="border-r border-black p-1 grid grid-cols-[3fr_1fr] grid-rows-[minmax(0,1fr)] gap-1 border-t border-black h-14 shrink-0 bg-white">
                 <div className="relative min-h-0">
                     <span className="text-[12px] leading-none absolute top-0 left-0 text-gray-500">WINNER</span>
                     {/* the full name (field-spec 9): shrinks to fit, never cut or overflowing the box */}
                     <div className="w-full h-full flex items-end justify-center pb-0.5 pt-[14px] min-w-0">
                         <FitText max={18} min={6} multiline className="w-full h-full text-center font-black uppercase bg-white leading-none" data-testid="results-winner">{winner}</FitText>
                     </div>
                 </div>
                 <div className="relative" >
                     <span className="text-[12px] leading-none absolute top-0 left-0 right-0 text-center text-gray-500">RESULT</span>
                     <div className="w-full h-full font-black text-lg bg-white flex items-end justify-center pb-0.5">
                         {(() => {
                             // `result` ("3-1", or "3:1" from MatchEntry) is only set once the match
                             // is finished, like WINNER. The official sheet stays blank until then;
                             // the live match-entry view shows the running set count.
                             let winnerSets: string | number = '';
                             let loserSets: string | number = '';
                             if (result) {
                                 [winnerSets = '', loserSets = ''] = result.split(/[-:]/);
                             } else if (blankResultUntilFinished) {
                                 return null;
                             } else {
                                 const teamASetsWon = setResults.reduce((sum, r) => sum + (r.teamAWon || 0), 0);
                                 const teamBSetsWon = setResults.reduce((sum, r) => sum + (r.teamBWon || 0), 0);
                                 winnerSets = Math.max(teamASetsWon, teamBSetsWon);
                                 loserSets = Math.min(teamASetsWon, teamBSetsWon);
                             }
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
  /** normalizeOfficials(match.officials) */
  officials?: SheetOfficial[];
  match?: any;
  teamAKey?: 'home' | 'away';
  lineJudges?: string[];
  /** The match's sets: an account approval prints only while it matches their result. */
  sets?: any[];
}

// Rows that may be approved with an account instead of a drawn signature
// (docs/account-approval-spec.md 4.6). The assistant scorer signs only.
const APPROVAL_SLOT_OF_ROLE: Record<string, string> = {
    '1st Referee': 'referee1',
    '2nd Referee': 'referee2',
    'Scorer': 'scorer'
};

export const Approvals: React.FC<ApprovalsProps> = ({ officials = [], match, teamAKey = 'home', lineJudges = [], sets = [] }) => {
    const roles = ["1st Referee", "2nd Referee", "Scorer", "Assistant Scorer"];

    // Line judges are stored as one name, as typed: printed as entered (splitting it
    // into first / last name garbled compound names, "Marie Claire de la Fontaine")
    const formatLineJudgeName = (fullName: string): string => (fullName || '').trim();

    // Load signatures from match data
    const getSignatureForRole = (role: string): string | null => {
        if (role === '1st Referee') return match?.ref1Signature || null;
        if (role === '2nd Referee') return match?.ref2Signature || null;
        if (role === 'Scorer') return match?.scorerSignature || null;
        if (role === 'Assistant Scorer') return match?.asstScorerSignature || null;
        return null;
    };

    // A valid account approval of the role, printed as text when no signature was drawn
    const getApprovalStamp = (role: string): string | null => {
        const slot = APPROVAL_SLOT_OF_ROLE[role];
        const record = slot ? match?.accountApprovals?.[slot] : null;
        return record && isApprovalValid(record, sets) ? formatApprovalStamp(record) : null;
    };

    // Post-game captain signatures (separate from pre-game coin toss signatures)
    const getCaptainSignature = (side: 'home' | 'away'): string | null => {
        // Use post-game signature fields if available, NOT the pre-game coin toss signatures
        if (side === 'home') return match?.homePostGameCaptainSignature || null;
        return match?.awayPostGameCaptainSignature || null;
    };

    // Determine which team is A and which is B
    const homeIsA = teamAKey === 'home';
    const homeCaptainSignature = getCaptainSignature('home');
    const awayCaptainSignature = getCaptainSignature('away');
    const captainASignature = homeIsA ? homeCaptainSignature : awayCaptainSignature;
    const captainBSignature = homeIsA ? awayCaptainSignature : homeCaptainSignature;

    const getOfficial = (role: string) => findOfficial(officials, role);

    return (
        <div className="border border-r-0 border-black bg-white flex flex-col w-full">
            <div className="bg-gray-200 border-b border-r border-black text-center font-bold text-[10px] py-0.5 shrink-0">APPROVAL</div>

            {/* Column Headers */}
            <div className="flex items-center border-b border-r border-black px-2 gap-2 text-[8px] font-bold bg-white h-5 shrink-0">
                 <div className="w-20 border-r border-black text-left text-[9px] h-5 flex items-center justify-left">Official</div>
                 <div className="w-28 border-r border-black text-left text-[9px] h-5 flex items-center justify-left">Name</div>
                 <div className="w-16 border-r border-black text-center text-[9px] h-5 flex items-center justify-center">Country</div>
                 {/* the paper's "Lizenz-Nr." column holds the date of birth (SC p.9-11) */}
                 <div className="w-16 border-r border-black text-center text-[9px] h-5 flex items-center justify-center">DoB</div>
                 <div className="flex-1 text-center text-[9px] h-5 flex items-center justify-center">Signature</div>
            </div>

            {/* Officials List */}
            <div className="flex flex-col flex-1 min-h-0">
                {roles.map((role, idx) => {
                    const official = getOfficial(role);
                    // "Lastname, F." (field-spec 10)
                    const fullName = official ? formatPersonName(official.lastName, official.firstName) : '';

                    return (
                    <div key={idx} className="flex items-center border-b border-r border-black px-2 gap-2 flex-1 h-5">
                        <div className="w-20 border-r border-black font-bold text-[9px] shrink-0 flex items-center h-5">{role}</div>

                        <div className="w-28 border-r border-black shrink-0 flex items-center h-5 min-w-0">
                            <FitText max={9} min={5} className="w-full bg-white pb-0.5 pr-0.5" title={fullName}>{fullName}</FitText>
                        </div>

                        <div className="w-16 border-r border-black shrink-0 flex items-center justify-center h-5">
                            <div className="text-center w-full text-[9px] bg-white pb-0.5">{fullName ? (official?.country || '') : ''}</div>
                        </div>

                         <div className="w-16 border-r border-black shrink-0 flex items-center justify-center h-5" data-testid={`approval-dob-${idx}`}>
                            <div className="text-center w-full text-[9px] bg-white pb-0.5">{fullName ? formatDob(official?.dob) : ''}</div>
                        </div>

                        <div
                            className="flex-1 h-full relative flex items-end min-h-0"
                        >
                            {/* Signature space - read-only in PDF. A drawn signature wins;
                                else the stamp of a valid account approval; else empty. */}
                            {getSignatureForRole(role) ? (
                                <img
                                    src={getSignatureForRole(role)!}
                                    alt={`${role} signature`}
                                    className="w-full h-5 object-contain"
                                    style={{ maxHeight: '20px' }}
                                />
                            ) : getApprovalStamp(role) ? (
                                <FitText
                                    max={7.5}
                                    min={5}
                                    multiline
                                    className="w-full h-5 text-left leading-[1.15] text-black pl-0.5 pt-[1px]"
                                    data-testid={`approval-stamp-${APPROVAL_SLOT_OF_ROLE[role]}`}
                                >
                                    {getApprovalStamp(role)}
                                </FitText>
                            ) : (
                                <div className="w-full h-5"></div>
                            )}
                        </div>
                    </div>
                );
                })}
            </div>

            {/* Line Judges - 2 rows */}
            <div className="flex border-b border-r border-black shrink-0" style={{ height: '42px' }}>
                {/* Line Judges label - spans both rows */}
                <div className=" font-bold text-[9px] shrink-0 flex items-center px-2 border-r border-black" style={{ width: '88px' }}>
                    Line Judges
                </div>
                {/* Line Judges 1-4 in 2 rows x 2 columns */}
                <div className="flex-1 flex flex-col">
                    {/* Row 1: Line Judges 1 and 2 */}
                    <div className="flex-1 flex border-b border-black">
                        <div className="flex-1 flex items-center px-2 border-r border-black min-w-0">
                            <span className="text-[9px] font-bold mr-1">1.</span>
                            <FitText max={9} min={5} className="flex-1">{formatLineJudgeName(lineJudges[0] || '')}</FitText>
                        </div>
                        <div className="flex-1 flex items-center px-2 min-w-0">
                            <span className="text-[9px] font-bold mr-1">2.</span>
                            <FitText max={9} min={5} className="flex-1">{formatLineJudgeName(lineJudges[1] || '')}</FitText>
                        </div>
                    </div>
                    {/* Row 2: Line Judges 3 and 4 */}
                    <div className="flex-1 flex">
                        <div className="flex-1 flex items-center px-2 border-r border-black min-w-0">
                            <span className="text-[9px] font-bold mr-1">3.</span>
                            <FitText max={9} min={5} className="flex-1">{formatLineJudgeName(lineJudges[2] || '')}</FitText>
                        </div>
                        <div className="flex-1 flex items-center px-2 min-w-0">
                            <span className="text-[9px] font-bold mr-1">4.</span>
                            <FitText max={9} min={5} className="flex-1">{formatLineJudgeName(lineJudges[3] || '')}</FitText>
                        </div>
                    </div>
                </div>
            </div>

            {/* Captains - Central Layout */}
            <div className="flex justify-center border-r border-black items-center gap-2 px-4 py-2 h-7 shrink-0">
                {/* Left: Captain Signature label */}
                <span className="text-[7px] uppercase shrink-0">Captain<br />Signature</span>

                {/* Captain A Signature */}
                <div className="flex-1 flex flex-col">
                    <div className="flex-1 relative min-h-[24px]">
                        {captainASignature ? (
                            <img
                                src={captainASignature}
                                alt="Captain A signature"
                                className="w-full h-6 object-contain"
                                style={{ maxHeight: '24px' }}
                            />
                        ) : (
                            <div className="w-full h-6"></div>
                        )}
                    </div>
                </div>

                {/* Center: A and B circles */}
                <div className="flex items-center justify-center gap-3 shrink-0">
                    <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center font-bold text-xs bg-white">A</div>
                    <div className="w-4 h-4 rounded-full border border-black flex items-center justify-center font-bold text-xs bg-white">B</div>
                </div>

                {/* Captain B Signature */}
                <div className="flex-1 flex flex-col">
                    <div className="flex-1 relative min-h-[24px]">
                        {captainBSignature ? (
                            <img
                                src={captainBSignature}
                                alt="Captain B signature"
                                className="w-full h-6 object-contain"
                                style={{ maxHeight: '24px' }}
                            />
                        ) : (
                            <div className="w-full h-6"></div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

interface RosterProps {
  team: string;
  side: string;
  players?: Player[];
  benchStaff?: any[] | null;
  preGameCaptainSignature?: string;
  preGameCoachSignature?: string;
  coinTossConfirmed?: boolean;
  isHome?: boolean;
}

export const Roster: React.FC<RosterProps> = ({ team, side, players = [], benchStaff = [], preGameCaptainSignature, preGameCoachSignature, coinTossConfirmed, isHome = true }) => {
    const [openSignature, setOpenSignature] = useState<string | null>(null);
    // bench_home / bench_away may be null or an object in older rows
    const staff: any[] = Array.isArray(benchStaff) ? benchStaff : [];

    // Create unique signature keys based on side
    const captainSignatureKey = `roster-${side.toLowerCase()}-captain`;
    const coachSignatureKey = `roster-${side.toLowerCase()}-coach`;

    // Signatures drawn on this sheet itself (only where the match record has none).
    // The match record's signatures (coin toss, also signed on a phone) always win
    // and show the moment they are saved: read from the props on every render
    // (owner 2026-10-07), never copied into state that could go stale.
    const [signatures, setSignatures] = useState<Record<string, string>>({});
    const captainSignature = preGameCaptainSignature || signatures[captainSignatureKey] || '';
    const coachSignature = preGameCoachSignature || signatures[coachSignatureKey] || '';

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

    // DoB | No | Name, as the Matchblatt roster (field-spec 3): its "Lizenz-Nr." column
    // holds the date of birth (SC p.10), so there is no separate licence column.
    // Owner 2026-10-07: the roster's whole width, the DoB never clipped and every
    // name on one line. DD.MM.YYYY at 8.5 px tabular figures is ~45 px; the name
    // takes all the rest (and shrinks to fit, never wraps).
    const gridClass = "grid grid-cols-[52px_20px_minmax(0,1fr)]";
    const dobClass = "flex items-center justify-center text-center text-[8.5px] tabular-nums whitespace-nowrap overflow-hidden";
    // Unified height for Libero and Bench Official cells
    const rowHeight = "h-4";

    // The 14 rows, liberos included, by shirt number (formatPlayers sorts them). A team
    // with more than 14 players: the extra ones go in the last row's note, never dropped
    // without a trace.
    const regularPlayers = players.slice(0, 14);
    const extraPlayers = players.slice(14);
    // Get liberos separately for the libero section, sorted by jersey number
    const liberos = players
        .filter(p => p.libero)
        .sort((a, b) => parseInt(String(a.number || '0')) - parseInt(String(b.number || '0')))
        .slice(0, 2);

    return (
        <div className="border border-r-0 border-black bg-white w-full h-full flex flex-col min-w-0" data-testid={`roster-${isHome ? 'home' : 'away'}`}>
            {/* The A/B circle at the outer side, the short name centred in the header
                (owner 2026-10-07: both rosters alike); a spacer as wide as the circle
                on the other side keeps the name on the header's centre line */}
            <div className={`bg-white text-black border-b border-r border-black font-bold py-0.5 text-xs flex px-1 items-center gap-1 h-6 shrink-0 ${isHome ? '' : 'flex-row-reverse'}`}>
                <div className="w-5 h-5 rounded-full border border-black flex items-center justify-center shrink-0 font-bold text-[10px] uppercase">{coinTossConfirmed ? side : ''}</div>
                <FitText max={12} min={6} className="font-bold uppercase flex-1 bg-white text-center" data-testid="roster-team-name">{team}</FitText>
                <div className="w-5 h-5 shrink-0" aria-hidden="true" />
            </div>
            {/* Header */}
            <div className={`bg-white border-b border-r border-black ${gridClass} text-[11px] font-bold h-4 items-center shrink-0`}>
                <div className="border-r border-black text-center h-full flex items-center justify-center">DoB</div>
                <div className="border-r border-black text-center h-full flex items-center justify-center">No</div>
                <div className="pl-1 h-full flex items-center">Name</div>
            </div>

            {/* Players List - 14 players */}
            <div className="flex-1 flex flex-col h-4 border-r border-black">
                {Array.from({ length: 14 }).map((_, i) => {
                    const player = regularPlayers[i];
                    const isCaptain = player?.isCaptain;
                    return (
                    <div key={i} className={`${gridClass} border-b ss-rule last:border-b-0 flex-1 min-h-0`} data-testid="roster-row">
                        <div className={`border-r border-black ${dobClass}`}>{player?.dob || ''}</div>
                        <div className="border-r border-black flex items-center justify-center relative font-bold">
                            <div className="font-bold bg-white text-center w-full text-[10px]">{player?.number || ''}</div>
                            {isCaptain && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                    <circle cx="50" cy="50" r="40" fill="none" stroke="black" strokeWidth="6" />
                                </svg>
                            )}
                        </div>
                        <div className="text-left px-1 font-medium flex items-center justify-between min-w-0">
                            <FitText max={9} min={5} className="flex-1" title={player?.name || ''}>{player?.name || ''}</FitText>
                            {player?.isLfp && <span className="text-[7px] font-bold ml-1 shrink-0">LFP</span>}
                            {i === 13 && extraPlayers.length > 0 && (
                                <span className="text-[6px] ml-1 shrink-0" data-testid="roster-extra-players">+{extraPlayers.map(p => p.number).join(', ')}</span>
                            )}
                        </div>
                    </div>
                )})}
            </div>

            {/* Liberos - 2 players */}
            <div className="border-t border-r border-black shrink-0">
                <div className="bg-gray-200 text-[12px] font-bold border-b border-black h-4 flex items-center justify-center">LIBERO</div>
                {Array.from({ length: 2 }).map((_, i) => {
                    const libero = liberos[i];
                    const liberoName = libero?.name || '';
                    return (
                        <div key={i} className={`${gridClass} ${rowHeight} text-[9px] ${i === 0 ? 'border-b ss-rule' : ''}`} data-testid="roster-libero-row">
                            <div className={`border-r border-black ${dobClass}`}>{libero?.dob || ''}</div>
                            <div className="border-r border-black font-bold bg-white text-center flex items-center justify-center">{libero?.number || ''}</div>
                            <div className="text-left px-1 font-medium flex items-center justify-between min-w-0">
                                <FitText max={9} min={5} className="flex-1">{liberoName}</FitText>
                                {libero?.isLfp && <span className="text-[7px] font-bold ml-1 shrink-0">LFP</span>}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Officials */}
             <div className="border-t border-r border-black bg-white shrink-0">
                 <div className="bg-gray-200 text-[12px] font-bold h-4 border-b border-black text-center flex items-center justify-center">BENCH OFFICIALS</div>
                 {['C', 'AC1', 'AC2', 'P', 'M'].map((roleLabel, roleIdx) => {
                     const roleMap: { [key: string]: string } = {
                         'C': 'Coach',
                         'AC1': 'Assistant Coach 1',
                         'AC2': 'Assistant Coach 2',
                         'P': 'Physiotherapist',
                         'M': 'Medic'
                     };
                     const official = staff.find(s => s && s.role === roleMap[roleLabel]);
                     const fullName = official
                         ? formatPersonName(official.lastName ?? official.last_name, official.firstName ?? official.first_name)
                         : '';

                     return (
                         <div key={roleLabel} className={`${gridClass} text-[9px] items-stretch ${rowHeight} ${roleIdx < 4 ? 'border-b ss-rule' : ''}`} data-testid="roster-official-row">
                             <div className={dobClass}>{formatDob(official?.dob)}</div>
                             <div className="font-bold text-center border-r border-l border-black h-full flex items-center justify-center bg-white text-[9px]">{roleLabel}</div>
                             <div className="bg-white px-1 text-left flex items-center min-w-0">
                                 <FitText max={9} min={5} className="flex-1">{fullName}</FitText>
                             </div>
                         </div>
                     );
                 })}
             </div>

             {/* Signatures */}
             <div className="border-t border-r border-black bg-white shrink-0 p-0.5">
                 <div className="flex flex-col gap-1">
                    {/* Captain Signature */}
                    <div className="flex items-center gap-1">
                        <span className="text-[6px] uppercase text-center font-bold w-12 shrink-0">Captain</span>
                        <div
                            className={`flex-1 relative min-h-[20px] ${
                                preGameCaptainSignature
                                    ? 'cursor-default'
                                    : 'cursor-pointer hover:bg-gray-50 print:cursor-default print:hover:bg-white'
                            }`}
                            onClick={preGameCaptainSignature ? undefined : () => handleSignatureClick(captainSignatureKey)}
                            title={preGameCaptainSignature ? 'Pre-game signature (read-only)' : 'Click to sign'}
                        >
                            {captainSignature ? (
                                <img
                                    src={captainSignature}
                                    data-testid="roster-captain-signature"
                                    alt="Captain signature"
                                    className="w-full h-5 object-contain pointer-events-none"
                                    style={{ maxHeight: '20px' }}
                                />
                            ) : (
                                <div className="w-full h-5"></div>
                            )}
                        </div>
                    </div>
                    {/* Coach Signature */}
                    <div className="flex items-center gap-1">
                        <span className="text-[6px] uppercase text-center font-bold w-12 shrink-0">Coach</span>
                        <div
                            className={`flex-1 relative min-h-[20px] ${
                                preGameCoachSignature
                                    ? 'cursor-default'
                                    : 'cursor-pointer hover:bg-gray-50 print:cursor-default print:hover:bg-white'
                            }`}
                            onClick={preGameCoachSignature ? undefined : () => handleSignatureClick(coachSignatureKey)}
                            title={preGameCoachSignature ? 'Pre-game signature (read-only)' : 'Click to sign'}
                        >
                            {coachSignature ? (
                                <img
                                    src={coachSignature}
                                    data-testid="roster-coach-signature"
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
