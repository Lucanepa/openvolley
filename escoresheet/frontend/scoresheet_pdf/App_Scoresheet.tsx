import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Header } from './components/Header';
import { StandardSet } from './components/StandardSet';
import { SetFive } from './components/SetFive';
import { Sanctions, Results, Approvals, Roster, Remarks, SANCTION_ROWS } from './components/FooterSection';
import { LeftInfoBox } from './components/LeftInfoBox';
import { LiberoControlSheet } from './components/LiberoControlSheet';
import { Player, SanctionRecord } from './types_scoresheet';
import { asArray, buildScoresheetFilename, buildScoresheetTitle, displayShortName, findOfficial, formatDob, formatHoursMinutes, formatClockHoursMinutes, formatPersonName, normalizeOfficials } from './utils/sheetFormat';
import { formatTimeLocal } from '../src/utils/timeUtils';
import { extractLiberoData } from './utils/extractLiberoData';
import { allStyleProperties, drawableImages, drawImagesOnto, hideImages, isWebKitGtk, styleListFor, usedStyleProperties } from './utils/pdfCapture';
import {
  getStartingLineup,
  assignSubsToColumns,
  countRegularSubstitutions,
  countAllSubstitutions,
  displaySetNumber,
  getScoreBeforeEvent,
  getSet5LeftTeamLabel,
  getFirstServeTeamKey,
  consistencyWarnings
} from './utils/scoresheetModel';
import { trackServiceRounds, courtChangeIndex, splitSet5Rounds, type ServiceRound } from './utils/serviceRounds';
import { awardsPoint as sanctionAwardsPoint } from '../src/domain/sanctions.js';
import { generatedRemarks } from './utils/sheetRemarks';
import { isoOf, setDurationMinutes, setEndMs, setStartMs } from './utils/matchTimes';
import { BRAND } from '../src/brand.js';
import { PhoneIcon } from '../src/components/icons';
import { deliverPdfToOpener, getOpenerWindow, isOwnDownload, savePdfThroughApp } from '../src/utils/appWindowGuest';
import { detectAppPlatform } from '../src/utils/openAppWindow';
import { assertCanvas, assertJpegDataUrl, assertValidPdf, assertVisibleSheet, downloadBlob, PdfCheckError, SHEET_MM, SHEET_OFFSET_MM, type SaveOutcome } from './utils/pdfOutput';

interface AppScoresheetProps {
  matchData: {
    match: any;
    homeTeam: any;
    awayTeam: any;
    homePlayers: Player[];
    awayPlayers: Player[];
    sets: any[];
    events: any[];
    sanctions?: SanctionRecord[];
  };
  autoAction?: 'preview' | 'print' | 'save' | 'getBlob';
  /**
   * Every live query has answered (LiveScoresheet). The automatic save / getBlob
   * waits for it: the first render has the match but not yet its teams, players,
   * sets and events. Static data (storage, import) is ready at once.
   */
  dataReady?: boolean;
  /** ?matchId= named a match that is not on this device: show it, never save an empty sheet. */
  matchMissing?: boolean;
}

const App: React.FC<AppScoresheetProps> = ({ matchData, autoAction, dataReady = true, matchMissing = false }) => {
  const { t } = useTranslation();
  // Normalised once: a JSON import or an older row may miss lists or hold null
  const match: any = matchData?.match || {};
  const homeTeam: any = matchData?.homeTeam || null;
  const awayTeam: any = matchData?.awayTeam || null;
  const homePlayers = asArray(matchData?.homePlayers);
  const awayPlayers = asArray(matchData?.awayPlayers);
  const sets: any[] = asArray(matchData?.sets);
  const events: any[] = asArray(matchData?.events);
  // Officials: the array, the older role-keyed object or snake_case names (never throws)
  const officials = normalizeOfficials(match?.officials);

  // Players as the sheet prints them, sorted by shirt number (the roster's 14 rows;
  // field-spec 3). Robust to a missing list (an imported JSON without players).
  const formatPlayers = (players: unknown): Player[] => {
    return asArray<any>(players)
      .filter(p => p && typeof p === 'object')
      .map(p => ({
        number: String(p.number ?? ''),
        name: (p.lastName ?? p.last_name) || (p.firstName ?? p.first_name)
          ? formatPersonName(p.lastName ?? p.last_name, p.firstName ?? p.first_name)
          : String(p.name || ''),
        firstName: p.firstName ?? p.first_name,
        lastName: p.lastName ?? p.last_name,
        dob: formatDob(p.dob ?? p.date_of_birth),
        libero: p.libero,
        isCaptain: p.isCaptain || p.is_captain,
        isLfp: p.isLfp || p.is_lfp || false,
        license: p.license || '',
        role: p.role
      }))
      .sort((a, b) => {
        const na = parseInt(String(a.number), 10);
        const nb = parseInt(String(b.number), 10);
        if (Number.isNaN(na) && Number.isNaN(nb)) return 0;
        if (Number.isNaN(na)) return 1;
        if (Number.isNaN(nb)) return -1;
        return na - nb;
      });
  };

  // Determine team labels (A or B) based on coin toss
  const teamAKey: 'home' | 'away' = match?.coinTossTeamA === 'away' ? 'away' : 'home';
  const teamBKey: 'home' | 'away' = teamAKey === 'home' ? 'away' : 'home';

  // Calculate if coin toss is confirmed (all coin toss fields are set)
  // Also treat as confirmed if match is live/ended/final (coin toss must have been completed to reach these states)
  const coinTossFieldsSet = match?.coinTossTeamA !== null &&
    match?.coinTossTeamA !== undefined &&
    match?.coinTossTeamB !== null &&
    match?.coinTossTeamB !== undefined &&
    match?.coinTossServeA !== null &&
    match?.coinTossServeA !== undefined &&
    match?.coinTossServeB !== null &&
    match?.coinTossServeB !== undefined;
  const coinTossConfirmed = coinTossFieldsSet ||
    match?.status === 'live' || match?.status === 'ended' || match?.status === 'final';

  const teamAPlayers = formatPlayers(teamAKey === 'home' ? homePlayers : awayPlayers);
  const teamBPlayers = formatPlayers(teamBKey === 'home' ? homePlayers : awayPlayers);

  // Use full team names
  const teamAName = (teamAKey === 'home' ? homeTeam?.name : awayTeam?.name) || '';
  const teamBName = (teamBKey === 'home' ? homeTeam?.name : awayTeam?.name) || '';

  // Short names for the set boxes, the rosters and the result table: the stored
  // short name, else (empty or a HOME / AWAY placeholder) the team's full name
  const homeShortName = displayShortName(match?.homeShortName, homeTeam?.name ?? match?.homeTeamName);
  const awayShortName = displayShortName(match?.awayShortName, awayTeam?.name ?? match?.awayTeamName);
  const teamAShortName = teamAKey === 'home' ? homeShortName : awayShortName;
  const teamBShortName = teamBKey === 'home' ? homeShortName : awayShortName;

  // Who served first in set 1, as "is it Team A": coinTossServeA, else the legacy
  // match.firstServe (server-synced matches may store coinTossServeA = null).
  // The same rule as the service tracker (getFirstServeTeamKey), so the S/R
  // crosses and the X always agree with the service boxes (code-map D5).
  const set1ServeIsA: boolean | undefined =
    match?.coinTossServeA !== undefined && match?.coinTossServeA !== null
      ? !!match.coinTossServeA
      : match?.firstServe === 'home' || match?.firstServe === 'away'
        ? match.firstServe === teamAKey
        : undefined;

  // Compute Libero Control Sheet data from events
  const lcsData = useMemo(() => {
    return extractLiberoData(events || [], sets || [], teamAKey as 'home' | 'away', teamAPlayers, teamBPlayers);
  }, [events, sets, teamAKey, teamAPlayers, teamBPlayers]);

  // Check if LCS button should be visible: at least one team has a libero AND there is libero activity
  const hasLiberoActivity = useMemo(() => {
    const hasLiberos = lcsData.teamALiberos.length > 0 || lcsData.teamBLiberos.length > 0;
    if (!hasLiberos) return false;
    if (lcsData.redesignations.length > 0) return true;
    const hasReplacements = lcsData.sets.some(s =>
      s.teamAReplacements.length > 0 ||
      s.teamBReplacements.length > 0 ||
      (s.teamAReplacements_After && s.teamAReplacements_After.length > 0) ||
      (s.teamBReplacements_After && s.teamBReplacements_After.length > 0)
    );
    return hasReplacements;
  }, [lcsData]);

  // Toggle between scoresheet and LCS view
  const [showLCS, setShowLCS] = useState(false);

  // Helper function to get set data from events and sets
  const getSetData = (setNumber: number, isSwapped: boolean = false) => {
    const setInfo = sets?.find(s => s.index === setNumber);

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
    const setEvents = events?.filter(e => e.setIndex === setNumber) || [];

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
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq; // Sort by sequence
        return new Date(a.ts).getTime() - new Date(b.ts).getTime(); // Fallback to timestamp
      });

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

    // Service rounds: one pure tracker for every set (utils/serviceRounds.ts)
    const trackedRounds = trackServiceRounds({
      pointTeams: pointEvents.map(e => e.payload?.team),
      firstServer: firstServeTeam,
      finished: !!setInfo?.finished
    });
    const leftServiceRounds: ServiceRound[] = trackedRounds[leftTeamKey];
    const rightServiceRounds: ServiceRound[] = trackedRounds[rightTeamKey];
    // Set 5: index of the point after which a team reached 8 (change of courts)
    const set5ChangeAt = setNumber === 5
      ? courtChangeIndex(pointEvents.map(e => e.payload?.team))
      : null;

    // Identify points scored due to sanctions
    // Get all events (including sanctions) sorted chronologically
    const allEventsWithSanctions = setEvents
      .filter(e => e.type === 'point' || e.type === 'sanction')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });

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
        if (sanctionAwardsPoint(sanctionType)) {
          // Find the next point event scored by the opponent after this sanction
          // We need to calculate what the score will be when that point is scored
          let futureHomeCount = homePointCount;
          let futureAwayCount = awayPointCount;

          for (let j = i + 1; j < allEventsWithSanctions.length; j++) {
            const nextEvent = allEventsWithSanctions[j];
            if (nextEvent.type === 'point') {
              if (nextEvent.payload?.team === 'home') {
                futureHomeCount++;
                if (opponentTeam === 'home') {
                  // This is the point we're looking for - circle it
                  if (!homeCircledPoints.includes(futureHomeCount)) {
                    homeCircledPoints.push(futureHomeCount);
                  }
                  break;
                }
              } else if (nextEvent.payload?.team === 'away') {
                futureAwayCount++;
                if (opponentTeam === 'away') {
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
    // circled like a penalty point (field-spec 11, OV decision)
    {
      let h = 0;
      let a = 0;
      for (const e of pointEvents) {
        const team = e.payload?.team;
        if (team === 'home') h++;
        else if (team === 'away') a++;
        else continue;
        if (e.payload?.forfeitAwarded === true) {
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
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });

    // Track scores as we process events
    let currentHomeScore = 0;
    let currentAwayScore = 0;

    // For Set 5, track when court change happens (when any team reaches 8 points)
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

        // Check if court change has happened (Set 5: when any team reaches 8 points)
        if (isSet5 && !courtChangeHappened && (currentHomeScore >= 8 || currentAwayScore >= 8)) {
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

          // Get scores at time of substitution
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;

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

    // Calculate current server info for validation
    // Determine which team is currently serving
    let currentServeTeam: 'left' | 'right' | null = null;
    let currentServePosition = 0; // 0-5 for I-VI
    let currentServerNumber = '';

    if (hasBeenPlayed) {
      // Find the team with serve based on who scored the last point
      const lastPointEvent = pointEvents[pointEvents.length - 1];
      if (lastPointEvent) {
        const lastScoringTeam = lastPointEvent.payload?.team as 'home' | 'away';
        currentServeTeam = lastScoringTeam === leftTeamKey ? 'left' : 'right';
      } else {
        // No points yet - first serve team has serve
        currentServeTeam = firstServeTeam === leftTeamKey ? 'left' : 'right';
      }

      // Get current serving position from service rounds
      if (currentServeTeam === 'left' && leftServiceRounds.length > 0) {
        // Find the last service round entry for the left team that has no points (still serving)
        const currentRound = leftServiceRounds.filter(sr => sr.points === null).pop() ||
          leftServiceRounds[leftServiceRounds.length - 1];
        currentServePosition = currentRound.position;

        // Get player number from current lineup (after all rotations/substitutions)
        // Find the most recent lineup event for left team
        const leftLineupEvents = setEvents
          .filter(e => e.type === 'lineup' && e.payload?.team === leftTeamKey)
          .sort((a, b) => (b.seq || 0) - (a.seq || 0)); // Most recent first

        if (leftLineupEvents.length > 0) {
          const currentLineup = leftLineupEvents[0].payload?.lineup;
          const positionNames = ['I', 'II', 'III', 'IV', 'V', 'VI'];
          currentServerNumber = currentLineup?.[positionNames[currentServePosition]] || '';
        }
      } else if (currentServeTeam === 'right' && rightServiceRounds.length > 0) {
        const currentRound = rightServiceRounds.filter(sr => sr.points === null).pop() ||
          rightServiceRounds[rightServiceRounds.length - 1];
        currentServePosition = currentRound.position;

        const rightLineupEvents = setEvents
          .filter(e => e.type === 'lineup' && e.payload?.team === rightTeamKey)
          .sort((a, b) => (b.seq || 0) - (a.seq || 0));

        if (rightLineupEvents.length > 0) {
          const currentLineup = rightLineupEvents[0].payload?.lineup;
          const positionNames = ['I', 'II', 'III', 'IV', 'V', 'VI'];
          currentServerNumber = currentLineup?.[positionNames[currentServePosition]] || '';
        }
      }
    }

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
      set5ChangeAt,
      currentServer: hasBeenPlayed ? {
        team: currentServeTeam,
        position: currentServePosition,
        playerNumber: currentServerNumber
      } : null
    };
  };

  // Always get data for all sets (will be empty if not played)
  const set1Data = getSetData(1, false);
  const set2Data = getSetData(2, true);
  const set3Data = getSetData(3, false);
  const set4Data = getSetData(4, true);

  // Sets won, match over (also needed to strike off the unused grids)
  const bestOf = match?.bestOf === 3 ? 3 : 5;
  const neededToWin = bestOf === 3 ? 2 : 3;
  const finishedSets = sets.filter(s => s?.finished);
  const pointsOf = (s: any, key: 'home' | 'away') => (key === 'home' ? (s?.homePoints || 0) : (s?.awayPoints || 0));
  const teamASetsWon = finishedSets.filter(s => pointsOf(s, teamAKey) > pointsOf(s, teamBKey)).length;
  const teamBSetsWon = finishedSets.filter(s => pointsOf(s, teamBKey) > pointsOf(s, teamAKey)).length;
  const isMatchFinished = teamASetsWon >= neededToWin || teamBSetsWon >= neededToWin;

  // A set awarded by default / forfeit without a single rally: created by the
  // forfeit (forfeitCreated), or every one of its points was awarded (a default
  // before the start). Its grid stays empty and is struck off; no start / end
  // time, no duration (field-spec 11).
  const isDefaultSet = (setIndex: number): boolean => {
    const info = sets.find(s => s?.index === setIndex);
    if (!info) return false;
    if (info.forfeitCreated) return true;
    const pts = events.filter(e => e?.setIndex === setIndex && e?.type === 'point');
    return pts.length > 0 && pts.every(e => e.payload?.forfeitAwarded === true);
  };
  const wasPlayed = (setIndex: number): boolean => {
    const info = sets.find(s => s?.index === setIndex);
    return !!info && (info.homePoints > 0 || info.awayPoints > 0 || !!info.startTime || info.finished === true);
  };
  // Struck off with a Z: a set awarded by default, and once the result is known the
  // grids that were never played (best-of-3: sets 3 and 4 always) (field-spec 6, 11)
  const isStruckOff = (setIndex: number): boolean => {
    if (isDefaultSet(setIndex)) return true;
    if (bestOf === 3 && (setIndex === 3 || setIndex === 4)) return true;
    return isMatchFinished && !wasPlayed(setIndex);
  };

  // Helper to check if a set has finished
  const isSetFinished = (setIndex: number) => {
    const setInfo = sets?.find(s => s.index === setIndex);
    return setInfo?.finished === true;
  };

  // Determine which sets should show team names, S/R, X (basic info)
  // Set 1: shows when coin toss is confirmed
  // Set 2: shows when Set 1 is finished
  // Set 3: shows when Set 2 is finished
  // For best-of-3: Sets 3 and 4 are never played (deciding set uses Set 5 tiebreak format),
  // so they should always remain blank — no team labels, S/R, or X
  const isBestOf3 = bestOf === 3;
  const shouldShowSet1 = coinTossConfirmed;
  const shouldShowSet2 = isSetFinished(1);
  const shouldShowSet3 = isBestOf3 ? false : isSetFinished(2);

  // Calculate set wins to determine if Set 4 should be displayed
  // Set 4 should only be filled if both teams have won at least one set
  // For best-of-3: Set 4 is never played, always blank
  const finishedSetsForSet4Check = sets?.filter(s => s.finished) || [];
  const teamASetsWonForSet4Check = finishedSetsForSet4Check.filter(s => {
    const teamAPoints = teamAKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    const teamBPoints = teamBKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    return teamAPoints > teamBPoints;
  }).length;
  const teamBSetsWonForSet4Check = finishedSetsForSet4Check.filter(s => {
    const teamAPoints = teamAKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    const teamBPoints = teamBKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    return teamBPoints > teamAPoints;
  }).length;

  // Set 4 should only be displayed if both teams have won at least one set
  // For best-of-3: Set 4 is never played, always blank
  const shouldShowSet4 = isBestOf3 ? false : (teamASetsWonForSet4Check >= 1 && teamBSetsWonForSet4Check >= 1);

  // For set 5, determine which team is on left based on set5LeftTeam
  // set5LeftTeam 'A'/'B' from the deciding-set toss
  // Set 5 should only be displayed if the set 5 coin toss has been done
  // OR if the set has been started/has points (if the toss is missing, fall back like Scoreboard:
  // teams switched as in set 2/4, i.e. Team B on left)
  const set5Info = sets?.find(s => s.index === 5);
  const set5HasStarted = set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime);

  const hasSet5CoinToss = !!(match?.set5LeftTeam || match?.set5FirstServe || set5HasStarted);
  const set5LeftTeamIsB = getSet5LeftTeamLabel(match) === 'B';
  // getSetData uses isSwapped: true means Team B on left, false means Team A on left
  const set5Data = hasSet5CoinToss ? getSetData(5, set5LeftTeamIsB) : null;

  // Determine which team actually changes sides (the one on the left)
  const set5TeamOnLeft = set5LeftTeamIsB ? teamBKey : teamAKey;
  const set5TeamOnRight = set5LeftTeamIsB ? teamAKey : teamBKey;

  // First server of the deciding set - one value for the service tracker, S/R cross and set data
  const set5FirstServeTeamKey = getFirstServeTeamKey(5, match, teamAKey, teamBKey);
  // The deciding set is drawn once its toss is known or it started, unless it was
  // awarded by default (then its grid is only struck off)
  const set5Shown = !!(hasSet5CoinToss && set5Data && !isStruckOff(5));

  // An empty set grid (unplayed set, or a set awarded by default)
  const emptySetData = {
    startTime: '',
    endTime: '',
    setFinished: false,
    leftLineup: ['', '', '', '', '', ''],
    rightLineup: ['', '', '', '', '', ''],
    leftPoints: 0,
    rightPoints: 0,
    leftMarkedPoints: [] as number[],
    rightMarkedPoints: [] as number[],
    leftCircledPoints: [] as number[],
    rightCircledPoints: [] as number[],
    leftServiceRounds: [] as ServiceRound[],
    rightServiceRounds: [] as ServiceRound[],
    leftTimeouts: ['', ''] as [string, string],
    rightTimeouts: ['', ''] as [string, string],
    leftSubs: [[], [], [], [], [], []],
    rightSubs: [[], [], [], [], [], []]
  };

  // Remarks the sheet writes itself: a default / an incomplete team (field-spec 8, 11)
  const autoRemarks = generatedRemarks({ sets, events, teamAKey, bestOf });
  // Consistency checks (field-spec 12.2): listed above the sheet, never printed
  const sheetWarnings = useMemo(
    () => consistencyWarnings({ sets, events, teamAKey, homePlayers, awayPlayers }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sets, events, teamAKey, homePlayers, awayPlayers]
  );

  // Calculate set results for Results section
  const calculateSetResults = () => {
    const results = [];
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets?.find(s => s.index === setNum);
      const setEvents = events?.filter(e => e.setIndex === setNum) || [];

      // Check if set is finished
      const isSetFinished = setInfo?.finished === true;

      // Get points for each team (only if set is finished)
      // Points are always stored by home/away, not by left/right
      // Team A and Team B are identified by coinTossTeamA, which doesn't change
      // So we can always get points correctly regardless of side swaps
      const teamAPoints = isSetFinished
        ? (teamAKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null;
      const teamBPoints = isSetFinished
        ? (teamBKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null;

      // Count timeouts (only if set is finished)
      const teamATimeouts = isSetFinished
        ? setEvents.filter(e =>
          e.type === 'timeout' && e.payload?.team === teamAKey
        ).length
        : null;
      const teamBTimeouts = isSetFinished
        ? setEvents.filter(e =>
          e.type === 'timeout' && e.payload?.team === teamBKey
        ).length
        : null;

      // Count substitutions (only if set is finished). The result "S" counts EVERY
      // substitution, exceptional ones included (field-spec 9 / 12.1, SC p.71:
      // "4 standard + 1 exceptional" = 5); only the 6-substitution limit counts
      // regular ones (countRegularSubstitutions).
      const teamASubstitutions = isSetFinished
        ? countAllSubstitutions(setEvents, teamAKey)
        : null;
      const teamBSubstitutions = isSetFinished
        ? countAllSubstitutions(setEvents, teamBKey)
        : null;

      // Determine winner (1 if won, 0 otherwise, only if set is finished)
      const teamAWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamAPoints > teamBPoints ? 1 : 0)
        : null;
      const teamBWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamBPoints > teamAPoints ? 1 : 0)
        : null;

      // Set duration = its end - its ACTUAL start (first rally), whole minutes
      // (utils/matchTimes, shared with MatchEnd). A set awarded by default has
      // none (field-spec 11).
      const minutes = isSetFinished && !isDefaultSet(setNum) ? setDurationMinutes(setInfo, setEvents) : null;
      const duration = minutes !== null && minutes > 0 ? `${minutes}'` : '';

      results.push({
        setNumber: setNum,
        teamATimeouts: teamATimeouts,
        teamASubstitutions: teamASubstitutions,
        teamAWon: teamAWon,
        teamAPoints: teamAPoints,
        teamBTimeouts: teamBTimeouts,
        teamBSubstitutions: teamBSubstitutions,
        teamBWon: teamBWon,
        teamBPoints: teamBPoints,
        duration: duration,
        endTime: isSetFinished && setInfo?.endTime ? setInfo.endTime : undefined
      });
    }
    return results;
  };

  const setResults = calculateSetResults();

  // Process sanctions from events
  const processSanctions = (): { sanctions: SanctionRecord[], improperRequests: { teamA: boolean, teamB: boolean } } => {
    const sanctionRecords: SanctionRecord[] = [];
    const improperRequests = { teamA: false, teamB: false };

    // Check match.sanctions for improper requests (stored separately as left/right)
    // In set 1, Team A is always left, Team B is always right
    // Note: We'll process improper requests from events below, so we don't need to check match.sanctions here
    // to avoid duplicates

    if (!events) return { sanctions: sanctionRecords, improperRequests };

    // Get all sanction events sorted chronologically
    const sanctionEvents = events
      .filter(e => e.type === 'sanction')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });

    // Helper to get score at a specific sanction event
    // Points before it in event order (seq; ts only when seq is missing), like every other block
    const getScoreAtEvent = (sanctionEvent: any): string => {
      const { home: homeScore, away: awayScore } = getScoreBeforeEvent(events, sanctionEvent);

      // Map to Team A/B based on team keys
      const teamAScore = teamAKey === 'home' ? homeScore : awayScore;
      const teamBScore = teamBKey === 'home' ? homeScore : awayScore;

      // Return score in format "sanctionedTeam:otherTeam" (sanctioned team score first)
      // This will be set correctly when processing each sanction
      return `${teamAScore}:${teamBScore}`;
    };

    // Process each sanction event
    for (const event of sanctionEvents) {
      const payload = event.payload || {};
      const sanctionType = payload.type;
      const eventTeam = payload.team; // 'home' or 'away'
      // Printed set number (best-of-3 deciding set is stored at index 5 but is set 3)
      const setNumberLabel = displaySetNumber(event.setIndex, match?.bestOf);

      // Map team to A or B
      const teamLabel = (eventTeam === teamAKey) ? 'A' : 'B';

      // Get score at the moment of this sanction
      const rawScore = getScoreAtEvent(event);

      // Format score as "sanctionedTeam:otherTeam" (sanctioned team score first)
      const [teamAScoreStr, teamBScoreStr] = rawScore.split(':');
      const sanctionedTeamScore = teamLabel === 'A' ? teamAScoreStr : teamBScoreStr;
      const otherTeamScore = teamLabel === 'A' ? teamBScoreStr : teamAScoreStr;
      const score = `${sanctionedTeamScore}:${otherTeamScore}`;

      // Handle improper request
      if (sanctionType === 'improper_request') {
        if (teamLabel === 'A') improperRequests.teamA = true;
        else improperRequests.teamB = true;
        continue; // Don't add to sanction records
      }

      // Handle delay sanctions
      if (sanctionType === 'delay_warning' || sanctionType === 'delay_penalty') {
        const record: SanctionRecord = {
          team: teamLabel,
          playerNr: 'D', // "D" marker for delay sanctions
          type: sanctionType === 'delay_warning' ? 'warning' : 'penalty',
          set: setNumberLabel,
          score: score
        };
        sanctionRecords.push(record);
        continue;
      }

      // Handle misconduct sanctions (warning, penalty, expulsion, disqualification)
      if (['warning', 'penalty', 'expulsion', 'disqualification'].includes(sanctionType)) {
        // Get player number or official initial
        let playerNr = '';

        if (payload.playerNumber) {
          // Player number
          playerNr = String(payload.playerNumber);
        } else if (payload.role) {
          // Official role - map to initial
          const roleMap: { [key: string]: string } = {
            'Coach': 'C',
            'Assistant Coach 1': 'AC1',
            'Assistant Coach 2': 'AC2',
            'Physiotherapist': 'P',
            'Medic': 'M'
          };
          playerNr = roleMap[payload.role] || payload.role.charAt(0).toUpperCase();
        } else if (payload.playerType === 'official') {
          // Generic official - try to get from role or use 'C' for coach
          playerNr = 'C'; // Default to Coach
        }

        if (playerNr) {
          const record: SanctionRecord = {
            team: teamLabel,
            playerNr: playerNr,
            type: sanctionType as 'warning' | 'penalty' | 'expulsion' | 'disqualification',
            set: setNumberLabel,
            score: score,
            // a player sanctioned on the bench: number circled (SC p.62)
            onBench: !!payload.playerNumber && payload.playerType === 'bench'
          };
          sanctionRecords.push(record);
        }
      }
    }

    return { sanctions: sanctionRecords, improperRequests };
  };

  const { sanctions: processedSanctions, improperRequests } = processSanctions();

  // Split sanctions into those that fit in the box (9 rows, as the Matchblatt) and overflow
  const sanctionsInBox = processedSanctions.slice(0, SANCTION_ROWS);
  const overflowSanctions = processedSanctions.slice(SANCTION_ROWS);

  // Match start / end / duration (field-spec 9): set 1's recorded start (never the
  // schedule), the last set's end, both as "HH h MM min"; the duration "H h MM min"
  // includes the intervals. A match decided by default before any rally has none.
  const rallySets = sets.filter(s => s && !isDefaultSet(s.index));
  const set1 = rallySets.find(s => s.index === 1);
  // the actual start of set 1 (its first rally), empty until the match has started
  // (owner 2026-10-07: never the scheduled time)
  const set1StartMs = setStartMs(set1, events);
  const matchStart = set1StartMs !== null ? formatClockHoursMinutes(isoOf(set1StartMs)) : '';

  // Winner: full team name, result "3-1" (only once the match is finished)
  const winner = isMatchFinished
    ? (teamASetsWon >= neededToWin ? teamAName : teamBName)
    : '';
  const result = isMatchFinished
    ? (teamASetsWon >= neededToWin ? `${teamASetsWon}-${teamBSetsWon}` : `${teamBSetsWon}-${teamASetsWon}`)
    : '';

  const lastSet = sets
    .filter(s => s?.endTime && (rallySets.includes(s) || s.forfeitCreated))
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0];
  const anyRally = rallySets.some(s => (s.homePoints || 0) + (s.awayPoints || 0) > 0);
  const lastSetEndMs = setEndMs(lastSet, events);
  const matchEndFinal = isMatchFinished && anyRally && lastSetEndMs !== null
    ? formatClockHoursMinutes(isoOf(lastSetEndMs))
    : '';
  const matchDuration = isMatchFinished && anyRally && set1StartMs !== null && lastSetEndMs !== null && lastSetEndMs >= set1StartMs
    ? formatHoursMinutes(Math.floor((lastSetEndMs - set1StartMs) / 60000))
    : '';

  // Set 5: three panels (field-spec 6). Panel 1 = the left team until the change of
  // courts (points 1-8), panel 2 = the right team, panel 3 = the left team after the
  // change. Everything comes from getSetData(5): the same points, circles and the
  // same service-round tracker as sets 1-4, split at the change.
  const set5Changed = set5Data?.set5ChangeAt !== null && set5Data?.set5ChangeAt !== undefined;
  // Left team's points at the change (N); no change yet: every left point is in panel 1
  const leftScoreAtChange: number = set5Changed ? (set5Data?.leftScoreAtCourtChange ?? 0) : Infinity;
  const set5LeftMarked: number[] = set5Data?.leftMarkedPoints || [];
  const set5LeftCircled: number[] = set5Data?.leftCircledPoints || [];
  const markedPointsA_Left = set5LeftMarked.filter(p => p <= leftScoreAtChange); // panel 1
  const markedPointsA_Right = set5LeftMarked.filter(p => p > leftScoreAtChange); // panel 3
  const markedPointsB = set5Data?.rightMarkedPoints || []; // panel 2
  const circledPointsA_Left = set5LeftCircled.filter(p => p <= leftScoreAtChange);
  const circledPointsA_Right = set5LeftCircled.filter(p => p > leftScoreAtChange);
  const circledPointsB = set5Data?.rightCircledPoints || [];

  const set5LeftSplit = splitSet5Rounds(set5Data?.leftTrackedRounds || [], set5Changed ? set5Data!.set5ChangeAt as number : null);
  const set5ServiceRoundsLeftTeam_Before: ServiceRound[] = set5LeftSplit.before; // panel 1
  const set5ServiceRoundsLeftTeam_After: ServiceRound[] = set5LeftSplit.after; // panel 3
  const set5ServiceRoundsRightTeam: ServiceRound[] = set5Data?.rightServiceRounds || []; // panel 2

  // Ruler measurements
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const set1Ref = useRef<HTMLDivElement>(null);
  const set2Ref = useRef<HTMLDivElement>(null);
  const set3Ref = useRef<HTMLDivElement>(null);
  const set4Ref = useRef<HTMLDivElement>(null);
  const set5Ref = useRef<HTMLDivElement>(null);
  const sanctionsRef = useRef<HTMLDivElement>(null);
  const remarksRef = useRef<HTMLDivElement>(null);
  const approvalsRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const rosterARef = useRef<HTMLDivElement>(null);
  const rosterBRef = useRef<HTMLDivElement>(null);
  const positionBoxSet1Ref = useRef<HTMLDivElement>(null);
  const positionBoxSet5Ref = useRef<HTMLDivElement>(null);
  const buttonsContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Zoom state for tablet/viewport control
  const [zoomLevel, setZoomLevel] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Viewport tracking for portrait/landscape detection
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1366);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 768);
  const isLandscape = viewportWidth >= viewportHeight;

  const zoomIn = () => setZoomLevel(prev => Math.min(prev + 0.1, 2));
  const zoomOut = () => setZoomLevel(prev => Math.max(prev - 0.1, 0.3));
  const resetZoom = () => setZoomLevel(1);

  const fitToScreen = () => {
    if (!containerRef.current) return;
    // Get viewport dimensions (minus toolbar height ~50px)
    const viewportWidth = window.innerWidth - 32; // padding
    const viewportHeight = window.innerHeight - 70; // toolbar + padding
    // Scoresheet is 410mm x 287mm, convert to px (1mm ≈ 3.78px at 96 DPI)
    const scoresheetWidth = 410 * 3.78;
    const scoresheetHeight = 287 * 3.78;
    const zoomX = viewportWidth / scoresheetWidth;
    const zoomY = viewportHeight / scoresheetHeight;
    const optimalZoom = Math.min(zoomX, zoomY, 1);
    setZoomLevel(Math.max(0.3, Math.round(optimalZoom * 100) / 100));
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (err) {
      console.error('Fullscreen toggle failed:', err);
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Lock orientation to landscape for scoresheet
  useEffect(() => {
    const lockLandscape = async () => {
      try {
        const orientation = screen.orientation as any;
        if (orientation && orientation.lock) {
          await orientation.lock('landscape');
          console.log('[Scoresheet] Orientation locked to landscape');
        }
      } catch (err) {
        console.log('[Scoresheet] Orientation lock not supported:', err);
      }
    };
    lockLandscape();

    return () => {
      // Unlock orientation when leaving scoresheet
      const orientation = screen.orientation as any;
      if (orientation && orientation.unlock) {
        try {
          orientation.unlock();
        } catch (err) {
          // Ignore unlock errors
        }
      }
    };
  }, []);

  // Track viewport size for portrait/landscape detection
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Auto-fit to screen on mount if viewport is smaller than scoresheet
  useEffect(() => {
    const viewportWidth = window.innerWidth;
    const scoresheetWidth = 410 * 3.78; // ~1550px
    if (viewportWidth < scoresheetWidth) {
      fitToScreen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // State for PDF generation
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const generatingRef = useRef(false);
  // Where the PDF went, shown next to the buttons until dismissed (field-spec 13.5):
  // the full path on the desktop (Open file / Show in folder), the file name in a
  // browser, or why it failed. Not alert(): in the desktop app the dialog plugin
  // replaces it and this window may not call it.
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The file name of this window's last "Save PDF" download: on Linux every
  // window hears every download (the scoretable's match-end ZIP too).
  const pendingDownload = useRef<string | null>(null);
  useEffect(() => {
    const onFinished = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string | null; fileName?: string | null; success?: boolean; id?: number | null }>).detail || {};
      if (!isOwnDownload(detail, pendingDownload.current)) return;
      const fileName = detail.fileName || pendingDownload.current || '';
      pendingDownload.current = null;
      setActionError(null);
      setSaveOutcome(detail.success && detail.path
        ? { kind: 'desktop', fileName, path: detail.path, id: detail.id ?? null }
        : { kind: 'failed', message: t('appWindow.downloadFailed', 'The download did not finish.') });
    };
    window.addEventListener('ov-download-finished', onFinished);
    return () => window.removeEventListener('ov-download-finished', onFinished);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // A match that is not on this device: say so on the page itself, not only when saving
  useEffect(() => {
    if (matchMissing) {
      setSaveOutcome({ kind: 'failed', message: t('scoresheetPdf.matchNotFound', 'This match is not on this device: there is no scoresheet to save.') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchMissing]);

  // The data of the LATEST render: a save started by autoAction or a click always
  // names the file after what is on the sheet now (the first render had no teams yet:
  // "match_HOME_AWAY_<date>.pdf").
  const latestData = useRef({ match, homeTeam, awayTeam, sets });
  latestData.current = { match, homeTeam, awayTeam, sets };

  const handleSavePdf = async (returnBlob = false): Promise<{ blob: Blob; filename: string } | void> => {
    if (!containerRef.current || generatingRef.current) return;
    if (matchMissing) {
      // ?matchId= of a match that is not on this device: never save an empty sheet
      if (!returnBlob) setSaveOutcome({ kind: 'failed', message: t('scoresheetPdf.matchNotFound', 'This match is not on this device: there is no scoresheet to save.') });
      return;
    }

    generatingRef.current = true;
    setIsGeneratingPdf(true);
    setSaveOutcome(null);
    setActionError(null);
    const savedZoomLevel = zoomLevel;
    const wasShowingLCS = showLCS;

    try {
      const data = latestData.current;
      const filename = buildScoresheetFilename(data);
      const title = buildScoresheetTitle(data);

      // Capture the sheet itself at 100 %: back from the libero control sheet (the
      // sheet is display:none there), zoom reset, fonts loaded
      if (wasShowingLCS) setShowLCS(false);
      setZoomLevel(1);
      await new Promise(resolve => setTimeout(resolve, 250));
      await (document as any).fonts?.ready;

      const sheet = containerRef.current;
      assertVisibleSheet(sheet);

      // Lazy-load PDF libraries (only needed when generating PDF)
      const [htmlToImage, { jsPDF }] = await Promise.all([
        import('html-to-image'),
        import('jspdf')
      ]);

      // pixelRatio 2: ~190 dpi on A3, sharp enough for print, a reasonable file size
      const capture = (props: string[]) => htmlToImage.toCanvas(sheet!, {
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        style: {
          transform: 'none',
        },
        includeStyleProperties: styleListFor(props),
      });
      // WebKitGTK (Linux desktop app) cannot load the full capture (an ~87 MB
      // data URL): it copies only the properties the sheet uses, and draws
      // the logos and signatures itself, as it paints pictures nested in the
      // SVG only now and then (utils/pdfCapture.ts). Elsewhere the full copy
      // as before, and the lean one only if that fails.
      let canvas: HTMLCanvasElement;
      if (isWebKitGtk()) {
        const pictures = drawableImages(sheet!);
        const showPictures = hideImages(pictures);
        try {
          canvas = await capture(usedStyleProperties(sheet!));
        } finally {
          showPictures();
        }
        drawImagesOnto(canvas, sheet!, pictures);
      } else {
        try {
          canvas = await capture(allStyleProperties());
        } catch (err) {
          console.warn('[Scoresheet] Full capture failed, retrying with the used styles only:', err);
          canvas = await capture(usedStyleProperties(sheet!));
        }
      }
      assertCanvas(canvas);

      const imgData = canvas.toDataURL('image/jpeg', 0.85);
      assertJpegDataUrl(imgData);

      // A3 landscape (420 x 297 mm); the 410 x 287 mm sheet placed at its true size,
      // centred (5 mm margins): to scale, circles stay circles
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a3',
        compress: true
      });
      pdf.setProperties({
        title,
        subject: 'Volleyball scoresheet',
        creator: 'OpenVolley eScoresheet',
        keywords: 'OpenVolley, eScoresheet, volleyball, scoresheet'
      });
      pdf.addImage(imgData, 'JPEG', SHEET_OFFSET_MM.x, SHEET_OFFSET_MM.y, SHEET_MM.width, SHEET_MM.height, undefined, 'FAST');
      // A searchable line (title, result) under the picture, not drawn
      try {
        pdf.setFontSize(6);
        pdf.text(`${title}${result ? ` - ${result.replace('-', ':')}` : ''}`, SHEET_OFFSET_MM.x, 3, { renderingMode: 'invisible' } as any);
      } catch { /* text layer is optional */ }

      const bytes = pdf.output('arraybuffer');
      assertValidPdf(bytes);
      const pdfBlob = new Blob([bytes], { type: 'application/pdf' });

      if (returnBlob) {
        return { blob: pdfBlob, filename };
      }
      if (await savePdfThroughApp(pdfBlob, filename)) {
        // Android in-app view: the app writes it and its bar says where (with Open / Share)
        setSaveOutcome({ kind: 'app', fileName: filename });
        return;
      }
      // A download. The desktop app puts it in Downloads and reports the full path
      // (ov-download-finished); a browser keeps it in its download folder.
      pendingDownload.current = filename;
      downloadBlob(pdfBlob, filename);
      setSaveOutcome(detectAppPlatform(window) === 'tauri' || getOpenerWindow() && detectAppPlatform(getOpenerWindow() as Window) === 'tauri'
        ? { kind: 'desktop-pending', fileName: filename }
        : { kind: 'web', fileName: filename });
    } catch (error) {
      console.error('Error generating PDF:', error);
      if (!returnBlob) {
        setSaveOutcome({
          kind: 'failed',
          message: error instanceof PdfCheckError
            ? t('scoresheetPdf.pdfInvalid', 'The PDF could not be created correctly. Please try again.')
            : t('scoresheetPdf.pdfFailed', 'The PDF could not be created on this device.')
        });
      }
    } finally {
      // the zoom and the view the scorer had, also after a failure
      setZoomLevel(savedZoomLevel);
      if (wasShowingLCS) setShowLCS(true);
      generatingRef.current = false;
      setIsGeneratingPdf(false);
    }
  };
  // Always the latest closure (latest data, latest state) for the automatic action
  const handleSavePdfRef = useRef(handleSavePdf);
  handleSavePdfRef.current = handleSavePdf;

  // Open / show the saved file through the desktop app (popups.rs download_open /
  // download_reveal: only a download it recorded itself, by its id)
  const runDownloadAction = async (command: 'download_open' | 'download_reveal', id: number | null | undefined) => {
    setActionError(null);
    try {
      const internals = (window as any).__TAURI_INTERNALS__;
      if (!internals?.invoke || id === null || id === undefined) throw new Error('not available');
      await internals.invoke(command, { id });
    } catch (e) {
      setActionError(t('scoresheetPdf.fileActionFailed', 'The file could not be opened from here. It is in: {{path}}', {
        path: saveOutcome && saveOutcome.kind === 'desktop' ? saveOutcome.path : ''
      }));
    }
  };

  // Automatic action (?action=print|save|getBlob): once every query has answered
  // (dataReady), never on the first render with half the data; once only.
  const autoActionDone = useRef(false);
  useEffect(() => {
    if (!autoAction || autoAction === 'preview' || !dataReady || autoActionDone.current) return;
    autoActionDone.current = true;

    const timer = setTimeout(async () => {
      await (document as any).fonts?.ready;
      if (autoAction === 'print' || autoAction === 'save') {
        await handleSavePdfRef.current();
      } else if (autoAction === 'getBlob') {
        // Generate the PDF and hand it to the opener (MatchEnd's approval),
        // or tell it the capture failed so it does not wait for its timeout;
        // then close this window / the in-app view either way.
        const out = matchMissing ? null : await handleSavePdfRef.current(true);
        await deliverPdfToOpener(out || null);
      }
    }, 500);

    return () => { clearTimeout(timer); autoActionDone.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAction, dataReady]);


  return (
    <>
      {/* Portrait mode warning overlay for devices that don't support orientation lock (iOS) */}
      {!isLandscape && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.95)',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{
            marginBottom: '24px',
            color: '#ffffff',
            animation: 'rotate90 1.5s ease-in-out infinite'
          }}>
            <PhoneIcon size={64} />
          </div>
          <style>{`
            @keyframes rotate90 {
              0%, 100% { transform: rotate(0deg); }
              50% { transform: rotate(-90deg); }
            }
          `}</style>
          <h2 style={{
            fontSize: '24px',
            fontWeight: 700,
            color: '#ffffff',
            marginBottom: '16px'
          }}>
            Please Rotate Your Device
          </h2>
          <p style={{
            fontSize: '16px',
            color: '#9ca3af',
            maxWidth: '300px',
            lineHeight: 1.5,
            marginBottom: '24px'
          }}>
            The Scoresheet works best in landscape mode. Please rotate your device horizontally to continue.
          </p>
          <div style={{
            padding: '12px 16px',
            background: 'rgba(59, 130, 246, 0.15)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: '8px',
            maxWidth: '320px'
          }}>
            <p style={{
              fontSize: '13px',
              color: '#93c5fd',
              lineHeight: 1.4,
              margin: 0
            }}>
              <strong>Tip:</strong> For auto-backup features, use Chrome or Edge on a desktop/laptop computer.
            </p>
          </div>
        </div>
      )}

      {/* PDF Generating overlay */}
      {isGeneratingPdf && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          zIndex: 99998,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{
            fontSize: '48px',
            marginBottom: '24px',
            animation: 'spin 1s linear infinite'
          }}>
            ⏳
          </div>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
          <h2 style={{
            color: 'white',
            fontSize: '24px',
            fontWeight: 'bold',
            marginBottom: '16px'
          }}>
            {t('scoresheetPdf.generatingPdf', 'Generating PDF...')}
          </h2>
          <p style={{
            color: '#d1d5db',
            fontSize: '16px',
            maxWidth: '400px'
          }}>
            {t('scoresheetPdf.generatingPdfMessage', 'Please wait while the scoresheet is being converted to PDF. This may take a few seconds.')}
          </p>
        </div>
      )}

      <div ref={buttonsContainerRef} className="mb-2 flex flex-col justify-center items-center print:hidden w-full sticky top-0 z-50 bg-gray-100 py-2">
        <div className="flex items-center space-x-2">
          {/* Zoom controls */}
          <button
            onClick={zoomOut}
            className="bg-gray-500 hover:bg-gray-700 text-white px-3 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.zoomOut', 'Zoom Out')}
          >
            −
          </button>
          <button
            onClick={resetZoom}
            className="bg-gray-500 hover:bg-gray-700 text-white px-2 py-1 rounded text-sm shadow min-w-[50px]"
            title={t('scoresheetPdf.resetZoom', 'Reset Zoom (100%)')}
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            onClick={fitToScreen}
            className="bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.fitToScreen', 'Fit to Screen')}
          >
            {t('scoresheetPdf.fit', 'Fit')}
          </button>
          <button
            onClick={zoomIn}
            className="bg-gray-500 hover:bg-gray-700 text-white px-3 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.zoomIn', 'Zoom In')}
          >
            +
          </button>

          {/* Divider */}
          <div className="w-px h-6 bg-gray-400 mx-2"></div>

          {/* Fullscreen button */}
          <button
            onClick={toggleFullscreen}
            className="bg-blue-500 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm shadow"
            title={isFullscreen ? t('scoresheetPdf.exitFullscreen', 'Exit Fullscreen') : t('scoresheetPdf.fullscreen', 'Fullscreen')}
          >
            {isFullscreen ? '⤓' : '⤢'}
          </button>

          {/* Save PDF button (one-click, no dialog) */}
          <button
            onClick={() => handleSavePdf()}
            disabled={isGeneratingPdf}
            className={`${isGeneratingPdf ? 'bg-purple-400 cursor-wait' : 'bg-purple-500 hover:bg-purple-700'} text-white px-3 py-1 rounded text-sm shadow`}
            title={t('scoresheetPdf.savePdfTooltip', 'Save as PDF (one-click download)')}
          >
            {isGeneratingPdf ? t('scoresheetPdf.generating', 'Generating...') : t('scoresheetPdf.savePdf', 'Save PDF')}
          </button>

          {/* Libero Control Sheet toggle button - only shown when there is libero activity */}
          {hasLiberoActivity && (
            <button
              onClick={() => setShowLCS(prev => !prev)}
              className={`${showLCS ? 'bg-teal-700' : 'bg-teal-600 hover:bg-teal-700'} text-white px-3 py-1 rounded text-sm shadow`}
              title={showLCS ? t('scoresheetPdf.backToScoresheet', 'Back to Scoresheet') : t('scoresheetPdf.lcsTooltip', 'View Libero Control Sheet')}
            >
              {showLCS ? t('scoresheetPdf.backToScoresheet', 'Scoresheet') : t('scoresheetPdf.lcs', 'Libero Control Sheet')}
            </button>
          )}

        </div>
        {sheetWarnings.length > 0 && (
          <div data-testid="sheet-warnings" className="mt-2 mx-2 max-w-[min(100%,72rem)] rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
            <span className="font-semibold">{t('scoresheetPdf.checkTheMatch', 'Check the match before approving it:')}</span>
            <ul className="list-disc pl-5">
              {sheetWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        {/* Where the PDF went: the whole path (wraps, selectable), stays until closed */}
        {saveOutcome && (
          <div
            role="status"
            data-testid="pdf-notice"
            className={`mt-2 mx-2 max-w-[min(100%,72rem)] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-sm ${saveOutcome.kind === 'failed' ? 'border-red-300 bg-red-50 text-red-800' : 'border-stone-300 bg-white text-stone-800'}`}
          >
            <span className="min-w-0 break-all">
              {saveOutcome.kind === 'desktop' && (
                <>
                  {t('scoresheetPdf.pdfSavedAt', 'PDF saved:')}{' '}
                  <span className="font-mono font-semibold select-all" data-testid="pdf-notice-path">{saveOutcome.path}</span>
                </>
              )}
              {saveOutcome.kind === 'desktop-pending' && t('scoresheetPdf.savingFile', 'Saving {{fileName}}...', { fileName: saveOutcome.fileName })}
              {saveOutcome.kind === 'web' && (
                <>
                  {t('scoresheetPdf.pdfDownloaded', "Downloaded to your browser's download folder:")}{' '}
                  <span className="font-mono font-semibold select-all" data-testid="pdf-notice-path">{saveOutcome.fileName}</span>
                </>
              )}
              {saveOutcome.kind === 'app' && t('scoresheetPdf.pdfHandedToApp', 'The app is saving {{fileName}}: the bar at the top shows where.', { fileName: saveOutcome.fileName })}
              {saveOutcome.kind === 'failed' && saveOutcome.message}
            </span>
            {saveOutcome.kind === 'desktop' && saveOutcome.id !== null && saveOutcome.id !== undefined && (
              <span className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => runDownloadAction('download_open', saveOutcome.id)}
                  className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-700"
                >
                  {t('scoresheetPdf.openFile', 'Open file')}
                </button>
                <button
                  type="button"
                  onClick={() => runDownloadAction('download_reveal', saveOutcome.id)}
                  className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-800 hover:bg-stone-100"
                >
                  {t('scoresheetPdf.showInFolder', 'Show in folder')}
                </button>
              </span>
            )}
            {actionError && <span className="text-xs text-red-700 break-all">{actionError}</span>}
            <button
              type="button"
              onClick={() => { setSaveOutcome(null); setActionError(null); }}
              className="ml-auto shrink-0 rounded px-1.5 text-stone-500 hover:text-stone-900"
              aria-label={t('scoresheetPdf.dismiss', 'Close')}
              title={t('scoresheetPdf.dismiss', 'Close')}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <style>{`
        @media print {
          .scoresheet-container {
            transform: scale(0.72) !important;
            transform-origin: top center !important;
            width: 410mm !important;
            height: 287mm !important;
            margin: 0 auto !important;
          }
          .scoresheet-scroll-container {
            padding: 0 !important;
            margin: 0 !important;
            overflow: hidden !important;
            width: 297mm !important;
            height: 210mm !important;
            min-height: 0 !important;
            display: flex !important;
            justify-content: center !important;
            align-items: flex-start !important;
          }
        }
      `}</style>
      <div
        ref={scrollContainerRef}
        className="scoresheet-scroll-container min-h-screen bg-gray-100 p-2 flex justify-center overflow-auto print:bg-white"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        {/* LCS View */}
        {showLCS && (
          <div
            className="flex flex-col items-center gap-4"
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'top center',
              transition: 'transform 0.2s ease',
            }}
          >
            <LiberoControlSheet
              match={match}
              homeTeam={homeTeam}
              awayTeam={awayTeam}
              teamAName={teamAName}
              teamBName={teamBName}
              teamAKey={teamAKey as 'home' | 'away'}
              lcsData={lcsData}
              coinTossConfirmed={coinTossConfirmed}
              bestOf={bestOf}
            />
          </div>
        )}

        {/* Scoresheet View */}
        <div
          ref={containerRef}
          className="scoresheet-container w-[410mm] h-[287mm] bg-white shadow-xl print:shadow-none p-3 print:p-3 relative"
          style={{
            boxSizing: 'border-box',
            transform: `scale(${zoomLevel})`,
            transformOrigin: 'top center',
            transition: 'transform 0.2s ease',
            display: showLCS ? 'none' : undefined,
          }}
        >
          <div className="h-full" style={{ padding: '4mm 7mm 6mm 5mm' }}>
            <div ref={headerRef}>
              <Header
                match={match}
                homeTeam={homeTeam}
                awayTeam={awayTeam}
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
                <div ref={set1Ref} className="flex flex-1">
                  <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
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
                      teamNameLeft={shouldShowSet1 && !isStruckOff(1) ? teamAShortName : ''}
                      teamNameRight={shouldShowSet1 && !isStruckOff(1) ? teamBShortName : ''}
                      firstServeTeamA={shouldShowSet1 && !isStruckOff(1) ? set1ServeIsA : undefined}
                      positionBoxRef={positionBoxSet1Ref}
                      {...(isStruckOff(1) ? emptySetData : set1Data)}
                      struckOff={isStruckOff(1)}
                    />
                  </div>
                </div>
                <div ref={set2Ref} className="flex flex-1">
                  <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
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
                      teamNameLeft={shouldShowSet2 && !isStruckOff(2) ? teamBShortName : ''}
                      teamNameRight={shouldShowSet2 && !isStruckOff(2) ? teamAShortName : ''}
                      firstServeTeamA={shouldShowSet2 && !isStruckOff(2) ? set1ServeIsA : undefined}
                      {...(isStruckOff(2) ? emptySetData : set2Data)}
                      struckOff={isStruckOff(2)}
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
                <div ref={set3Ref} className="flex flex-1">
                  <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                    <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                      <span>S</span>
                      <span>E</span>
                      <span>T</span>
                    </div>
                    <div className="font-black text-sm mt-1">{isBestOf3 ? '' : '3'}</div>
                  </div>
                  <div className="flex-1">
                    <StandardSet
                      setNumber={3}
                      teamNameLeft={shouldShowSet3 && !isStruckOff(3) ? teamAShortName : ''}
                      teamNameRight={shouldShowSet3 && !isStruckOff(3) ? teamBShortName : ''}
                      firstServeTeamA={shouldShowSet3 && !isStruckOff(3) ? set1ServeIsA : undefined}
                      {...(isStruckOff(3) ? emptySetData : set3Data)}
                      struckOff={isStruckOff(3)}
                    />
                  </div>
                </div>
                <div ref={set4Ref} className="flex flex-1">
                  <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                    <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                      <span>S</span>
                      <span>E</span>
                      <span>T</span>
                    </div>
                    <div className="font-black text-sm mt-1">{isBestOf3 ? '' : '4'}</div>
                  </div>
                  <div className="flex-1">
                    <StandardSet
                      setNumber={4}
                      isSwapped={true}
                      teamNameLeft={shouldShowSet4 && !isStruckOff(4) ? teamBShortName : ''}
                      teamNameRight={shouldShowSet4 && !isStruckOff(4) ? teamAShortName : ''}
                      firstServeTeamA={shouldShowSet4 && !isStruckOff(4) ? set1ServeIsA : undefined}
                      {...(shouldShowSet4 && !isStruckOff(4) ? set4Data : emptySetData)}
                      struckOff={isStruckOff(4)}
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
            <div className="flex gap-1 mt-1 items-stretch print:flex-1 print:min-h-0">
              {/* Left side: Set 5 + Footer sections stacked */}
              <div className="flex flex-col gap-2 min-h-0" style={{ width: '290mm' }}>
                {/* Set 5 */}
                <div ref={set5Ref} className="flex">
                  <div className="mr-1">
                    <LeftInfoBox
                      lineup={set5Shown ? set5Data.leftLineup : ['', '', '', '', '', '']}
                      subs={set5Shown ? set5Data.leftSubs : [[], [], [], [], [], []]}
                      serviceRounds={set5Shown ? set5ServiceRoundsLeftTeam_Before : []}
                      isSet5={true}
                    />
                  </div>
                  <div className="flex flex-col items-center justify-center w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                    <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                      <span>S</span>
                      <span>E</span>
                      <span>T</span>
                    </div>
                    <div className="font-black text-sm mt-1">{isBestOf3 ? '3' : '5'}</div>
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
                      startTime={set5Shown ? set5Data.startTime : ''}
                      endTime={set5Shown ? set5Data.endTime : ''}
                      setFinished={set5Shown ? set5Data.setFinished : false}
                      lineupA={set5Shown ? set5Data.leftLineup : ['', '', '', '', '', '']}
                      subsA={set5Shown ? set5Data.leftSubs : [[], [], [], [], [], []]}
                      timeoutsA={set5Shown ? set5Data.leftTimeouts : ['', '']}
                      subsA_Right={set5Shown ? set5Data.leftSubs_After : [[], [], [], [], [], []]}
                      timeoutsA_Right={set5Shown ? set5Data.leftTimeouts_After : ['', '']}
                      lineupB={set5Shown ? set5Data.rightLineup : ['', '', '', '', '', '']}
                      subsB={set5Shown ? set5Data.rightSubs : [[], [], [], [], [], []]}
                      timeoutsB={set5Shown ? set5Data.rightTimeouts : ['', '']}
                      pointsA_Left={set5Shown ? (() => {
                        if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                        const leftTeamPoints = set5TeamOnLeft === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                        return Math.min(leftTeamPoints, 8);
                      })() : 0}
                      markedPointsA_Left={set5Shown ? markedPointsA_Left : []}
                      circledPointsA_Left={set5Shown ? circledPointsA_Left : []}
                      serviceRoundsA_Left={set5Shown ? set5ServiceRoundsLeftTeam_Before : []}
                      pointsB={set5Shown ? (() => {
                        if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                        const rightTeamPoints = set5TeamOnRight === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                        return rightTeamPoints;
                      })() : 0}
                      markedPointsB={set5Shown ? markedPointsB : []}
                      circledPointsB={set5Shown ? circledPointsB : []}
                      serviceRoundsB={set5Shown ? set5ServiceRoundsRightTeam : []}
                      pointsA_Right={set5Shown ? (() => {
                        if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                        const leftTeamPoints = set5TeamOnLeft === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                        return Math.max(leftTeamPoints - 8, 0);
                      })() : 0}
                      markedPointsA_Right={set5Shown ? markedPointsA_Right : []}
                      circledPointsA_Right={set5Shown ? circledPointsA_Right : []}
                      serviceRoundsA_Right={set5Shown ? set5ServiceRoundsLeftTeam_After : []}
                      pointsAtChangeA={set5Shown ? (set5Data.leftScoreAtCourtChange ?? null) : null}
                      struckOff={isStruckOff(5)}
                      positionBoxRef={positionBoxSet5Ref}
                    />
                  </div>
                </div>

                {/* Footer sections row - flex for horizontal control */}
                <div ref={footerRef} className="flex gap-0.5 shrink-0" style={{ height: '8.4cm' }}>
                  {/* Sanctions - narrower width */}
                  <div ref={sanctionsRef} className="flex-col shrink-0" style={{ height: '8.4cm', width: '50mm' }}>
                    <Sanctions items={sanctionsInBox} improperRequests={improperRequests} />
                  </div>

                  {/* Remarks and Approvals stacked - takes remaining space */}
                  <div className="flex-1 flex flex-col gap-1 min-h-0">
                    {/* Remarks - 30% height */}
                    <div ref={remarksRef} className="flex-[3] min-h-0">
                      <Remarks overflowSanctions={overflowSanctions} remarks={typeof match?.remarks === 'string' ? match.remarks : ''} generated={autoRemarks} />
                    </div>
                    {/* Approvals - 70% height */}
                    <div ref={approvalsRef} className="flex-[5] min-h-0">
                      <Approvals
                        officials={officials}
                        match={match}
                        sets={sets}
                        teamAKey={teamAKey}
                        lineJudges={[1, 2, 3, 4].map(n => {
                          const lj = findOfficial(officials, `line judge ${n}`);
                          return lj ? (lj.name || formatPersonName(lj.lastName, lj.firstName)) : '';
                        })}
                      />
                    </div>
                  </div>

                  {/* Results - adjust flex-[x] to change width proportion */}
                  <div ref={resultsRef} className="flex-[0.67] flex flex-col shrink-0" style={{ height: '8.4cm' }}>
                    <Results
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
              <div className="flex gap-0.5 shrink-0" style={{ width: '110mm', height: '13.5cm', maxWidth: '110mm' }}>
                <div ref={rosterARef} className="flex-1 min-w-0">
                  <Roster
                    team={homeShortName}
                    side={teamAKey === 'home' ? 'A' : 'B'}
                    players={formatPlayers(homePlayers)}
                    benchStaff={asArray(match?.bench_home)}
                    preGameCaptainSignature={match?.homeCaptainSignature}
                    preGameCoachSignature={match?.homeCoachSignature}
                    coinTossConfirmed={coinTossConfirmed}
                    isHome={true}
                  />
                </div>
                <div ref={rosterBRef} className="flex-1 min-w-0">
                  <Roster
                    team={awayShortName}
                    side={teamAKey === 'away' ? 'A' : 'B'}
                    players={formatPlayers(awayPlayers)}
                    benchStaff={asArray(match?.bench_away)}
                    preGameCaptainSignature={match?.awayCaptainSignature}
                    preGameCoachSignature={match?.awayCoachSignature}
                    coinTossConfirmed={coinTossConfirmed}
                    isHome={false}
                  />
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

    </>
  );
};

export default App;