import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleLetter } from './CircleLetter';
import { SanctionRecord, Player } from '../types_scoresheet';
import { isApprovalValid, formatApprovalStamp } from '../../src/domain/accountApproval.js';
import { FitText } from './FitText';
import { findOfficial, formatDob, formatPersonName, idHeadingOf, roleLabelOf, type SheetOfficial } from '../utils/sheetFormat';
import { propsEqual } from '../utils/propsEqual';

/** Sanction rows in the box; further sanctions continue in REMARKS (field-spec 7.2). */
export const SANCTION_ROWS = 9;

interface SanctionsProps {
    items?: SanctionRecord[];
    improperRequests?: { teamA: boolean; teamB: boolean };
}

/** A member code in a sanction cell. A bench player's number is not circled
 *  (owner 2026-10-13), unlike the paper's convention (SC p.62). */
const SanctionCode: React.FC<{ item?: SanctionRecord; type: SanctionRecord['type'] }> = ({ item, type }) => {
    if (!item || item.type !== type) return null;
    return (
        <span className="inline-flex items-center justify-center leading-none" style={{ minWidth: '14px', minHeight: '14px' }}>
            {item.playerNr || ''}
        </span>
    );
};

const SanctionsView: React.FC<SanctionsProps> = ({ items = [], improperRequests = { teamA: false, teamB: false } }) => {
    const rowCount = SANCTION_ROWS;
    const cell = 'border-r border-black flex items-center justify-center text-[10px] min-w-0';

    return (
        <div className="border border-black bg-white flex flex-col h-full relative group overflow-hidden">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 relative shrink-0">
                SANCTIONS
            </div>

            {/* Improper Request Row - Static */}
            {/* One line, never wrapped (owner 2026-11-16: it wrapped into the W P E D
                header): 8px, smaller still when the box is narrow */}
            <div className="flex items-center justify-between gap-1 px-2 py-0.5 border-b border-black shrink-0">
                <FitText max={8} min={5} className="font-bold uppercase flex-1 min-w-0 leading-tight" data-testid="sanctions-improper-label">Improper Request</FitText>
                <div className="flex items-center gap-3 shrink-0">
                    {/* Team A */}
                    <CircleLetter letter="A" size={20} fontPx={12}>
                        {improperRequests.teamA && (
                            <span className="absolute inset-0 flex items-center justify-center text-[20px] leading-none z-10">X</span>
                        )}
                    </CircleLetter>

                    {/* Team B */}
                    <CircleLetter letter="B" size={20} fontPx={12}>
                        {improperRequests.teamB && (
                            <span className="absolute inset-0 flex items-center justify-center text-[20px] leading-none z-10">X</span>
                        )}
                    </CircleLetter>
                </div>
            </div>

            {/* W(arning) P(enalty) E(xpulsion) D(isqualification), as the paper
                sheet (owner 2026-11-15: "D", not "DQ"). A "D" in the W / P cells
                is a delay sanction; the header's D is the column's name. */}
            <div className="grid grid-cols-7 text-[9px] font-bold text-center border-b border-black shrink-0" style={{ height: '0.7cm' }}>
                <div className="border-r border-black flex items-center justify-center" title="Warning">W</div>
                <div className="border-r border-black flex items-center justify-center" title="Penalty">P</div>
                <div className="border-r border-black flex items-center justify-center" title="Expulsion">E</div>
                <div className="border-r border-black flex items-center justify-center" title="Disqualification" data-testid="sanctions-head-disqualification">D</div>
                <div className="border-r border-black flex items-center justify-center h-full">
                    {/* centred on the cap height (CircleLetter): HTML text sat high
                        in the PDF (owner 2026-11-16; 2026-10-21 it read low) */}
                    <div className="flex flex-col items-center justify-center min-h-0 py-0.5 gap-0.5">
                        <CircleLetter letter="A" size={10} fontPx={7} />
                        <CircleLetter letter="B" size={10} fontPx={7} />
                    </div>
                    <div className="flex flex-col items-center justify-center h-full ml-1">
                        <span className="text-[8px] font-normal text-gray-700" style={{ lineHeight: '100%' }}>or</span>
                    </div>
                </div>
                <div className="border-r border-black flex items-center justify-center">Set</div>
                <div className="flex items-center justify-center text-[7.5px] min-w-0" data-testid="sanctions-head-score">Score</div>
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
    /** Told whether the text does not fit the box even at the smallest size. */
    onClipped?: (clipped: boolean) => void;
    /** Officials who signed a remark (a referee coach, ...): domain/remarksSignatures. */
    signatures?: Array<{ role: string; name?: string; image: string }>;
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
    const playerInfo = !isDelay && sanction.playerNr ? `, ${sanction.playerNr}` : '';
    return `Team ${sanction.team}, Set ${sanction.set}, Score ${sanction.score}, ${typeLabel}${playerInfo}`;
};

/**
 * The REMARKS text: the generated remarks, the sanctions beyond the box, then
 * the scorer's own (the sanctions are records of the match: if the box is too
 * small, the free text is what is cut, field-spec 8).
 */
export const remarksText = ({ overflowSanctions = [], remarks = '', generated = [] }: RemarksProps): string => {
    const parts: string[] = [];
    for (const line of generated) if (line.trim()) parts.push(line.trim());
    if (overflowSanctions.length > 0) {
        parts.push(['Sanctions (overflow):', ...overflowSanctions.map(formatSanctionRemark)].join('\n'));
    }
    if (remarks.trim()) parts.push(remarks.trim());
    return parts.join('\n');
};

/**
 * The team names in RESULT's head row (20px) and in a roster's header (h-6):
 * two lines when one is not enough, so the end of a long name (Damen 1 /
 * Damen 2, the sponsor mark) is never the part cut off (no short name stored:
 * the full name is printed there).
 */
export const RESULT_HEAD_TEXT_H = '18px';
export const ROSTER_HEAD_TEXT_H = '18px';

/**
 * REMARKS' smallest size (field-spec 8): 6px, about 1.6 mm or 4.5 pt on the
 * A3 print, still readable. Text that does not fit at 6px goes to page 2
 * (it was 4px, about 3 pt: grey noise on paper, and no page 2 down to there).
 */
export const REMARKS_MIN_PX = 6;

/** The first line of a REMARKS box too small for its text: the PDF prints all of it on page 2. */
export const REMARKS_CONTINUED = 'Remarks continue on page 2.';

const RemarksView: React.FC<RemarksProps> = ({ overflowSanctions = [], remarks = '', generated = [], onClipped, signatures = [] }) => {
    // One text (remarksText). It wraps and shrinks to fit the box: never a
    // scrollbar in the PDF. Still too long at the smallest size, it starts with
    // REMARKS_CONTINUED and the PDF prints the whole text on a second page.
    const full = remarksText({ overflowSanctions, remarks, generated });
    // the text found too long (with the notice shown, it stays so until the text changes)
    const [clippedText, setClippedText] = useState<string | null>(null);
    const clipped = !!full && clippedText === full;
    const text = clipped ? `${REMARKS_CONTINUED}\n${full}` : full;
    const reportClipped = (c: boolean) => { if (c && !clipped) setClippedText(full); };
    useEffect(() => { onClipped?.(clipped); }, [clipped, onClipped]);

    // The Matchblatt's 4 ruled writing lines. While the text fits in 4 lines at the
    // full size, each line sits in its own band between the rules (a rule never runs
    // through the text). Longer text shrinks to fit as before, without the rules.
    const MAX_PX = 9;
    const boxRef = useRef<HTMLDivElement>(null);
    const [band, setBand] = useState(0);
    const [ruled, setRuled] = useState(true);
    useLayoutEffect(() => { setRuled(true); }, [text]);
    useLayoutEffect(() => {
        const box = boxRef.current;
        if (!box) return;
        const h = box.clientHeight / 4;
        if (h > 0 && Math.abs(h - band) > 0.5) { setBand(h); return; }
        const el = box.querySelector<HTMLElement>('[data-testid="remarks-text"]');
        // FitText had to shrink the banded text: it does not fit in 4 lines
        if (ruled && band > 0 && el && parseFloat(el.style.fontSize) < MAX_PX) setRuled(false);
    });
    const banded = ruled && band > 0;
    // (banded, the line height is fixed: a fifth line never fits, at any size,
    // so only the unbanded text tells whether it is cut off)

    return (
        // a box of its own, apart from SANCTIONS and RESULT (owner 2026-10-13)
        <div className="border border-black bg-white flex flex-col h-full overflow-clip">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">REMARKS</div>
            <div className="flex-1 flex min-h-0">
                <div ref={boxRef} className="px-1 flex-1 min-w-0 flex flex-col overflow-hidden min-h-0 relative">
                    {ruled && [1, 2, 3].map(k => (
                        <div key={k} className="absolute left-0 right-0 border-t ss-rule pointer-events-none" style={{ top: `${k * 25}%` }} data-testid="remarks-rule" aria-hidden="true" />
                    ))}
                    <FitText max={MAX_PX} min={REMARKS_MIN_PX} multiline className={`w-full h-full relative ${banded ? '' : 'leading-tight py-0.5'}`} style={banded ? { lineHeight: `${band}px` } : undefined} data-testid="remarks-text" onClipped={banded ? undefined : reportClipped}>
                        {text}
                    </FitText>
                </div>
                {/* officials who signed a remark (referee coach, ...), beside the text */}
                {signatures.length > 0 && (
                    <div className="shrink-0 border-l border-black flex flex-col min-h-0" style={{ width: '32%' }} data-testid="remarks-signatures">
                        {signatures.map((sig, i) => (
                            <div key={i} className={`flex-1 min-h-0 flex flex-col items-center justify-end px-0.5 ${i > 0 ? 'border-t border-black' : ''}`} data-testid="remarks-signature">
                                <img src={sig.image} alt={sig.role} className="min-h-0 max-w-full object-contain flex-1" style={{ maxHeight: '75%' }} />
                                <div className="text-[6px] leading-none pb-px whitespace-nowrap overflow-hidden text-ellipsis max-w-full">{sig.name ? `${sig.role} · ${sig.name}` : sig.role}</div>
                            </div>
                        ))}
                    </div>
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
  bestOf?: number;
  /**
   * Official sheet: leave RESULT blank until the match is finished (`result` set).
   * Default false keeps the live set count for the match-entry view (MatchEntry.jsx).
   */
  blankResultUntilFinished?: boolean;
  /** No outer margin: the sheet places the box edge to edge on its grid. */
  flush?: boolean;
}

// Component to display set duration (removed countdown functionality - duration should only show the set length)
const SetIntervalCountdown: React.FC<{ endTime?: string; duration?: string }> = ({ duration }) => {
  // Simply show the duration - no countdown needed for Results table
  // The duration is the length of the set, calculated from start to end time
  return <span>{duration || ''}</span>;
};

const ResultsView: React.FC<ResultsProps> = ({
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
,
  flush = false
}) => {
    // The rows of sets never played stay blank, not struck off (owner 2026-10-20).
    // Always the sheet's five rows, cells about square (owner 2026-11-15): best
    // of 3 fills rows 1, 2 and 3 (the decider, stored at index 5, in the third
    // row, owner 2026-11-15 later) and rows 4 and 5 stay empty.
    // A set 3 or 4 played in a match stored as best of 3 (its format changed
    // during the match) is printed too, numbered by index, as the totals and the
    // result count it (the sheet warns about it).
    const playedExtraSet = bestOf === 3 && setResults.some(r => (r.setNumber === 3 || r.setNumber === 4) && r.teamATimeouts !== null);
    const isBestOf3 = bestOf === 3 && !playedExtraSet;
    // Stored set index shown in each row, top to bottom
    const displaySets = isBestOf3 ? [1, 2, 5, 3, 4] : [1, 2, 3, 4, 5];
    // The set number printed in a row, as on the set boxes: best of 3 numbers the
    // decider (index 5, third row) "3", the 3rd set played, and leaves the two
    // empty rows unnumbered (Swiss Matchblatt numbers sets in play order;
    // displaySetNumber)
    const rowLabel = (set: number): number | '' => (isBestOf3 ? (set === 5 ? 3 : set <= 2 ? set : '') : set);
    return (
        <div className={`border border-black bg-white flex flex-col h-full overflow-clip ${flush ? '' : 'mr-1'}`}>
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">RESULT</div>
            {/* One grid for the whole table: team A, the centre (Set, Duration) and
                team B share the same row tracks, so every row's top and bottom line
                is at the same height across the three blocks (owner 2026-11-15: the
                centre's rows sat lower and were shorter than the teams' in the
                referee view, where the text's line height differs; each block had
                rows of its own). The header rows have fixed heights, the five set
                rows share the rest equally (about square cells), Total 0.7 cm. The
                1 px column gaps show the black background: the blocks' rules. */}
            <div className="grid bg-black flex-1 min-h-0" style={{ gridTemplateColumns: '1fr 80px 1fr', gridTemplateRows: `20px 13px repeat(${displaySets.length}, minmax(16px, 1fr)) 0.7cm`, columnGap: '1px' }} data-testid="result-table">
                {/* Team names */}
                <div className="flex items-center gap-1 px-1 border-b border-black bg-gray-50 min-w-0 overflow-hidden" data-testid="result-head" data-block="A">
                    <CircleLetter letter="A" size={16} fontPx={9} />
                    <FitText max={9} min={5} multiline style={{ height: RESULT_HEAD_TEXT_H }} className="font-bold text-center uppercase w-full bg-transparent leading-none flex items-center justify-center" data-testid="result-head-name">{coinTossConfirmed ? teamAShortName : ''}</FitText>
                </div>
                <div className="border-b border-black bg-gray-200" data-testid="result-head" data-block="C"></div>
                <div className="flex items-center gap-1 px-1 border-b border-black bg-gray-50 flex-row-reverse min-w-0 overflow-hidden" data-testid="result-head" data-block="B">
                    <CircleLetter letter="B" size={16} fontPx={9} />
                    <FitText max={9} min={5} multiline style={{ height: RESULT_HEAD_TEXT_H }} className="font-bold text-center uppercase w-full bg-transparent leading-none flex items-center justify-center" data-testid="result-head-name">{coinTossConfirmed ? teamBShortName : ''}</FitText>
                </div>

                {/* Column headings */}
                <div className="grid grid-cols-4 text-[8px] leading-none text-center font-bold bg-white border-b border-black" data-testid="result-subhead" data-block="A">
                    <div className="border-r border-black flex items-center justify-center">T</div>
                    <div className="border-r border-black flex items-center justify-center">S</div>
                    <div className="border-r border-black flex items-center justify-center">W</div>
                    <div className="flex items-center justify-center">P</div>
                </div>
                <div className="grid text-[8px] leading-none text-center font-bold bg-white border-b border-black" style={{ gridTemplateColumns: '1fr 2fr' }} data-testid="result-subhead" data-block="C">
                    <span className="border-r border-black flex items-center justify-center">Set</span>
                    <span className="flex items-center justify-center">(Duration)</span>
                </div>
                <div className="grid grid-cols-4 text-[8px] leading-none text-center font-bold bg-white border-b border-black" data-testid="result-subhead" data-block="B">
                    <div className="border-r border-black flex items-center justify-center">P</div>
                    <div className="border-r border-black flex items-center justify-center">W</div>
                    <div className="border-r border-black flex items-center justify-center">S</div>
                    <div className="flex items-center justify-center">T</div>
                </div>

                {/* The set rows: A, centre and B of a row in the same grid row */}
                {displaySets.map((set, idx) => {
                    const setData = setResults.find(r => r.setNumber === set);
                    const finishedA = setData && setData.teamATimeouts !== null;
                    const finishedB = setData && setData.teamBTimeouts !== null;
                    const rule = idx < displaySets.length - 1 ? 'border-b ss-rule' : '';
                    const num = 'flex items-center justify-center text-[9px] font-bold leading-none min-w-0';
                    return (
                        <React.Fragment key={set}>
                            <div className={`grid grid-cols-4 bg-white min-h-0 ${rule}`} data-testid="result-team-row" data-team="A" data-set={set} data-row={idx + 1}>
                                <div className={`border-r ss-rule ${num}`}>{finishedA ? (setData.teamATimeouts ?? 0) : ''}</div>
                                <div className={`border-r ss-rule ${num}`}>{finishedA ? (setData.teamASubstitutions ?? 0) : ''}</div>
                                <div className={`border-r ss-rule ${num}`}>{finishedA ? (setData.teamAWon ?? 0) : ''}</div>
                                <div className={num}>{finishedA ? (setData.teamAPoints ?? 0) : ''}</div>
                            </div>
                            <div className={`grid bg-white min-h-0 ${rule}`} style={{ gridTemplateColumns: '1fr 2fr' }} data-testid="result-row" data-set={set} data-row={idx + 1}>
                                <div className={`border-r border-black ${num}`} data-testid="result-row-label">{rowLabel(set)}</div>
                                <div className={num}>
                                    <SetIntervalCountdown endTime={setData?.endTime} duration={setData?.duration} />
                                </div>
                            </div>
                            <div className={`grid grid-cols-4 bg-white min-h-0 ${rule}`} data-testid="result-team-row" data-team="B" data-set={set} data-row={idx + 1}>
                                <div className={`border-r ss-rule ${num}`}>{finishedB ? (setData.teamBPoints ?? 0) : ''}</div>
                                <div className={`border-r ss-rule ${num}`}>{finishedB ? (setData.teamBWon ?? 0) : ''}</div>
                                <div className={`border-r ss-rule ${num}`}>{finishedB ? (setData.teamBSubstitutions ?? 0) : ''}</div>
                                <div className={num}>{finishedB ? (setData.teamBTimeouts ?? 0) : ''}</div>
                            </div>
                        </React.Fragment>
                    );
                })}

                {/* Total row */}
                {(() => {
                    const sum = (key: keyof SetResult) => setResults.reduce((acc, r) => acc + (r[key] !== null ? ((r[key] as number) || 0) : 0), 0) || 0;
                    // Total is the sum of all set durations (in minutes), from strings like "25'"
                    const totalMinutes = setResults.reduce((acc, r) => {
                        const match = r.duration ? r.duration.match(/(\d+)'/) : null;
                        return acc + (match ? parseInt(match[1], 10) : 0);
                    }, 0);
                    const cell = 'flex items-center justify-center text-center font-bold text-[9px] leading-none min-w-0';
                    return (
                        <>
                            <div className="grid grid-cols-4 bg-gray-50 border-t border-black min-h-0" data-testid="result-total" data-block="A">
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamATimeouts')}</div>
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamASubstitutions')}</div>
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamAWon')}</div>
                                <div className={cell}>{sum('teamAPoints')}</div>
                            </div>
                            <div className="grid bg-white border-t border-black min-h-0" style={{ gridTemplateColumns: '1fr 2fr' }} data-testid="result-total" data-block="C">
                                <div className={`border-r border-black ${cell}`}>Total</div>
                                <div className={cell}>{totalMinutes > 0 ? `${totalMinutes}'` : ''}</div>
                            </div>
                            <div className="grid grid-cols-4 bg-gray-50 border-t border-black min-h-0" data-testid="result-total" data-block="B">
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamBPoints')}</div>
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamBWon')}</div>
                                <div className={`border-r ss-rule ${cell}`}>{sum('teamBSubstitutions')}</div>
                                <div className={cell}>{sum('teamBTimeouts')}</div>
                            </div>
                        </>
                    );
                })()}
            </div>

            {/* Match start / end / duration: "HH h MM min" / "H h MM min" (field-spec 9),
                on the table's columns (owner 2026-10-13: lines aligned): Start under T,
                End under Set, Duration under P W */}
            <div className="border-t border-black grid gap-px bg-black shrink-0" style={{ height: '0.6cm', gridTemplateColumns: '1fr 80px 1fr' }}>
                <div className="bg-white grid grid-cols-4 min-w-0">
                    <div className="border-r border-black text-[8px] font-bold flex items-center justify-center">Start</div>
                    <div className="col-span-3 flex items-center justify-center min-w-0">
                        <FitText max={8} min={5} className="w-full text-center font-bold">{matchStart}</FitText>
                    </div>
                </div>
                <div className="bg-white grid min-w-0" style={{ gridTemplateColumns: '1fr 2fr' }}>
                    <div className="border-r border-black text-[8px] font-bold flex items-center justify-center">End</div>
                    <div className="flex items-center justify-center min-w-0">
                        <FitText max={8} min={5} className="w-full text-center font-bold">{matchEnd}</FitText>
                    </div>
                </div>
                <div className="bg-white grid grid-cols-4 min-w-0">
                    <div className="col-span-2 border-r border-black text-[8px] font-bold flex items-center justify-center">Duration</div>
                    <div className="col-span-2 flex items-center justify-center min-w-0">
                        <FitText max={8} min={5} className="w-full text-center font-bold">{matchDuration}</FitText>
                    </div>
                </div>
            </div>

            {/* Winner Area */}
            {/* one row of exactly the box's height (minmax(0,1fr)): an auto row grew with the
                unshrunk name (3 lines at 18px), so FitText measured no overflow */}
            <div className="p-1 grid grid-cols-[3fr_1fr] grid-rows-[minmax(0,1fr)] gap-1 border-t border-black h-14 shrink-0">
                 <div className="relative min-h-0">
                     <span className="text-[12px] leading-none absolute top-0 left-0 text-gray-500">WINNER</span>
                     {/* the full name (field-spec 9): shrinks to fit, never cut or overflowing the box */}
                     {/* the name and the result are centred in the same band under their
                         labels, so they stand on one line (owner 2026-10-13) */}
                     <div className="w-full h-full flex items-center justify-center pb-0.5 pt-[14px] min-w-0">
                         <FitText max={18} min={6} multiline className="w-full h-full flex items-center justify-center text-center font-black uppercase leading-none" data-testid="results-winner">{winner}</FitText>
                     </div>
                 </div>
                 <div className="relative" >
                     <span className="text-[12px] leading-none absolute top-0 left-0 right-0 text-center text-gray-500">RESULT</span>
                     <div className="w-full h-full font-black text-lg flex items-center justify-center pb-0.5 pt-[14px] leading-none" data-testid="results-score">
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

// The approval grid's fixed columns (the signature takes the rest) and the
// x of the rule at the right of each (88, 88+120, +72, +72).
const APPROVAL_COL = {
    official: 'w-[88px] shrink-0',
    name: 'w-[120px] shrink-0',
    country: 'w-[72px] shrink-0',
    dob: 'w-[72px] shrink-0'
};
const APPROVAL_RULES_PX = [88, 208, 280, 352];

const ApprovalsView: React.FC<ApprovalsProps> = ({ officials = [], match, teamAKey = 'home', lineJudges = [], sets = [] }) => {
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
        // a box of its own, as REMARKS; as tall as its slot, so it ends on the
        // bottom line of SANCTIONS, RESULT and the rosters (owner 2026-10-13)
        <div className="border border-black bg-white flex flex-col w-full h-full overflow-clip">
            <div className="bg-gray-200 border-b border-black text-center font-bold text-[10px] py-0.5 shrink-0">APPROVAL</div>

            {/* Column headers and the officials' rows share one grid (owner 2026-10-13:
                entries centred vertically; names left with a small margin, country,
                DoB and signature centred). The
                columns end where they did with the earlier padded layout, so the line
                judges' label (88px) still lines up with the Official column. The
                column rules are drawn once over header and rows: the PDF capture
                fixes every box's height on its own, and rules drawn per cell then
                stopped short of a row's bottom line. */}
            <div className="relative flex flex-col flex-1 min-h-0">
            <div className="flex items-stretch border-b border-black text-[9px] font-bold h-5 shrink-0">
                 <div className={`${APPROVAL_COL.official} pl-2 flex items-center`}>Official</div>
                 <div className={`${APPROVAL_COL.name} pl-2 flex items-center`}>Name</div>
                 <div className={`${APPROVAL_COL.country} flex items-center justify-center`}>Country</div>
                 {/* the paper's "Lizenz-Nr." column: the licence, or a date of birth (idHeadingOf) */}
                 <div className={`${APPROVAL_COL.dob} flex items-center justify-center`}>{idHeadingOf(match)}</div>
                 <div className="flex-1 flex items-center justify-center">Signature</div>
            </div>

            {/* Officials List */}
            <div className="flex flex-col flex-1 min-h-0">
                {roles.map((role, idx) => {
                    const official = getOfficial(role);
                    // "Lastname, F." (field-spec 10)
                    const fullName = official ? formatPersonName(official.lastName, official.firstName) : '';

                    return (
                    <div key={idx} className="flex items-stretch border-b border-black flex-1 min-h-5 overflow-clip">
                        <div className={`${APPROVAL_COL.official} pl-2 font-bold text-[9px] flex items-center whitespace-nowrap`}>{role}</div>

                        <div className={`${APPROVAL_COL.name} flex items-center pl-2 pr-1 min-w-0`} data-testid={`approval-name-${idx}`}>
                            <FitText max={9} min={5} className="w-full text-left leading-tight" title={fullName}>{fullName}</FitText>
                        </div>

                        <div className={`${APPROVAL_COL.country} flex items-center justify-center text-[9px] leading-none`}>
                            {fullName ? (official?.country || '') : ''}
                        </div>

                        <div className={`${APPROVAL_COL.dob} flex items-center justify-center text-[9px] leading-none`} data-testid={`approval-dob-${idx}`}>
                            {/* the value (a licence, or a date of birth); an older match's scorer licence field */}
                            {fullName ? (formatDob(official?.dob) || official?.licence || '') : ''}
                        </div>
                        <div className="flex-1 relative flex items-center justify-center min-h-0 min-w-0">
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
                                    className="w-full h-5 text-center leading-[1.15] text-black px-0.5 flex items-center justify-center"
                                    data-testid={`approval-stamp-${APPROVAL_SLOT_OF_ROLE[role]}`}
                                >
                                    {getApprovalStamp(role)}
                                </FitText>
                            ) : null}
                        </div>
                    </div>
                );
                })}
            </div>
            {APPROVAL_RULES_PX.map((x) => (
                <div key={x} className="absolute top-0 bottom-0 border-l border-black pointer-events-none" style={{ left: `${x - 1}px` }} aria-hidden="true" />
            ))}
            </div>

            {/* Line Judges - 2 rows */}
            <div className="flex border-b border-black shrink-0" style={{ height: '42px' }}>
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
            <div className="flex justify-center items-center gap-2 pl-2 pr-4 py-2 h-7 shrink-0">
                {/* Left: Captain Signature label, in line with the officials' labels */}
                <span className="text-[7px] uppercase shrink-0 leading-tight">Captain<br />Signature</span>

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
                    <CircleLetter letter="A" size={16} fontPx={12} />
                    <CircleLetter letter="B" size={16} fontPx={12} />
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
  /** No left rule of its own: the roster beside it draws that line. */
  noLeftRule?: boolean;
  /**
   * Kept for the callers; the signature boxes are read-only on every sheet now
   * (a signature drawn here was never saved to the match).
   */
  readOnly?: boolean;
  /**
   * The LIBERO box (utils/extractLiberoData rosterLiberos): the registered
   * liberos only (a re-designated one is in the remarks). Without it, the
   * players flagged libero, re-designated ones left out.
   */
  liberos?: Player[];
  /** The heading beside the numbers: Licence, DoB, ID or Info (idHeadingOf). */
  idHeading?: string;
}

const RosterView: React.FC<RosterProps> = ({ team, side, players = [], benchStaff = [], preGameCaptainSignature, preGameCoachSignature, coinTossConfirmed, isHome = true, noLeftRule = false, liberos: liberoList, idHeading = 'Licence' }) => {
    // bench_home / bench_away may be null or an object in older rows
    const staff: any[] = Array.isArray(benchStaff) ? benchStaff : [];

    // The signatures come from the match record only (coin toss, also signed on a
    // phone), read from the props on every render so they show the moment they are
    // saved (owner 2026-10-07). The boxes are read-only: a signature drawn on the
    // sheet stayed in this window, was never saved and was missing from the
    // approval PDF (made in a window of its own) and the cloud record.
    const captainSignature = preGameCaptainSignature || '';
    const coachSignature = preGameCoachSignature || '';

    // Licence | No | Name, as the Matchblatt roster (field-spec 3): its "Lizenz-Nr." column
    // holds the licence or, when the scorer typed one, the date of birth (owner
    // 2026-11-19; a Global match: DoB, ID or Info).
    // Owner 2026-10-07: the roster's whole width, the value never clipped and every
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
    // The libero section: the registered liberos (see rosterLiberos), else the
    // players flagged libero by jersey number; a re-designated libero is not
    // listed (remarks, as Genius). Two rows; a further one is named in the last
    // row, never dropped without a trace.
    // By shirt number, like the 14 rows (owner 2026-11-16), not libero 1 / libero 2
    const allLiberos: Player[] = [...(liberoList ?? players
        .filter(p => p.libero && p.libero !== 'redesignated'))]
        .sort((a, b) => parseInt(String(a.number || '0')) - parseInt(String(b.number || '0')));
    const liberos = allLiberos.slice(0, 2);
    const extraLiberos = allLiberos.slice(2);

    return (
        <div className={`border border-r-0 border-black bg-white w-full h-full flex flex-col min-w-0 overflow-clip ${noLeftRule ? 'border-l-0' : ''}`} data-testid={`roster-${isHome ? 'home' : 'away'}`}>
            {/* The A/B circle at the outer side, the short name centred in the header
                (owner 2026-10-07: both rosters alike); a spacer as wide as the circle
                on the other side keeps the name on the header's centre line */}
            <div className={`text-black border-b border-r border-black font-bold py-0.5 text-xs flex px-1 items-center gap-1 h-6 shrink-0 ${isHome ? '' : 'flex-row-reverse'}`}>
                <CircleLetter letter={coinTossConfirmed ? String(side || '').toUpperCase() : ''} size={20} fontPx={10} className="bg-white" />
                <FitText max={12} min={6} multiline style={{ height: ROSTER_HEAD_TEXT_H }} className="font-bold uppercase flex-1 text-center leading-none flex items-center justify-center" data-testid="roster-team-name">{team}</FitText>
                <div className="w-5 h-5 shrink-0" aria-hidden="true" />
            </div>
            {/* Header */}
            <div className={`border-b border-r border-black ${gridClass} text-[11px] font-bold h-4 items-center shrink-0`}>
                <div className="border-r border-black text-center h-full flex items-center justify-center">{idHeading}</div>
                <div className="border-r border-black text-center h-full flex items-center justify-center">No</div>
                <div className="pl-1 h-full flex items-center">Name</div>
            </div>

            {/* Players List - 14 players */}
            <div className="flex-1 flex flex-col h-4 border-r border-black">
                {Array.from({ length: 14 }).map((_, i) => {
                    const player = regularPlayers[i];
                    const isCaptain = player?.isCaptain;
                    return (
                    <div key={i} className={`${gridClass} border-b ss-rule last:border-b-0 flex-1 min-h-0 overflow-clip`} data-testid="roster-row">
                        <div className={`border-r border-black ${dobClass}`}>{player?.dob || ''}</div>
                        <div className="border-r border-black flex items-center justify-center relative font-bold">
                            <div className="font-bold text-center w-full text-[10px]">{player?.number || ''}</div>
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
            <div className="border-t border-r border-black shrink-0 overflow-clip">
                <div className="bg-gray-200 text-[12px] font-bold border-b border-black h-4 flex items-center justify-center">LIBERO</div>
                {Array.from({ length: 2 }).map((_, i) => {
                    const libero = liberos[i];
                    const liberoName = libero?.name || '';
                    return (
                        <div key={i} className={`${gridClass} ${rowHeight} text-[9px] overflow-clip ${i === 0 ? 'border-b ss-rule' : ''}`} data-testid="roster-libero-row">
                            <div className={`border-r border-black ${dobClass}`}>{libero?.dob || ''}</div>
                            <div className="border-r border-black font-bold text-center flex items-center justify-center">{libero?.number || ''}</div>
                            <div className="text-left px-1 font-medium flex items-center justify-between min-w-0">
                                <FitText max={9} min={5} className="flex-1">{liberoName}</FitText>
                                {libero?.isLfp && <span className="text-[7px] font-bold ml-1 shrink-0">LFP</span>}
                                {i === 1 && extraLiberos.length > 0 && (
                                    <span className="text-[6px] ml-1 shrink-0" data-testid="roster-libero-extra">+{extraLiberos.map(p => p.number).join(', ')}</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Officials */}
             <div className="border-t border-r border-black shrink-0 overflow-clip">
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
                     // Global: the official's own name for the role ("Teacher") beside the name
                     const ownRole = roleLabelOf(official);
                     const fullName = official
                         ? formatPersonName(official.lastName ?? official.last_name, official.firstName ?? official.first_name)
                         : '';
                     const shownName = ownRole && fullName ? `${fullName} · ${ownRole}` : fullName;

                     return (
                         <div key={roleLabel} className={`${gridClass} text-[9px] items-stretch ${rowHeight} overflow-clip ${roleIdx < 4 ? 'border-b ss-rule' : ''}`} data-testid="roster-official-row">
                             <div className={`border-r border-black ${dobClass}`}>{formatDob(official?.dob)}</div>
                             <div className={`font-bold text-center border-r border-black h-full flex items-center justify-center ${(ownRole || roleLabel).length > 1 ? 'text-[7px]' : 'text-[9px]'}`}>{ownRole ? ownRole.slice(0, 3).toUpperCase() : roleLabel}</div>
                             <div className="px-1 text-left flex items-center min-w-0">
                                 <FitText max={9} min={5} className="flex-1">{shownName}</FitText>
                             </div>
                         </div>
                     );
                 })}
             </div>

             {/* Signatures */}
             <div className="border-t border-r border-black shrink-0 p-0.5 overflow-clip">
                 <div className="flex flex-col gap-1">
                    {/* Captain Signature */}
                    <div className="flex items-center gap-1">
                        <span className="text-[6px] uppercase text-center font-bold w-12 shrink-0">Captain</span>
                        <div className="flex-1 relative min-h-[20px] cursor-default">
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
                        <div className="flex-1 relative min-h-[20px] cursor-default">
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

             </div>
        </div>
    );
};

export const FooterSection: React.FC = () => <div />;

// Memoised (utils/propsEqual): a new sheet model with the same values for this
// section does not re-render it (review 2026-11-16, F2/F3)
export const Sanctions = React.memo(SanctionsView, propsEqual);
export const Remarks = React.memo(RemarksView, propsEqual);
export const Results = React.memo(ResultsView, propsEqual);
export const Approvals = React.memo(ApprovalsView, propsEqual);
export const Roster = React.memo(RosterView, propsEqual);
