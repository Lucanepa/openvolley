import React from 'react';
import { LCSData, LiberoReplacement } from '../types_scoresheet';
import { Header } from './Header';

interface LiberoControlSheetProps {
  match?: any;
  homeTeam?: any;
  awayTeam?: any;
  teamAName: string;
  teamBName: string;
  teamAKey: 'home' | 'away';
  lcsData: LCSData;
  coinTossConfirmed?: boolean;
}

const ROWS_PER_COLUMN = 8;
const ROWS_PER_SET5_COLUMN = 5;

const renderRows = (reps: LiberoReplacement[], count: number) => {
  return Array.from({ length: count }).map((_, i) => {
    const rep = reps[i];
    return (
      <div key={i} className="grid grid-cols-3 border-b border-black" style={{ height: '14px' }}>
        <div className="border-r border-black text-center text-[9px] leading-[14px] font-bold">
          {rep?.liberoNumber || ''}
        </div>
        <div className="border-r border-black text-center text-[9px] leading-[14px] font-bold">
          {rep && !rep.isExchange ? rep.replacedPlayer || '' : ''}
        </div>
        <div className="text-center text-[9px] leading-[14px]">
          {rep?.score ? rep.score.replace(':', ' : ') : ''}
        </div>
      </div>
    );
  });
};

const renderColumnHeaders = () => (
  <div className="grid grid-cols-3 border-b border-black bg-gray-100">
    <div className="border-r border-black text-center text-[8px] font-bold py-[1px]">Lib.</div>
    <div className="border-r border-black text-center text-[8px] font-bold py-[1px]">Rep.</div>
    <div className="text-center text-[8px] font-bold py-[1px]">Score</div>
  </div>
);

const LiberoHeader: React.FC<{
  liberos: { number: number }[];
  teamLetter: string;
  colSpan?: number;
  compact?: boolean;
}> = ({ liberos, teamLetter, colSpan = 1, compact }) => {
  const circleSize = compact ? 'w-3.5 h-3.5 text-[7px] leading-[12px]' : 'w-4 h-4 text-[8px] leading-[14px]';
  const numSize = compact ? 'text-[8px]' : 'text-[9px]';
  return (
    <div
      className="flex items-center justify-center gap-2 border-b border-black py-[1px] bg-gray-50"
      style={colSpan > 1 ? { gridColumn: `span ${colSpan}` } : undefined}
    >
      <span className="text-[8px]">No:</span>
      <span className={`${numSize} font-bold`}>{liberos[0]?.number || '__'}</span>
      <div className={`${circleSize} rounded-full border border-black text-center font-bold`}>{teamLetter}</div>
      <span className="text-[8px]">No:</span>
      <span className={`${numSize} font-bold`}>{liberos[1]?.number || '__'}</span>
    </div>
  );
};

const SetSection: React.FC<{
  setNumber: number;
  teamALiberos: { number: number }[];
  teamBLiberos: { number: number }[];
  teamAReps: LiberoReplacement[];
  teamBReps: LiberoReplacement[];
  rowsPerColumn: number;
}> = ({ setNumber, teamALiberos, teamBLiberos, teamAReps, teamBReps, rowsPerColumn }) => {
  return (
    <div className="border-t border-black">
      <div className="bg-gray-200 text-center font-bold text-[10px] border-b border-black py-[1px]">
        SET {setNumber}
      </div>
      {/* 4-column grid: Team A (2 cols) | Team B (2 cols) */}
      <div className="grid grid-cols-4">
        <LiberoHeader liberos={teamALiberos} teamLetter="A" colSpan={2} />
        <LiberoHeader liberos={teamBLiberos} teamLetter="B" colSpan={2} />
      </div>
      <div className="grid grid-cols-4">
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(teamAReps.slice(0, rowsPerColumn), rowsPerColumn)}
        </div>
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(teamAReps.slice(rowsPerColumn), Math.max(rowsPerColumn, teamAReps.length - rowsPerColumn))}
        </div>
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(teamBReps.slice(0, rowsPerColumn), rowsPerColumn)}
        </div>
        <div>
          {renderColumnHeaders()}
          {renderRows(teamBReps.slice(rowsPerColumn), Math.max(rowsPerColumn, teamBReps.length - rowsPerColumn))}
        </div>
      </div>
    </div>
  );
};

const Set5Section: React.FC<{
  teamALiberos: { number: number }[];
  teamBLiberos: { number: number }[];
  teamAReps: LiberoReplacement[];
  teamBReps: LiberoReplacement[];
  teamAReps_After: LiberoReplacement[];
  teamBReps_After: LiberoReplacement[];
  rowsPerColumn: number;
}> = ({ teamALiberos, teamBLiberos, teamAReps, teamBReps, teamAReps_After, teamBReps_After, rowsPerColumn }) => {
  // Combine before + after for each team, then split into 2 columns
  const allTeamA = [...teamAReps, ...teamAReps_After];
  const allTeamB = [...teamBReps, ...teamBReps_After];

  return (
    <div className="border-t border-black">
      <div className="bg-gray-200 text-center font-bold text-[10px] border-b border-black py-[1px]">
        SET 5
      </div>
      <div className="grid grid-cols-4">
        <LiberoHeader liberos={teamALiberos} teamLetter="A" colSpan={2} compact />
        <LiberoHeader liberos={teamBLiberos} teamLetter="B" colSpan={2} compact />
      </div>
      <div className="grid grid-cols-4">
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(allTeamA.slice(0, rowsPerColumn), rowsPerColumn)}
        </div>
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(allTeamA.slice(rowsPerColumn), Math.max(rowsPerColumn, allTeamA.length - rowsPerColumn))}
        </div>
        <div className="border-r border-black">
          {renderColumnHeaders()}
          {renderRows(allTeamB.slice(0, rowsPerColumn), rowsPerColumn)}
        </div>
        <div>
          {renderColumnHeaders()}
          {renderRows(allTeamB.slice(rowsPerColumn), Math.max(rowsPerColumn, allTeamB.length - rowsPerColumn))}
        </div>
      </div>
    </div>
  );
};

const Footer: React.FC<{ redesignationA?: any; redesignationB?: any }> = ({ redesignationA, redesignationB }) => (
  <div className="border border-black border-t-0">
    <div className="grid grid-cols-2 border-b border-black">
      <div className="border-r border-black px-2 py-[2px] flex items-center gap-2">
        <span className="text-[8px] font-bold">Re-designation team A:</span>
        <span className="text-[8px]">No:(OUT/IN)</span>
        <span className="text-[9px] font-bold underline min-w-[20px]">
          {redesignationA ? `${redesignationA.outNumber}/${redesignationA.inNumber}` : '__/__'}
        </span>
        <span className="text-[8px]">Set:</span>
        <span className="text-[9px] font-bold underline min-w-[12px]">
          {redesignationA?.setNumber || '____'}
        </span>
        <span className="text-[8px]">Points:</span>
        <span className="text-[9px] font-bold underline min-w-[20px]">
          {redesignationA?.score ? redesignationA.score.replace(':', ' : ') : '____:____'}
        </span>
      </div>
      <div className="px-2 py-[2px] flex items-center gap-2">
        <span className="text-[8px] font-bold">Re-designation team B:</span>
        <span className="text-[8px]">No:(OUT/IN)</span>
        <span className="text-[9px] font-bold underline min-w-[20px]">
          {redesignationB ? `${redesignationB.outNumber}/${redesignationB.inNumber}` : '__/__'}
        </span>
        <span className="text-[8px]">Set:</span>
        <span className="text-[9px] font-bold underline min-w-[12px]">
          {redesignationB?.setNumber || '____'}
        </span>
        <span className="text-[8px]">Points:</span>
        <span className="text-[9px] font-bold underline min-w-[20px]">
          {redesignationB?.score ? redesignationB.score.replace(':', ' : ') : '____:____'}
        </span>
      </div>
    </div>
    <div className="border-b border-black px-2 py-[2px]">
      <span className="text-[8px] font-bold">Remark(s): </span>
      <span className="text-[8px]">{'_'.repeat(80)}</span>
    </div>
    <div className="grid grid-cols-2 px-2 py-[3px]">
      <div className="flex items-center gap-1">
        <span className="text-[8px] font-bold">Name of the Assistant scorer:</span>
        <span className="text-[8px]">{'_'.repeat(30)}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[8px] font-bold">Signature:</span>
        <span className="text-[8px]">{'_'.repeat(40)}</span>
      </div>
    </div>
  </div>
);

// Calculate how many rows each set needs (max of its two teams, considering 2-col split)
function calcSetRowsNeeded(teamAReps: LiberoReplacement[], teamBReps: LiberoReplacement[], minPerCol: number): number {
  // Each team has 2 columns. We need enough rows so col1 + col2 covers all data.
  // Col1 gets rows 0..N-1, col2 gets rows N..end. N = rowsPerColumn.
  // We need rowsPerColumn >= ceil(max(teamA, teamB) / 2) but at least minPerCol.
  const maxReps = Math.max(teamAReps.length, teamBReps.length);
  return Math.max(minPerCol, Math.ceil(maxReps / 2));
}

// Height constants (in mm) for page layout calculation
const PAGE_HEIGHT_MM = 297;
const PAGE_PADDING_TOP_MM = 4;
const PAGE_PADDING_BOTTOM_MM = 4;
const TITLE_HEIGHT_MM = 8;
const HEADER_HEIGHT_MM = 22; // scaled Header component
const SET_HEADER_HEIGHT_MM = 5; // SET N title + libero header row
const COL_HEADER_HEIGHT_MM = 3; // Lib.|Rep.|Score header
const ROW_HEIGHT_MM = 3.7; // ~14px at standard DPI
const FOOTER_HEIGHT_MM = 16;
const USABLE_HEIGHT_MM = PAGE_HEIGHT_MM - PAGE_PADDING_TOP_MM - PAGE_PADDING_BOTTOM_MM;

function computeSetHeight(rowsPerColumn: number): number {
  return SET_HEADER_HEIGHT_MM + COL_HEADER_HEIGHT_MM + rowsPerColumn * ROW_HEIGHT_MM;
}

export const LiberoControlSheet: React.FC<LiberoControlSheetProps> = ({
  match,
  homeTeam,
  awayTeam,
  teamAName,
  teamBName,
  teamAKey,
  lcsData,
  coinTossConfirmed,
}) => {
  const redesignationA = lcsData.redesignations.find(r => r.team === 'A');
  const redesignationB = lcsData.redesignations.find(r => r.team === 'B');

  // Calculate rows needed per set
  const setRowCounts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const setData = lcsData.sets.find(s => s.setNumber === i);
    setRowCounts.push(
      calcSetRowsNeeded(
        setData?.teamAReplacements || [],
        setData?.teamBReplacements || [],
        ROWS_PER_COLUMN
      )
    );
  }
  // Set 5: combine before + after
  const set5Data = lcsData.sets.find(s => s.setNumber === 5);
  const allSet5A = [...(set5Data?.teamAReplacements || []), ...(set5Data?.teamAReplacements_After || [])];
  const allSet5B = [...(set5Data?.teamBReplacements || []), ...(set5Data?.teamBReplacements_After || [])];
  const set5RowCount = calcSetRowsNeeded(allSet5A, allSet5B, ROWS_PER_SET5_COLUMN);
  setRowCounts.push(set5RowCount);

  // Calculate total height needed
  const totalSetHeights = setRowCounts.map(r => computeSetHeight(r));
  const page1FixedHeight = TITLE_HEIGHT_MM + HEADER_HEIGHT_MM + 2; // 2mm margins
  const totalContentHeight = page1FixedHeight + totalSetHeights.reduce((a, b) => a + b, 0) + FOOTER_HEIGHT_MM;

  // Determine if we need multiple pages
  const needsMultiplePages = totalContentHeight > USABLE_HEIGHT_MM;

  if (!needsMultiplePages) {
    // Single page - render everything together
    return (
      <div className="flex flex-col bg-white shadow-xl" style={{ width: '210mm', height: '297mm', padding: '4mm 5mm 4mm 5mm', fontFamily: 'Arial, Helvetica, sans-serif', boxSizing: 'border-box' }}>
        <div className="text-center font-bold text-[14px] tracking-wide py-1 border border-black mb-1 bg-gray-100">
          LIBERO CONTROL SHEET
        </div>
        <div className="mb-1" style={{ transform: 'scale(0.52)', transformOrigin: 'top left', width: '192.3%' }}>
          <Header
            match={match}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
            teamAName={teamAName}
            teamBName={teamBName}
            coinTossConfirmed={coinTossConfirmed}
          />
        </div>
        <div className="border border-black flex-1 flex flex-col">
          {[1, 2, 3, 4].map((setNum, idx) => {
            const setData = lcsData.sets.find(s => s.setNumber === setNum);
            return (
              <SetSection
                key={setNum}
                setNumber={setNum}
                teamALiberos={lcsData.teamALiberos}
                teamBLiberos={lcsData.teamBLiberos}
                teamAReps={setData?.teamAReplacements || []}
                teamBReps={setData?.teamBReplacements || []}
                rowsPerColumn={setRowCounts[idx]}
              />
            );
          })}
          <Set5Section
            teamALiberos={lcsData.teamALiberos}
            teamBLiberos={lcsData.teamBLiberos}
            teamAReps={set5Data?.teamAReplacements || []}
            teamBReps={set5Data?.teamBReplacements || []}
            teamAReps_After={set5Data?.teamAReplacements_After || []}
            teamBReps_After={set5Data?.teamBReplacements_After || []}
            rowsPerColumn={set5RowCount}
          />
        </div>
        <Footer redesignationA={redesignationA} redesignationB={redesignationB} />
      </div>
    );
  }

  // Multi-page: distribute sets across pages
  // Page 1: title + header + as many sets as fit + footer (if all sets fit)
  // Page 2+: continuation sets + footer on last page
  const pages: { sets: number[]; includeHeader: boolean; includeFooter: boolean }[] = [];
  let currentPage: { sets: number[]; includeHeader: boolean; includeFooter: boolean } = {
    sets: [],
    includeHeader: true,
    includeFooter: false,
  };
  let currentHeight = page1FixedHeight;

  for (let i = 0; i < 5; i++) {
    const setHeight = totalSetHeights[i];
    const isLast = i === 4;
    const neededWithFooter = currentHeight + setHeight + (isLast ? FOOTER_HEIGHT_MM : 0);

    if (neededWithFooter <= USABLE_HEIGHT_MM) {
      currentPage.sets.push(i + 1);
      currentHeight += setHeight;
      if (isLast) {
        currentPage.includeFooter = true;
      }
    } else {
      // Current set doesn't fit - start new page
      if (currentPage.sets.length > 0) {
        pages.push(currentPage);
      }
      currentPage = { sets: [i + 1], includeHeader: false, includeFooter: isLast };
      currentHeight = setHeight + (isLast ? FOOTER_HEIGHT_MM : 0);
      // If even a single set + footer doesn't fit, we still put it (it'll be a bit cramped)
    }
  }
  if (currentPage.sets.length > 0) {
    pages.push(currentPage);
  }
  // Make sure footer is on the last page
  if (pages.length > 0) {
    pages[pages.length - 1].includeFooter = true;
  }

  return (
    <>
      {pages.map((page, pageIdx) => (
        <div
          key={pageIdx}
          className="flex flex-col bg-white shadow-xl"
          style={{
            width: '210mm',
            height: '297mm',
            padding: '4mm 5mm 4mm 5mm',
            fontFamily: 'Arial, Helvetica, sans-serif',
            boxSizing: 'border-box',
            pageBreakAfter: pageIdx < pages.length - 1 ? 'always' : undefined,
          }}
        >
          {page.includeHeader && (
            <>
              <div className="text-center font-bold text-[14px] tracking-wide py-1 border border-black mb-1 bg-gray-100">
                LIBERO CONTROL SHEET
              </div>
              <div className="mb-1" style={{ transform: 'scale(0.52)', transformOrigin: 'top left', width: '192.3%' }}>
                <Header
                  match={match}
                  homeTeam={homeTeam}
                  awayTeam={awayTeam}
                  teamAName={teamAName}
                  teamBName={teamBName}
                  coinTossConfirmed={coinTossConfirmed}
                />
              </div>
            </>
          )}
          {!page.includeHeader && (
            <div className="text-center font-bold text-[10px] tracking-wide py-1 border border-black mb-1 bg-gray-100">
              LIBERO CONTROL SHEET (continued)
            </div>
          )}
          <div className="border border-black flex-1 flex flex-col">
            {page.sets.map(setNum => {
              const idx = setNum - 1;
              if (setNum === 5) {
                return (
                  <Set5Section
                    key={5}
                    teamALiberos={lcsData.teamALiberos}
                    teamBLiberos={lcsData.teamBLiberos}
                    teamAReps={set5Data?.teamAReplacements || []}
                    teamBReps={set5Data?.teamBReplacements || []}
                    teamAReps_After={set5Data?.teamAReplacements_After || []}
                    teamBReps_After={set5Data?.teamBReplacements_After || []}
                    rowsPerColumn={set5RowCount}
                  />
                );
              }
              const sd = lcsData.sets.find(s => s.setNumber === setNum);
              return (
                <SetSection
                  key={setNum}
                  setNumber={setNum}
                  teamALiberos={lcsData.teamALiberos}
                  teamBLiberos={lcsData.teamBLiberos}
                  teamAReps={sd?.teamAReplacements || []}
                  teamBReps={sd?.teamBReplacements || []}
                  rowsPerColumn={setRowCounts[idx]}
                />
              );
            })}
          </div>
          {page.includeFooter && (
            <Footer redesignationA={redesignationA} redesignationB={redesignationB} />
          )}
        </div>
      ))}
    </>
  );
};
