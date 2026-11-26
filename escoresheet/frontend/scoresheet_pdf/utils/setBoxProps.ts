/**
 * One set's box as the sheet draws it, from the sheet model (utils/sheetModel):
 * the props SheetPage hands to StandardSet (sets 1-4) or SetFive (the deciding
 * set), to the legend beside it and the number in its SET column. SetPreview
 * draws a single set with these. SheetPage keeps its own wiring (the printed
 * sheet is untouched); __tests__/SetPreview.test.tsx checks every box of the
 * preview against the same box on the full sheet, so the preview is what prints.
 */
import type { SheetModel } from './sheetModel';

export type StandardSetNumber = 1 | 2 | 3 | 4;

const EMPTY_LINEUP = ['', '', '', '', '', ''];
const EMPTY_SUBS = [[], [], [], [], [], []];

/** The set's grid data (SheetModel set1Data ... set4Data). */
function setDataOf(model: SheetModel, setNumber: StandardSetNumber) {
  return setNumber === 1 ? model.set1Data : setNumber === 2 ? model.set2Data : setNumber === 3 ? model.set3Data : model.set4Data;
}

function shownOf(model: SheetModel, setNumber: StandardSetNumber): boolean {
  return setNumber === 1 ? model.shouldShowSet1 : setNumber === 2 ? model.shouldShowSet2 : setNumber === 3 ? model.shouldShowSet3 : model.shouldShowSet4;
}

/** StandardSet's props for set 1-4, as SheetPage passes them. */
export function standardSetProps(model: SheetModel, setNumber: StandardSetNumber) {
  const { teamAName, teamBName, set1ServeIsA, emptyGrid, emptySetData } = model;
  const named = shownOf(model, setNumber) && !emptyGrid[setNumber];
  // sets 2 and 4: the teams changed courts, team B on the left
  const swapped = setNumber === 2 || setNumber === 4;
  // set 4 is filled only once both teams won a set (shouldShowSet4); the others unless empty
  const filled = setNumber === 4 ? named : !emptyGrid[setNumber];
  return {
    ...(filled ? setDataOf(model, setNumber) : emptySetData),
    setNumber,
    isSwapped: swapped,
    teamNameLeft: named ? (swapped ? teamBName : teamAName) : '',
    teamNameRight: named ? (swapped ? teamAName : teamBName) : '',
    firstServeTeamA: named ? set1ServeIsA : undefined,
    unused: emptyGrid[setNumber]
  };
}

/** SetFive's props (the deciding set: index 5, printed as set 3 in a best-of-3), as SheetPage passes them. */
export function setFiveProps(model: SheetModel) {
  const {
    teamAName, teamBName, emptyGrid, set5SwitchAt,
    set5Data, set5Shown, set5LeftTeamIsB, set5FirstServeTeamKey, set5TeamOnLeft, set5FinalScoreLeft, set5FinalScoreRight,
    markedPointsA_Left, markedPointsA_Right, markedPointsB, circledPointsA_Left, circledPointsA_Right, circledPointsB,
    set5ServiceRoundsLeftTeam_Before, set5ServiceRoundsLeftTeam_After, set5ServiceRoundsRightTeam
  } = model;
  const d = set5Shown ? set5Data : null;
  return {
    teamNameA: d ? (set5LeftTeamIsB ? teamBName : teamAName) : '',
    teamNameB: d ? (set5LeftTeamIsB ? teamAName : teamBName) : '',
    teamALabel: d ? (set5LeftTeamIsB ? 'B' : 'A') : '',
    teamBLabel: d ? (set5LeftTeamIsB ? 'A' : 'B') : '',
    // whether the team in panel 1 serves first
    firstServeTeamA: d ? set5FirstServeTeamKey === set5TeamOnLeft : undefined,
    startTime: d ? d.startTime : '',
    endTime: d ? d.endTime : '',
    setFinished: d ? d.setFinished : false,
    unused: emptyGrid[5],
    lineupA: d ? d.leftLineup : EMPTY_LINEUP,
    subsA: d ? d.leftSubs : EMPTY_SUBS,
    timeoutsA: d ? d.leftTimeouts : (['', ''] as [string, string]),
    subsA_Right: d ? d.leftSubs_After : EMPTY_SUBS,
    timeoutsA_Right: d ? d.leftTimeouts_After : (['', ''] as [string, string]),
    lineupB: d ? d.rightLineup : EMPTY_LINEUP,
    subsB: d ? d.rightSubs : EMPTY_SUBS,
    timeoutsB: d ? d.rightTimeouts : (['', ''] as [string, string]),
    finalScoreA: d ? set5FinalScoreLeft : 0,
    markedPointsA_Left: d ? markedPointsA_Left : [],
    circledPointsA_Left: d ? circledPointsA_Left : [],
    serviceRoundsA_Left: d ? set5ServiceRoundsLeftTeam_Before : [],
    pointsB: d ? set5FinalScoreRight : 0,
    markedPointsB: d ? markedPointsB : [],
    circledPointsB: d ? circledPointsB : [],
    serviceRoundsB: d ? set5ServiceRoundsRightTeam : [],
    markedPointsA_Right: d ? markedPointsA_Right : [],
    circledPointsA_Right: d ? circledPointsA_Right : [],
    serviceRoundsA_Right: d ? set5ServiceRoundsLeftTeam_After : [],
    pointsAtChangeA: d ? (d.leftScoreAtCourtChange ?? null) : null,
    switchAt: set5SwitchAt
  };
}

/** The legend box beside the set (LeftInfoBox): the set's own left team, the set-5 height for the deciding set. */
export function legendProps(model: SheetModel, setIndex: number) {
  if (setIndex === 5) {
    const d = model.set5Shown ? model.set5Data : null;
    return {
      lineup: d ? d.leftLineup : EMPTY_LINEUP,
      subs: d ? d.leftSubs : EMPTY_SUBS,
      serviceRounds: d ? model.set5ServiceRoundsLeftTeam_Before : [],
      isSet5: true
    };
  }
  const d = setDataOf(model, setIndex as StandardSetNumber);
  return { lineup: d.leftLineup, subs: d.leftSubs, serviceRounds: d.leftServiceRounds, isSet5: false };
}

/**
 * The number in the set's SET column: a best-of-3 prints its deciding set
 * (index 5) as 3 and leaves sets 3 and 4 blank, unless they were played (the
 * format was changed during the match).
 */
export function setColumnLabel(model: SheetModel, setIndex: number): string {
  const plainBestOf3 = model.isBestOf3 && !model.bestOf3ExtraSets;
  if (setIndex === 5) return plainBestOf3 ? '3' : '5';
  if (setIndex === 3 || setIndex === 4) return plainBestOf3 ? '' : String(setIndex);
  return String(setIndex);
}
