import React from 'react';
import { Header } from './Header';
import { StandardSet } from './StandardSet';
import { COURT_CHANGE_W, SetFive } from './SetFive';
import { Sanctions, Results, Approvals, Roster, Remarks } from './FooterSection';
import { LEGEND_WIDTH, LeftInfoBox } from './LeftInfoBox';
import { asArray } from '../utils/sheetFormat';
import { BRAND } from '../../src/brand.js';
import type { SheetModel } from '../utils/sheetModel';

// The space between the boxes below set 5 and between the rosters (owner
// 2026-10-13: separate boxes, each with its own border)
const FOOTER_GAP = '1mm';

/**
 * The drawn page inside .scoresheet-container, from the sheet model only.
 * Memoised: App_Scoresheet's zoom, turn, notices and PDF-busy state do not
 * re-render it; a new model (a data change) does (review 2026-11-16, F2).
 */
export const SheetPage = React.memo(function SheetPage({ model, readOnly, onRemarksClipped }: {
  model: SheetModel;
  readOnly: boolean;
  onRemarksClipped: (clipped: boolean) => void;
}) {
  const {
    match, sets, officials, teamAKey, coinTossConfirmed, bestOf, isBestOf3, bestOf3ExtraSets,
    sheetHomeTeam, sheetAwayTeam, teamAName, teamBName, homeShortName, awayShortName, teamAShortName, teamBShortName,
    set1ServeIsA, set5SwitchAt,
    set1Data, set2Data, set3Data, set4Data, emptySetData, emptyGrid,
    shouldShowSet1, shouldShowSet2, shouldShowSet3, shouldShowSet4,
    set5Data, set5Shown, set5LeftTeamIsB, set5FirstServeTeamKey, set5TeamOnLeft, set5FinalScoreLeft, set5FinalScoreRight,
    markedPointsA_Left, markedPointsA_Right, markedPointsB, circledPointsA_Left, circledPointsA_Right, circledPointsB,
    set5ServiceRoundsLeftTeam_Before, set5ServiceRoundsLeftTeam_After, set5ServiceRoundsRightTeam,
    autoRemarks, remarks, remarksSignatures, sanctionsInBox, overflowSanctions, improperRequests,
    setResults, matchStart, matchEndFinal, matchDuration, winner, result,
    homeRows, awayRows, homeLiberos, awayLiberos, lineJudges, idHeading
  } = model;
  return (
    <div className="h-full" style={{ padding: '4mm 7mm 6mm 5mm' }}>
      <div>
        <Header
          match={match}
          homeTeam={sheetHomeTeam}
          awayTeam={sheetAwayTeam}
          teamAName={teamAName}
          teamBName={teamBName}
          coinTossConfirmed={coinTossConfirmed}
        />
      </div>
      <div className="w-full h-[5px] bg-white" />
      {/* Row 1: Sets 1 and 2 - Full Width 50/50 */}
      <div className="flex">
        <LeftInfoBox
          lineup={set1Data.leftLineup}
          subs={set1Data.leftSubs}
          serviceRounds={set1Data.leftServiceRounds}
          isSet5={false}
        />
        <div className="flex gap-4">
          <div className="flex flex-1">
            <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
              <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                <span>S</span>
                <span>E</span>
                <span>T</span>
              </div>
              <div className="font-black text-sm mt-1">1</div>
            </div>
            <div className="flex-1">
              <StandardSet
                setNumber={1}
                teamNameLeft={shouldShowSet1 && !emptyGrid[1] ? teamAShortName : ''}
                teamNameRight={shouldShowSet1 && !emptyGrid[1] ? teamBShortName : ''}
                firstServeTeamA={shouldShowSet1 && !emptyGrid[1] ? set1ServeIsA : undefined}
                {...(emptyGrid[1] ? emptySetData : set1Data)}
                unused={emptyGrid[1]}
              />
            </div>
          </div>
          <div className="flex flex-1">
            <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
              <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                <span>S</span>
                <span>E</span>
                <span>T</span>
              </div>
              <div className="font-black text-sm mt-1">2</div>
            </div>
            <div className="flex-1">
              <StandardSet
                setNumber={2}
                isSwapped={true}
                teamNameLeft={shouldShowSet2 && !emptyGrid[2] ? teamBShortName : ''}
                teamNameRight={shouldShowSet2 && !emptyGrid[2] ? teamAShortName : ''}
                firstServeTeamA={shouldShowSet2 && !emptyGrid[2] ? set1ServeIsA : undefined}
                {...(emptyGrid[2] ? emptySetData : set2Data)}
                unused={emptyGrid[2]}
              />
            </div>
          </div>
          {/* Side banner: the product name as plain text (the logo is only at the top left) */}
          <div
            className="flex items-center justify-center border border-black bg-gray-300 shrink-0"
            style={{
              // as tall as the set boxes: a taller banner stretched the SET columns
              // below the grids (audit 2026-10); 93px keeps the row inside the sheet
              // now that the set boxes are 150 mm inside their borders
              width: '93px',
              height: 'calc(5.3cm + 2px)',
              fontSize: '17px',
              writingMode: 'vertical-lr',
              transform: 'rotate(180deg)',
              textAlign: 'center',
              whiteSpace: 'nowrap'
            }}
            data-testid="side-banner"
          >
            OpenVolley eScoresheet
          </div>
        </div>
      </div>

      {/* Row 2: Sets 3 and 4 - Full Width 50/50 */}
      <div className="flex mt-1">
        <LeftInfoBox
          lineup={set3Data.leftLineup}
          subs={set3Data.leftSubs}
          serviceRounds={set3Data.leftServiceRounds}
          isSet5={false}
        />
        <div className="flex gap-4 flex">
          <div className="flex flex-1">
            <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
              <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                <span>S</span>
                <span>E</span>
                <span>T</span>
              </div>
              <div className="font-black text-sm mt-1">{isBestOf3 && !bestOf3ExtraSets ? '' : '3'}</div>
            </div>
            <div className="flex-1">
              <StandardSet
                setNumber={3}
                teamNameLeft={shouldShowSet3 && !emptyGrid[3] ? teamAShortName : ''}
                teamNameRight={shouldShowSet3 && !emptyGrid[3] ? teamBShortName : ''}
                firstServeTeamA={shouldShowSet3 && !emptyGrid[3] ? set1ServeIsA : undefined}
                {...(emptyGrid[3] ? emptySetData : set3Data)}
                unused={emptyGrid[3]}
              />
            </div>
          </div>
          <div className="flex flex-1">
            <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
              <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                <span>S</span>
                <span>E</span>
                <span>T</span>
              </div>
              <div className="font-black text-sm mt-1">{isBestOf3 && !bestOf3ExtraSets ? '' : '4'}</div>
            </div>
            <div className="flex-1">
              <StandardSet
                setNumber={4}
                isSwapped={true}
                teamNameLeft={shouldShowSet4 && !emptyGrid[4] ? teamBShortName : ''}
                teamNameRight={shouldShowSet4 && !emptyGrid[4] ? teamAShortName : ''}
                firstServeTeamA={shouldShowSet4 && !emptyGrid[4] ? set1ServeIsA : undefined}
                {...(shouldShowSet4 && !emptyGrid[4] ? set4Data : emptySetData)}
                unused={emptyGrid[4]}
              />
            </div>
          </div>
          <div
            className="flex items-center justify-center text-xl shrink-0"
            style={{
              width: '93px',
              writingMode: 'vertical-lr',
              textAlign: 'center',
              whiteSpace: 'nowrap'
            }}
          >
            {/* The flat ball A (brand/ball.svg), bundled with a content-hashed URL:
                never a cached old /ball.png */}
            <img
              src={BRAND.ballPng}
              alt=""
              data-testid="sheet-ball"
              style={{
                width: '93px',
                height: '93px',
                objectFit: 'contain',
                margin: '0 auto',
                display: 'block'
              }}
            />
          </div>
        </div>
      </div>

      {/* Rows 3-4: Set 5 + Footer sections on left, Rosters spanning on right */}
      {/* Rows 3-4 sit on the grid of the sets above (owner 2026-10-13: lines
          aligned up and down): the left side ends on set 4's line between its
          teams (legend + 8px + SET column + set-5 box). The rosters stand apart
          from it and from each other (owner: "detach ... the roster also"),
          roster A ending on set 4's V|VI line; every box ends on one bottom
          line (the rosters take the left side's height). */}
      <div className="flex mt-1 items-stretch print:flex-1 print:min-h-0">
        {/* Left side: Set 5 + Footer sections stacked */}
        <div className="flex flex-col gap-2 min-h-0 shrink-0" style={{ width: `calc(${LEGEND_WIDTH} + 87px + 225mm)` }} data-testid="sheet-lower-left">
          {/* Set 5 */}
          <div className="flex">
            <div>
              <LeftInfoBox
                lineup={set5Shown ? set5Data!.leftLineup : ['', '', '', '', '', '']}
                subs={set5Shown ? set5Data!.leftSubs : [[], [], [], [], [], []]}
                serviceRounds={set5Shown ? set5ServiceRoundsLeftTeam_Before : []}
                isSet5={true}
              />
            </div>
            <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
              <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                <span>S</span>
                <span>E</span>
                <span>T</span>
              </div>
              <div className="font-black text-sm mt-1">{isBestOf3 && !bestOf3ExtraSets ? '3' : '5'}</div>
            </div>
            <div className="flex-1">
              <SetFive
                teamNameA={set5Shown ? (set5LeftTeamIsB ? teamBShortName : teamAShortName) : ''}
                teamNameB={set5Shown ? (set5LeftTeamIsB ? teamAShortName : teamBShortName) : ''}
                teamALabel={set5Shown ? (set5LeftTeamIsB ? "B" : "A") : ''}
                teamBLabel={set5Shown ? (set5LeftTeamIsB ? "A" : "B") : ''}
                firstServeTeamA={set5Shown
                  // SetFive expects firstServeTeamA to indicate if the team in Panel 1 serves
                  ? set5FirstServeTeamKey === set5TeamOnLeft
                  : undefined}
                startTime={set5Shown ? set5Data!.startTime : ''}
                endTime={set5Shown ? set5Data!.endTime : ''}
                setFinished={set5Shown ? set5Data!.setFinished : false}
                unused={emptyGrid[5]}
                lineupA={set5Shown ? set5Data!.leftLineup : ['', '', '', '', '', '']}
                subsA={set5Shown ? set5Data!.leftSubs : [[], [], [], [], [], []]}
                timeoutsA={set5Shown ? set5Data!.leftTimeouts : ['', '']}
                subsA_Right={set5Shown ? set5Data!.leftSubs_After : [[], [], [], [], [], []]}
                timeoutsA_Right={set5Shown ? set5Data!.leftTimeouts_After : ['', '']}
                lineupB={set5Shown ? set5Data!.rightLineup : ['', '', '', '', '', '']}
                subsB={set5Shown ? set5Data!.rightSubs : [[], [], [], [], [], []]}
                timeoutsB={set5Shown ? set5Data!.rightTimeouts : ['', '']}
                finalScoreA={set5Shown ? set5FinalScoreLeft : 0}
                markedPointsA_Left={set5Shown ? markedPointsA_Left : []}
                circledPointsA_Left={set5Shown ? circledPointsA_Left : []}
                serviceRoundsA_Left={set5Shown ? set5ServiceRoundsLeftTeam_Before : []}
                pointsB={set5Shown ? set5FinalScoreRight : 0}
                markedPointsB={set5Shown ? markedPointsB : []}
                circledPointsB={set5Shown ? circledPointsB : []}
                serviceRoundsB={set5Shown ? set5ServiceRoundsRightTeam : []}
                markedPointsA_Right={set5Shown ? markedPointsA_Right : []}
                circledPointsA_Right={set5Shown ? circledPointsA_Right : []}
                serviceRoundsA_Right={set5Shown ? set5ServiceRoundsLeftTeam_After : []}
                pointsAtChangeA={set5Shown ? (set5Data!.leftScoreAtCourtChange ?? null) : null}
                switchAt={set5SwitchAt}
              />
            </div>
          </div>

          {/* Footer sections row - flex for horizontal control */}
          {/* Footer: SANCTIONS under the legend and SET column (its right rule on the
              set-5 box's left one), RESULT under the court change and panel 3
              (its rules on set 5's), REMARKS / APPROVAL a box of its own between
              them, FOOTER_GAP apart (owner 2026-10-13: "detach approval") */}
          <div className="flex shrink-0" style={{ height: '8.4cm', gap: FOOTER_GAP }}>
            <div className="flex-col shrink-0" style={{ height: '8.4cm', width: `calc(${LEGEND_WIDTH} + 39px)` }}>
              <Sanctions items={sanctionsInBox} improperRequests={improperRequests} />
            </div>

            {/* Remarks and Approvals stacked - takes remaining space */}
            <div className="flex flex-col gap-1 min-h-0 shrink-0" style={{ width: `calc(150mm - 2 * ${FOOTER_GAP})` }}>
              {/* Remarks - 30% height */}
              <div className="flex-[3] min-h-0">
                <Remarks overflowSanctions={overflowSanctions} remarks={remarks} generated={autoRemarks} onClipped={onRemarksClipped} signatures={remarksSignatures} />
              </div>
              {/* Approvals - 70% height */}
              <div className="flex-[5] min-h-0">
                <Approvals
                  officials={officials}
                  match={match}
                  sets={sets}
                  teamAKey={teamAKey}
                  lineJudges={lineJudges}
                />
              </div>
            </div>

            {/* Results - adjust flex-[x] to change width proportion */}
            <div className="flex flex-col shrink-0" style={{ height: '8.4cm', width: `calc(75mm + ${COURT_CHANGE_W})` }}>
              <Results
                flush
                teamAShortName={teamAShortName}
                teamBShortName={teamBShortName}
                setResults={setResults}
                matchStart={matchStart}
                matchEnd={matchEndFinal}
                matchDuration={matchDuration}
                winner={winner}
                result={result}
                coinTossConfirmed={coinTossConfirmed}
                bestOf={bestOf}
                blankResultUntilFinished
              />
            </div>
          </div>
        </div>

        {/* Right side: Rosters spanning full height - HOME always left, AWAY always right */}
        <div className="flex flex-1 min-w-0" style={{ marginLeft: FOOTER_GAP, gap: FOOTER_GAP }}>
          <div className="shrink-0 min-w-0" style={{ width: `calc(50mm - ${FOOTER_GAP})` }}>
            <Roster
              team={homeShortName}
              side={teamAKey === 'home' ? 'A' : 'B'}
              players={homeRows}
              liberos={homeLiberos}
              benchStaff={asArray(match?.bench_home)}
              preGameCaptainSignature={match?.homeCaptainSignature}
              preGameCoachSignature={match?.homeCoachSignature}
              coinTossConfirmed={coinTossConfirmed}
              isHome={true}
              readOnly={readOnly}
              idHeading={idHeading}
            />
          </div>
          <div className="flex-1 min-w-0">
            <Roster
              team={awayShortName}
              side={teamAKey === 'away' ? 'A' : 'B'}
              players={awayRows}
              liberos={awayLiberos}
              benchStaff={asArray(match?.bench_away)}
              preGameCaptainSignature={match?.awayCaptainSignature}
              preGameCoachSignature={match?.awayCoachSignature}
              coinTossConfirmed={coinTossConfirmed}
              isHome={false}
              readOnly={readOnly}
              idHeading={idHeading}
            />
          </div>
        </div>
      </div>

    </div>
  );
});
