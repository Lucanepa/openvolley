/**
 * One set of the sheet as it is drawn, from the match's events (pure): starting
 * line-ups, ticked and circled points, service rounds, time-outs and
 * substitutions per column, the deciding set's split at the change of courts,
 * and the set's actual start and end. Moved out of App_Scoresheet (review
 * 2026-11-16, F2/F8) so it runs once per data change and is tested on its own.
 *
 * isSwapped: Team B on the left (sets 2 and 4; the deciding set when its toss
 * put B on the left).
 */
import { formatTimeLocal } from '../../src/utils/timeUtils';
import { awardsPoint as sanctionAwardsPoint, penaltyOfPoint } from '../../src/domain/sanctions.js';
import { assignSubsToColumns, compareEventsBySeq, getFirstServeTeamKey, getStartingLineup, rectificationServerColumn } from './scoresheetModel';
import { courtChangeIndex, trackServiceRounds, type ServiceRound, type TrackedRound } from './serviceRounds';
import { isoOf, setEndMs, setStartMs } from './matchTimes';
import type { SubRecord } from '../types_scoresheet';

export type TeamKey = 'home' | 'away';

/** What every set of one match shares. */
export interface SetContext {
  match: any;
  sets: any[];
  teamAKey: TeamKey;
  teamBKey: TeamKey;
  /** The deciding set's change of courts (8 of 15, or the match's own target). */
  set5SwitchAt: number;
  /** One set's events, in the match's event order (grouped once per match). */
  eventsOfSet: (setIndex: number) => any[];
}

/** Events grouped by set once, each group in the order given (matchData sorts them by seq). */
export function eventsBySet(events: any[]): (setIndex: number) => any[] {
  const groups = new Map<number, any[]>();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e) continue;
    const list = groups.get(e.setIndex);
    if (list) list.push(e);
    else groups.set(e.setIndex, [e]);
  }
  return (setIndex: number) => groups.get(setIndex) || [];
}

export interface SetData {
  startTime: string;
  endTime: string;
  setFinished: boolean;
  leftLineup: string[];
  rightLineup: string[];
  leftPoints: number;
  rightPoints: number;
  leftMarkedPoints: number[];
  rightMarkedPoints: number[];
  leftCircledPoints: number[];
  rightCircledPoints: number[];
  leftServiceRounds: ServiceRound[];
  rightServiceRounds: ServiceRound[];
  leftTimeouts: [string, string];
  leftTimeouts_After?: [string, string];
  rightTimeouts: [string, string];
  leftSubs: SubRecord[][];
  leftSubs_After?: SubRecord[][];
  rightSubs: SubRecord[][];
  leftScoreAtCourtChange: number | null;
  rightScoreAtCourtChange: number | null;
  leftTrackedRounds: TrackedRound[];
  set5ChangeAt: number | null;
}

export function buildSetData(ctx: SetContext, setNumber: number, isSwapped: boolean = false): SetData {
  const { match, sets, teamAKey, teamBKey, set5SwitchAt } = ctx;
  const setInfo = sets.find(s => s?.index === setNumber);

  // Check if set has been played (has points or startTime)
  const hasBeenPlayed = setInfo && (setInfo.homePoints > 0 || setInfo.awayPoints > 0 || setInfo.startTime);

  // Only calculate points if set has been played
  let leftPoints = 0;
  let rightPoints = 0;

  if (hasBeenPlayed) {
    leftPoints = !isSwapped
      ? (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
      : (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));

    rightPoints = !isSwapped
      ? (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
      : (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));
  }

  // Get starting lineup from events
  // Scoreboard writes a lineup event on every rotation, substitution and libero swap,
  // so the starting lineup is the last entered lineup (initial or FIVB 7.3.4 rectification)
  // before the set's first point, not the latest lineup event.
  const setEvents = ctx.eventsOfSet(setNumber);

  // Extract lineup arrays (positions I-VI)
  const homeLineupArray = getStartingLineup(setEvents, setNumber, 'home');
  const awayLineupArray = getStartingLineup(setEvents, setNumber, 'away');

  // Determine left and right lineups based on team assignments and swapping
  const leftLineup = !isSwapped
    ? (teamAKey === 'home' ? homeLineupArray : awayLineupArray)
    : (teamBKey === 'home' ? homeLineupArray : awayLineupArray);

  const rightLineup = !isSwapped
    ? (teamBKey === 'home' ? homeLineupArray : awayLineupArray)
    : (teamAKey === 'home' ? homeLineupArray : awayLineupArray);

  // Get point-by-point scoring sequence
  const pointEvents = setEvents
    .filter(e => e.type === 'point')
    .sort(compareEventsBySeq);

  // Track points for each team as they accumulate
  const homeMarkedPoints: number[] = [];
  const awayMarkedPoints: number[] = [];
  const homeCircledPoints: number[] = []; // Points scored due to sanctions
  const awayCircledPoints: number[] = []; // Points scored due to sanctions
  let homeScore = 0;
  let awayScore = 0;

  // Determine first serve team for this set
  // Set 1: coinTossServeA determines if A or B serves
  // Set 2, 4: The opposite team from set 1 serves
  // Set 3: Same as set 1
  // Set 5: Uses set5FirstServe if available (else the set 1 server)
  // Shared with the set-5 service tracker and S/R cross so all three agree
  const firstServeTeam: 'home' | 'away' = getFirstServeTeamKey(setNumber, match, teamAKey, teamBKey);

  // Ticked points: each team's running total after each of its points
  pointEvents.forEach((event) => {
    const scoringTeam = event.payload?.team;
    if (scoringTeam === 'home') {
      homeScore++;
      homeMarkedPoints.push(homeScore);
    } else if (scoringTeam === 'away') {
      awayScore++;
      awayMarkedPoints.push(awayScore);
    }
  });

  // Which team is left and right in this set's grid
  const leftTeamKey: 'home' | 'away' = !isSwapped ? teamAKey : teamBKey;
  const rightTeamKey: 'home' | 'away' = !isSwapped ? teamBKey : teamAKey;

  // Service rounds: one pure tracker for every set (utils/serviceRounds.ts).
  // When the game went back (domain/rectify): a cancelled point is still a
  // rally (it passed the serve, it scores nothing), a point set by hand
  // scores but passes no serve, and the going back gives the serve to the
  // team it names without a rotation, as the court: its player at position
  // I serves (a "Serves next" changed by hand ended A's column II and
  // opened III, while the court kept #8 serving)
  const rallyEvents = setEvents
    .filter(e => e.type === 'point' || e.type === 'cancelled_point' || (e.type === 'rectification' && (e.payload?.serve === 'home' || e.payload?.serve === 'away')))
    .sort(compareEventsBySeq);
  const rallyTeams = rallyEvents.map(e => (e.type === 'rectification' ? e.payload?.serve : e.payload?.team));
  const rallyCounted = rallyEvents.map(e => e.type === 'point');
  const rallyPasses = rallyEvents.map(e => !(e.type === 'point' && e.payload?.scoreAdjusted === true));
  const rallyServed = rallyEvents.map(e => (e.type === 'rectification'
    ? rectificationServerColumn(setEvents, e, e.payload?.serve === 'home' ? homeLineupArray : awayLineupArray)
    : undefined));
  const trackedRounds = trackServiceRounds({
    pointTeams: rallyTeams,
    counted: rallyCounted,
    passes: rallyPasses,
    served: rallyServed,
    firstServer: firstServeTeam,
    finished: !!setInfo?.finished
  });
  const leftServiceRounds: ServiceRound[] = trackedRounds[leftTeamKey];
  const rightServiceRounds: ServiceRound[] = trackedRounds[rightTeamKey];
  // Set 5: index of the point after which a team reached the change of courts
  const set5ChangeAt = setNumber === 5
    ? courtChangeIndex(rallyTeams, set5SwitchAt, rallyCounted)
    : null;

  // Identify points scored due to sanctions
  // Get all events (including sanctions) sorted chronologically
  const compareSeqTs = compareEventsBySeq;
  const allEventsWithSanctions = setEvents
    .filter(e => e.type === 'point' || e.type === 'sanction')
    .sort(compareSeqTs);

  // Track which points should be circled due to sanctions
  // For each sanction that awards a point (penalty, expulsion, disqualification, delay_penalty),
  // find the next point scored by the opponent and mark it for circling
  let homePointCount = 0;
  let awayPointCount = 0;

  for (let i = 0; i < allEventsWithSanctions.length; i++) {
    const event = allEventsWithSanctions[i];

    if (event.type === 'point') {
      // Track point counts
      if (event.payload?.team === 'home') {
        homePointCount++;
      } else if (event.payload?.team === 'away') {
        awayPointCount++;
      }
    } else if (event.type === 'sanction') {
      const payload = event.payload || {};
      const sanctionType = payload.type;
      const sanctionedTeam = payload.team; // 'home' or 'away'
      const opponentTeam = sanctionedTeam === 'home' ? 'away' : 'home';

      // Penalty and delay penalty give the opponent a point (domain/sanctions.awardsPoint);
      // warnings, expulsions and disqualifications do not
      // The point written for the penalty carries its seq (penaltySeq,
      // domain/sanctions penaltyOfPoint): that point is circled, wherever
      // it is; none when a going back cancelled it (domain/rectify)
      const linked = sanctionAwardsPoint(sanctionType)
        ? setEvents.find(x => (x.type === 'point' || x.type === 'cancelled_point') &&
          x.payload?.penaltySeq != null && x.payload.penaltySeq === event.seq && x.payload?.team === opponentTeam)
        : undefined;
      if (linked) {
        if (linked.type === 'point') {
          const n = allEventsWithSanctions.filter(x => x.type === 'point' && x.payload?.team === opponentTeam &&
            (x === linked || compareSeqTs(x, linked) < 0)).length;
          const circled = opponentTeam === 'home' ? homeCircledPoints : awayCircledPoints;
          if (!circled.includes(n)) circled.push(n);
        }
      } else if (sanctionAwardsPoint(sanctionType)) {
        // Find the next point event scored by the opponent after this sanction
        // We need to calculate what the score will be when that point is scored.
        // Not another penalty's point (it names its own sanction and is
        // circled for it): the same rule as the corrections
        // (domain/sanctions pointOfPenalty, audit LOG-05)
        let futureHomeCount = homePointCount;
        let futureAwayCount = awayPointCount;

        for (let j = i + 1; j < allEventsWithSanctions.length; j++) {
          const nextEvent = allEventsWithSanctions[j];
          if (nextEvent.type === 'point') {
            const ownPenaltyPoint = !!penaltyOfPoint(setEvents, nextEvent);
            if (nextEvent.payload?.team === 'home') {
              futureHomeCount++;
              if (opponentTeam === 'home' && !ownPenaltyPoint) {
                // This is the point we're looking for - circle it
                if (!homeCircledPoints.includes(futureHomeCount)) {
                  homeCircledPoints.push(futureHomeCount);
                }
                break;
              }
            } else if (nextEvent.payload?.team === 'away') {
              futureAwayCount++;
              if (opponentTeam === 'away' && !ownPenaltyPoint) {
                // This is the point we're looking for - circle it
                if (!awayCircledPoints.includes(futureAwayCount)) {
                  awayCircledPoints.push(futureAwayCount);
                }
                break;
              }
            }
          }
        }
      }
    }
  }

  // Points awarded to the opponent of a team that defaulted or was incomplete
  // (Scoreboard.handleForfait, payload.forfeitAwarded): not won in a rally, so
  // circled like a penalty point (field-spec 11, OV decision). The point and
  // service the game going back gives the opponent (domain/rectify,
  // payload.penaltyPoint; FIVB 15.9.2.1, 7.7.1.1) is circled the same way
  // (owner 2026-11-09)
  {
    let h = 0;
    let a = 0;
    for (const e of pointEvents) {
      const team = e.payload?.team;
      if (team === 'home') h++;
      else if (team === 'away') a++;
      else continue;
      if (e.payload?.forfeitAwarded === true || e.payload?.penaltyPoint === true) {
        const list = team === 'home' ? homeCircledPoints : awayCircledPoints;
        const n = team === 'home' ? h : a;
        if (!list.includes(n)) list.push(n);
      }
    }
  }

  // Determine which team's points go left and right based on team assignments and swapping
  const leftMarkedPoints = !isSwapped
    ? (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
    : (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints);

  const rightMarkedPoints = !isSwapped
    ? (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
    : (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints);

  // Determine which team's circled points go left and right
  const leftCircledPoints = !isSwapped
    ? (teamAKey === 'home' ? homeCircledPoints : awayCircledPoints)
    : (teamBKey === 'home' ? homeCircledPoints : awayCircledPoints);

  const rightCircledPoints = !isSwapped
    ? (teamBKey === 'home' ? homeCircledPoints : awayCircledPoints)
    : (teamAKey === 'home' ? homeCircledPoints : awayCircledPoints);

  // Process timeouts and substitutions with scores
  // Get all events sorted chronologically
  const allEvents = setEvents
    .filter(e => e.type === 'point' || e.type === 'timeout' || e.type === 'substitution' || e.type === 'lineup')
    .sort(compareEventsBySeq);

  // Track scores as we process events
  let currentHomeScore = 0;
  let currentAwayScore = 0;

  // For Set 5, track when court change happens (when any team reaches set5SwitchAt points)
  const isSet5 = setNumber === 5;
  let courtChangeHappened = false;
  let leftScoreAtCourtChange = 0; // Track left team's score at the moment of court change
  let rightScoreAtCourtChange = 0; // Track right team's score at the moment of court change

  // Track timeouts
  // For Set 5, split left team timeouts into before/after court change
  const leftTimeoutsList: string[] = [];
  const leftTimeoutsList_Before: string[] = [];
  const leftTimeoutsList_After: string[] = [];
  const rightTimeoutsList: string[] = [];

  // Track substitutions by position (I-VI = 0-5)
  // Each position has an array of substitution records
  // Using inline type to match SubRecord from types_scoresheet.ts
  type SubRecordLocal = {
    playerOut: number;
    playerIn: number;
    score: string; // Format "substitutingTeam:otherTeam"
    isCircled: boolean; // True if playerOut should be circled (can't reenter)
  };

  // Organize substitutions by player number (playerOut), not by rotation position
  // Map: playerOut number -> array of substitutions for that player
  // For Set 5, split left team substitutions into before/after court change
  const leftSubsByPlayer: Map<number, SubRecordLocal[]> = new Map();
  const leftSubsByPlayer_Before: Map<number, SubRecordLocal[]> = new Map();
  const leftSubsByPlayer_After: Map<number, SubRecordLocal[]> = new Map();
  const rightSubsByPlayer: Map<number, SubRecordLocal[]> = new Map();

  // Track current lineup to know which position a player is in
  let currentLeftLineup = [...leftLineup];
  let currentRightLineup = [...rightLineup];

  // Process all events chronologically
  allEvents.forEach((event) => {
    if (event.type === 'point') {
      const scoringTeam = event.payload?.team as 'home' | 'away';
      if (scoringTeam === 'home') {
        currentHomeScore++;
      } else {
        currentAwayScore++;
      }

      // Check if court change has happened (Set 5: when any team reaches set5SwitchAt points)
      if (isSet5 && !courtChangeHappened && (currentHomeScore >= set5SwitchAt || currentAwayScore >= set5SwitchAt)) {
        courtChangeHappened = true;
        // Store scores at the moment of court change
        leftScoreAtCourtChange = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
        rightScoreAtCourtChange = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
      }
    } else if (event.type === 'timeout') {
      const timeoutTeam = event.payload?.team as 'home' | 'away';
      const isLeftTeam = timeoutTeam === leftTeamKey;
      const isRightTeam = timeoutTeam === rightTeamKey;

      if (isLeftTeam) {
        // Format: "leftScore:rightScore" (team requesting timeout first)
        const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
        const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
        const timeoutStr = `${leftScore}:${rightScore}`;

        if (isSet5) {
          // For Set 5, split by court change
          // Panel 1: timeouts BEFORE court change happened
          // Panel 3: timeouts AFTER court change happened
          // Use the courtChangeHappened flag, not leftScore comparison
          if (!courtChangeHappened) {
            leftTimeoutsList_Before.push(timeoutStr);
          } else {
            leftTimeoutsList_After.push(timeoutStr);
          }
        } else {
          leftTimeoutsList.push(timeoutStr);
        }
      } else if (isRightTeam) {
        // Format: "rightScore:leftScore" (team requesting timeout first)
        const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
        const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
        rightTimeoutsList.push(`${rightScore}:${leftScore}`);
      }
    } else if (event.type === 'substitution') {
      const subTeam = event.payload?.team as 'home' | 'away';
      // Ensure playerOut and playerIn are numbers
      const playerOut = Number(event.payload?.playerOut);
      const playerIn = Number(event.payload?.playerIn);
      const position = event.payload?.position as string; // 'I', 'II', 'III', 'IV', 'V', 'VI'
      const isExceptional = event.payload?.isExceptional || false;

      // Skip exceptional substitutions (handled in remarks)
      if (isExceptional) return;

      // Skip if playerOut or playerIn is invalid
      if (isNaN(playerOut) || isNaN(playerIn)) return;

      const positionIndex = ['I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(position);
      if (positionIndex === -1) return;

      const isLeftTeam = subTeam === leftTeamKey;
      const isRightTeam = subTeam === rightTeamKey;

      // Get scores (substituting team first, then other team)
      const subTeamScore = subTeam === 'home' ? currentHomeScore : currentAwayScore;
      const otherTeamScore = subTeam === 'home' ? currentAwayScore : currentHomeScore;
      const scoreStr = `${subTeamScore}:${otherTeamScore}`;

      if (isLeftTeam) {
        // Ensure playerOut and playerIn are numbers
        const playerOutNum = Number(playerOut);
        const playerInNum = Number(playerIn);

        // For Set 5, determine which Map to use based on court change
        // Substitution goes to Panel 3 (After) if court change has happened
        // Otherwise goes to Panel 1 (Before)
        const targetMap = isSet5
          ? (courtChangeHappened ? leftSubsByPlayer_After : leftSubsByPlayer_Before)
          : leftSubsByPlayer;

        // Check if this is a return substitution (playerIn was previously substituted out)
        // We need to find which original playerOut this return belongs to
        // For Set 5, search both before and after Maps
        let isReturn = false;
        let originalPlayerOut: number | null = null;
        let returnSubsArray: SubRecordLocal[] | null = null;

        // Search through substitution arrays to find where playerIn was the original playerOut
        const mapsToSearch = isSet5
          ? [leftSubsByPlayer_Before, leftSubsByPlayer_After]
          : [leftSubsByPlayer];

        for (const mapToSearch of mapsToSearch) {
          for (const [originalPlayerOutKey, subsArray] of mapToSearch.entries()) {
            // Check if playerIn matches the original playerOut (the key of this array)
            if (originalPlayerOutKey === playerInNum) {
              // This is a return - the player coming back in was the original playerOut
              isReturn = true;
              originalPlayerOut = originalPlayerOutKey;
              returnSubsArray = subsArray;
              break;
            }
          }
          if (isReturn) break;
        }

        if (isReturn && returnSubsArray && originalPlayerOut !== null) {
          // This is a return substitution - add it to the original player's substitution array
          // Find the original substitution where this player went out
          const originalSub = returnSubsArray.find(sub => sub.playerOut === originalPlayerOut && sub.playerIn === playerOutNum);

          // For Set 5: only circle the original sub if both original and return are in the same panel
          // If original was before court change but return is after, don't circle in the Before map
          // The circle will be shown in Panel 3 where both subs appear together
          const originalWasBefore = isSet5 && leftSubsByPlayer_Before.has(originalPlayerOut) &&
            leftSubsByPlayer_Before.get(originalPlayerOut)!.includes(originalSub!);
          const returnIsAfter = isSet5 && courtChangeHappened;
          const shouldCircleOriginal = !isSet5 || !(originalWasBefore && returnIsAfter);

          if (originalSub && shouldCircleOriginal) {
            // Circle the playerIn (the substitute who came in), not the playerOut
            originalSub.isCircled = true; // Circle the playerIn who can't re-enter
          }
          // Add return substitution (playerIn goes out, originalPlayerOut comes back in)
          // For Set 5: return sub goes to the correct map based on WHEN the return happens (not where original was)
          const returnTargetArray = isSet5
            ? (() => {
                const correctMap = courtChangeHappened ? leftSubsByPlayer_After : leftSubsByPlayer_Before;
                if (!correctMap.has(originalPlayerOut)) {
                  correctMap.set(originalPlayerOut, []);
                }
                return correctMap.get(originalPlayerOut)!;
              })()
            : returnSubsArray;
          returnTargetArray.push({
            playerOut: playerOutNum, // The player currently going out
            playerIn: originalPlayerOut, // The original player coming back in
            score: scoreStr,
            isCircled: false
          });
        } else {
          // New substitution - playerOut is going out, playerIn is coming in
          if (!targetMap.has(playerOutNum)) {
            targetMap.set(playerOutNum, []);
          }
          const subsArray = targetMap.get(playerOutNum)!;
          subsArray.push({
            playerOut: playerOutNum,
            playerIn: playerInNum,
            score: scoreStr,
            isCircled: false
          });
        }

        // Update current lineup
        currentLeftLineup[positionIndex] = String(playerIn);
      } else if (isRightTeam) {
        // Ensure playerOut and playerIn are numbers
        const playerOutNum = Number(playerOut);
        const playerInNum = Number(playerIn);

        // Check if this is a return substitution (playerIn was previously substituted out)
        // We need to find which original playerOut this return belongs to
        let isReturn = false;
        let originalPlayerOut: number | null = null;
        let returnSubsArray: SubRecordLocal[] | null = null;

        // Search through all substitution arrays to find where playerIn was the original playerOut
        for (const [originalPlayerOutKey, subsArray] of rightSubsByPlayer.entries()) {
          // Check if playerIn matches the original playerOut (the key of this array)
          if (originalPlayerOutKey === playerInNum) {
            // This is a return - the player coming back in was the original playerOut
            isReturn = true;
            originalPlayerOut = originalPlayerOutKey;
            returnSubsArray = subsArray;
            break;
          }
        }

        if (isReturn && returnSubsArray && originalPlayerOut !== null) {
          // This is a return substitution - add it to the original player's substitution array
          // Find the original substitution where this player went out
          const originalSub = returnSubsArray.find(sub => sub.playerOut === originalPlayerOut && sub.playerIn === playerOutNum);
          if (originalSub) {
            // Circle the playerIn (the substitute who came in), not the playerOut
            originalSub.isCircled = true; // Circle the playerIn who can't re-enter
          }
          // Add return substitution (playerIn goes out, originalPlayerOut comes back in)
          returnSubsArray.push({
            playerOut: playerOutNum, // The player currently going out
            playerIn: originalPlayerOut, // The original player coming back in
            score: scoreStr,
            isCircled: false
          });
        } else {
          // New substitution - playerOut is going out, playerIn is coming in
          if (!rightSubsByPlayer.has(playerOutNum)) {
            rightSubsByPlayer.set(playerOutNum, []);
          }
          const subsArray = rightSubsByPlayer.get(playerOutNum)!;
          subsArray.push({
            playerOut: playerOutNum,
            playerIn: playerInNum,
            score: scoreStr,
            isCircled: false
          });
        }

        // Update current lineup
        currentRightLineup[positionIndex] = String(playerIn);
      }
    } else if (event.type === 'lineup') {
      // Update current lineup when lineup changes
      const lineupTeam = event.payload?.team as 'home' | 'away';
      const lineupObj = event.payload?.lineup || {};
      const positions = ['I', 'II', 'III', 'IV', 'V', 'VI'];
      const lineupArray = positions.map(pos => lineupObj[pos] ? String(lineupObj[pos]) : '');

      if (lineupTeam === leftTeamKey) {
        currentLeftLineup = lineupArray;
      } else if (lineupTeam === rightTeamKey) {
        currentRightLineup = lineupArray;
      }
    }
  });

  // Format timeouts (max 2 per team)
  // For Set 5, split into before/after court change
  const leftTimeouts: [string, string] = isSet5
    ? [
      leftTimeoutsList_Before[0] || '',
      leftTimeoutsList_Before[1] || ''
    ]
    : [
      leftTimeoutsList[0] || '',
      leftTimeoutsList[1] || ''
    ];
  // For Panel 3, include ALL timeouts (before + after court change combined)
  const allLeftTimeouts = [...leftTimeoutsList_Before, ...leftTimeoutsList_After].filter(t => t);
  // Panel 3 is unused until the change of courts (field-spec 6): empty before it
  const leftTimeouts_After: [string, string] = isSet5 && courtChangeHappened
    ? [
      allLeftTimeouts[0] || '',
      allLeftTimeouts[1] || ''
    ]
    : ['', ''];
  const rightTimeouts: [string, string] = [
    rightTimeoutsList[0] || '',
    rightTimeoutsList[1] || ''
  ];

  // Helper function to convert Map to position-based array
  // leftLineup/rightLineup are the STARTING lineups, so open substitutions keep their column
  const convertSubsMapToArray = (subsMap: Map<number, SubRecordLocal[]>, lineup: string[]): SubRecordLocal[][] =>
    assignSubsToColumns(subsMap, lineup);

  // Convert Map back to position-based array based on initial lineup
  // For Set 5, split into before/after court change
  const leftSubs: SubRecordLocal[][] = isSet5
    ? convertSubsMapToArray(leftSubsByPlayer_Before, leftLineup)
    : convertSubsMapToArray(leftSubsByPlayer, leftLineup);
  // For Set 5 Panel 3, merge substitutions from Panel 1 (before) with substitutions after change
  const leftSubs_After: SubRecordLocal[][] = isSet5 && courtChangeHappened
    ? (() => {
      const beforeSubs = convertSubsMapToArray(leftSubsByPlayer_Before, leftLineup);
      const afterSubs = convertSubsMapToArray(leftSubsByPlayer_After, leftLineup);
      // Merge: for each position, combine before and after substitutions
      return beforeSubs.map((beforeSubsForPosition, positionIndex) => {
        const afterSubsForPosition = afterSubs[positionIndex];
        // Deep copy before subs so we can modify isCircled without affecting Panel 1
        const mergedBefore = beforeSubsForPosition.map(sub => ({ ...sub }));
        // If there's a return sub in afterSubs, mark the corresponding before sub as circled
        for (const afterSub of afterSubsForPosition) {
          // A return sub has playerIn matching the original playerOut from before
          const originalSub = mergedBefore.find(
            bs => bs.playerOut === afterSub.playerIn && bs.playerIn === afterSub.playerOut
          );
          if (originalSub) {
            originalSub.isCircled = true;
          }
        }
        return [...mergedBefore, ...afterSubsForPosition];
      });
    })()
    : [[], [], [], [], [], []];
  const rightSubs: SubRecordLocal[][] = convertSubsMapToArray(rightSubsByPlayer, rightLineup);

  // The set's ACTUAL start: its first rally (utils/matchTimes, owner 2026-10-07),
  // never the schedule; the same value the RESULT table and MatchEnd use
  const actualStart = hasBeenPlayed ? setStartMs(setInfo, setEvents) : null;
  const startTimeStr = actualStart !== null ? formatTimeLocal(isoOf(actualStart)) : '';
  const actualEnd = hasBeenPlayed && setInfo?.endTime ? setEndMs(setInfo, setEvents) : null;

  return {
    startTime: startTimeStr,
    endTime: actualEnd !== null ? formatTimeLocal(isoOf(actualEnd)) : '',
    setFinished: setInfo?.finished || false,
    leftLineup,
    rightLineup,
    leftPoints,
    rightPoints,
    leftMarkedPoints,
    rightMarkedPoints,
    leftCircledPoints,
    rightCircledPoints,
    leftServiceRounds,
    rightServiceRounds,
    leftTimeouts,
    leftTimeouts_After: isSet5 ? leftTimeouts_After : undefined,
    rightTimeouts,
    leftSubs,
    leftSubs_After: isSet5 ? leftSubs_After : undefined,
    rightSubs,
    // null until a team reached 8 (no change of courts yet)
    leftScoreAtCourtChange: isSet5 && courtChangeHappened ? leftScoreAtCourtChange : null,
    rightScoreAtCourtChange: isSet5 && courtChangeHappened ? rightScoreAtCourtChange : null,
    leftTrackedRounds: trackedRounds[leftTeamKey],
    set5ChangeAt
  };
}
