/**
 * The whole sheet as it is drawn, from one match (pure): team labels and
 * names, the five set grids (utils/setModel), RESULT, SANCTIONS, REMARKS,
 * the match times, the rosters and the Libero control sheet. App_Scoresheet
 * builds it once per data change (useMemo) and the drawn page only re-renders
 * when it changes: a zoom, a turn, a notice or the PDF-busy flag leave it alone
 * (review 2026-11-16, F2). Moved here from App_Scoresheet as it was.
 */
import { SANCTION_ROWS } from '../components/FooterSection';
import { remarksSignaturesOf } from '../../src/domain/remarksSignatures';
import type { Player, SanctionRecord } from '../types_scoresheet';
import { asArray, displayShortName, findOfficial, formatDob, formatHoursMinutes, formatClockHoursMinutes, formatPersonName, idHeadingOf, normalizeOfficials } from './sheetFormat';
import { extractLiberoData, rosterLiberos } from './extractLiberoData';
import {
  countAllSubstitutions,
  compareEventsBySeq,
  displaySetNumber,
  getScoreBeforeEvent,
  isDefaultSet as isDefaultSetOf,
  getSet5LeftTeamLabel,
  getFirstServeTeamKey,
  consistencyWarnings
} from './scoresheetModel';
import { splitSet5Rounds, type ServiceRound } from './serviceRounds';
import { isMatchOverStatus } from '../../src/domain/matchEnd.js';
import { courtSwitchPointOf, setTargetsOf } from '../../src/domain/rules.js';
import { sponsorsOf, withSponsorMark } from '../../src/domain/sponsors.js';
import { sheetAutoRemarks } from './sheetRemarks';
import { isoOf, setDurationMinutes, setEndMs, setStartMs } from './matchTimes';
import { buildSetData, eventsBySet, type SetContext } from './setModel';
import type { MatchData } from './matchData';

export interface SheetModelOptions {
  /** LFP marks printed (the match's own LFP tracking, else this device's). */
  lfpShown: boolean;
  /** Remarks the caller adds after the sheet's own (Rebuild PDF). */
  extraRemarks?: string[];
}

export function buildSheetModel(data: MatchData, { lfpShown, extraRemarks }: SheetModelOptions) {
  const match: any = data.match;
  const homeTeam: any = data.homeTeam;
  const awayTeam: any = data.awayTeam;
  const homePlayers = data.homePlayers;
  const awayPlayers = data.awayPlayers;
  const sets: any[] = data.sets;
  const events: any[] = data.events;
  // Officials: the array, the older role-keyed object or snake_case names (never throws)
  const officials = normalizeOfficials(match?.officials);

  // Players as the sheet prints them, sorted by shirt number (the roster's 14 rows;
  // field-spec 3). Robust to a missing list (an imported JSON without players).
  // LFP marks print only where LFP tracking is on (owner 2026-11-16): lfpShown
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
        isLfp: lfpShown && !!(p.isLfp || p.is_lfp),
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
  // Also treat as confirmed if match is live/ended/approved/final (coin toss must have been completed to reach these states)
  const coinTossFieldsSet = match?.coinTossTeamA !== null &&
    match?.coinTossTeamA !== undefined &&
    match?.coinTossTeamB !== null &&
    match?.coinTossTeamB !== undefined &&
    match?.coinTossServeA !== null &&
    match?.coinTossServeA !== undefined &&
    match?.coinTossServeB !== null &&
    match?.coinTossServeB !== undefined;
  // A closed match loaded from the cloud keeps status 'approved' and may lack
  // coinTossServeB: its confirmed flag or the status says the toss was done
  const coinTossConfirmed = coinTossFieldsSet ||
    match?.coinTossConfirmed === true || match?.coin_toss_confirmed === true ||
    match?.status === 'live' || isMatchOverStatus(match?.status);

  const teamAPlayers = formatPlayers(teamAKey === 'home' ? homePlayers : awayPlayers);
  const teamBPlayers = formatPlayers(teamBKey === 'home' ? homePlayers : awayPlayers);

  // Sponsors on clothing (src/domain/sponsors.js): a marked match prints
  // " (+)" / " (-)" after every team name on the sheet, whatever this device's
  // option says (the match decides). One place: every name below goes through it.
  const sponsors = sponsorsOf(match);
  const markOf = (team: 'home' | 'away', name: unknown): string =>
    withSponsorMark(name, team === 'home' ? sponsors.home : sponsors.away, sponsors.marked);
  // The header's (and the Libero sheet's) team rows with the marked names
  const sheetHomeTeam: any = homeTeam && sponsors.marked ? { ...homeTeam, name: markOf('home', homeTeam.name) } : homeTeam;
  const sheetAwayTeam: any = awayTeam && sponsors.marked ? { ...awayTeam, name: markOf('away', awayTeam.name) } : awayTeam;

  // Use full team names
  const teamAName = markOf(teamAKey, (teamAKey === 'home' ? homeTeam?.name : awayTeam?.name) || '');
  const teamBName = markOf(teamBKey, (teamBKey === 'home' ? homeTeam?.name : awayTeam?.name) || '');

  // Short names for the set boxes, the rosters and the result table: the stored
  // short name, else (empty or a HOME / AWAY placeholder) the team's full name
  const homeShortName = markOf('home', displayShortName(match?.homeShortName, homeTeam?.name ?? match?.homeTeamName));
  const awayShortName = markOf('away', displayShortName(match?.awayShortName, awayTeam?.name ?? match?.awayTeamName));
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

  // Where the teams change courts in the deciding set: 8 of 15, or half of the
  // match's own deciding target rounded up (a Global match's setTargets, the
  // Scoreboard's rules.courtSwitchPointOf)
  const set5SwitchAt: number = courtSwitchPointOf(setTargetsOf(match));

  // Compute Libero Control Sheet data from events
  const lcsData = extractLiberoData(events || [], sets || [], teamAKey as 'home' | 'away', teamAPlayers, teamBPlayers, set5SwitchAt);

  // Check if LCS button should be visible: at least one team has a libero AND there is libero activity
  const hasLiberoActivity = (() => {
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
  })();

  // Always get data for all sets (will be empty if not played)
  const setCtx: SetContext = { match, sets, teamAKey, teamBKey, set5SwitchAt, eventsOfSet: eventsBySet(events) };
  const set1Data = buildSetData(setCtx, 1, false);
  const set2Data = buildSetData(setCtx, 2, true);
  const set3Data = buildSetData(setCtx, 3, false);
  const set4Data = buildSetData(setCtx, 4, true);

  // Sets won, match over (also needed to leave the unused grids empty)
  const bestOf = match?.bestOf === 3 ? 3 : 5;
  const neededToWin = bestOf === 3 ? 2 : 3;
  const finishedSets = sets.filter(s => s?.finished);
  const pointsOf = (s: any, key: 'home' | 'away') => (key === 'home' ? (s?.homePoints || 0) : (s?.awayPoints || 0));
  const teamASetsWon = finishedSets.filter(s => pointsOf(s, teamAKey) > pointsOf(s, teamBKey)).length;
  const teamBSetsWon = finishedSets.filter(s => pointsOf(s, teamBKey) > pointsOf(s, teamAKey)).length;
  const isMatchFinished = teamASetsWon >= neededToWin || teamBSetsWon >= neededToWin;

  // A set awarded by default / forfeit without a single rally (scoresheetModel).
  // Its grid stays empty, not struck off (owner 2026-10-21); its RESULT row and
  // the remark say what was awarded; no start / end time, no duration (field-spec 11).
  const isDefaultSet = (setIndex: number): boolean => isDefaultSetOf(sets, events, setIndex);
  const wasPlayed = (setIndex: number): boolean => {
    const info = sets.find(s => s?.index === setIndex);
    return !!info && (info.homePoints > 0 || info.awayPoints > 0 || !!info.startTime || info.finished === true);
  };
  // Drawn empty: a set awarded by default, and once the result is known the grids
  // that were never played (best-of-3: sets 3 and 4 unless they were played,
  // i.e. the format was changed during the match) (field-spec 6, 11).
  // Nothing is struck off: a set awarded by default keeps its RESULT row (the
  // awarded points), the unplayed grids and their RESULT rows are left blank
  // (owner 2026-10-20, 2026-10-21).
  const isEmptyGrid = (setIndex: number): boolean => {
    if (isDefaultSet(setIndex)) return true;
    if (bestOf === 3 && (setIndex === 3 || setIndex === 4)) return !wasPlayed(setIndex);
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
  // For best-of-3: Sets 3 and 4 are not played (deciding set uses Set 5 tiebreak format),
  // so they remain blank — no team labels, S/R, or X. A set 3 or 4 that was played
  // all the same (format changed during the match) is printed, never dropped, and
  // the sheet warns about it (consistencyWarnings); the sets keep their own numbers.
  const isBestOf3 = bestOf === 3;
  const bestOf3ExtraSets = isBestOf3 && (wasPlayed(3) || wasPlayed(4));
  const shouldShowSet1 = coinTossConfirmed;
  const shouldShowSet2 = isSetFinished(1);
  const shouldShowSet3 = isBestOf3 ? wasPlayed(3) : isSetFinished(2);

  // Calculate set wins to determine if Set 4 should be displayed
  // Set 4 should only be filled if both teams have won at least one set
  // For best-of-3: Set 4 is never played, always blank
  // Set 4 should only be displayed if both teams have won at least one set
  // For best-of-3: Set 4 is never played, always blank
  const shouldShowSet4 = isBestOf3 ? wasPlayed(4) : (teamASetsWon >= 1 && teamBSetsWon >= 1);

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
  const set5Data = hasSet5CoinToss ? buildSetData(setCtx, 5, set5LeftTeamIsB) : null;

  // Determine which team actually changes sides (the one on the left)
  const set5TeamOnLeft = set5LeftTeamIsB ? teamBKey : teamAKey;
  const set5TeamOnRight = set5LeftTeamIsB ? teamAKey : teamBKey;

  // First server of the deciding set - one value for the service tracker, S/R cross and set data
  const set5FirstServeTeamKey = getFirstServeTeamKey(5, match, teamAKey, teamBKey);
  // The deciding set is drawn once its toss is known or it started, unless it was
  // awarded by default (then its grid is only struck off)
  const set5Shown = !!(hasSet5CoinToss && set5Data && !isEmptyGrid(5));

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

  // Remarks the sheet writes itself: a default / an incomplete team (field-spec 8, 11),
  // and in an older match every change made after the match ("Corrected after
  // the match: ...") and a rebuilt sheet's line; in a match with technical
  // remarks those two are not printed (src/domain/technicalRemarks.js)
  const autoRemarks = sheetAutoRemarks({ sets, events, teamAKey, bestOf, match, extraRemarks });
  // Consistency checks (field-spec 12.2): listed above the sheet, never printed
  const sheetWarnings = consistencyWarnings({ sets, events, teamAKey, homePlayers, awayPlayers, bestOf });

  // Calculate set results for Results section
  const calculateSetResults = () => {
    const results = [];
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets?.find(s => s.index === setNum);
      const setEvents = setCtx.eventsOfSet(setNum);

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
      const duration = minutes !== null ? `${minutes}'` : '';

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
      .sort(compareEventsBySeq);

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
  // courts (points 1-8, or 1 to set5SwitchAt), panel 2 = the right team, panel 3 = the left team after the
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

  // The rosters (HOME always left, AWAY right) and their LIBERO boxes
  const homeRows = formatPlayers(homePlayers);
  const awayRows = formatPlayers(awayPlayers);
  const homeLiberos = rosterLiberos(homeRows, events, 'home');
  const awayLiberos = rosterLiberos(awayRows, events, 'away');
  const lineJudges = [1, 2, 3, 4].map(n => {
    const lj = findOfficial(officials, `line judge ${n}`);
    return lj ? (lj.name || formatPersonName(lj.lastName, lj.firstName)) : '';
  });
  const remarks = typeof match?.remarks === 'string' ? match.remarks : '';
  const remarksSignatures = remarksSignaturesOf(match?.remarksSignatures);
  const idHeading = idHeadingOf(match);

  // The deciding set's points: the left team's whole score (panels 1 and 3) and
  // the right team's (panel 2), 0 until the set started
  const set5Started = !!set5Info && !!(set5Info.homePoints || set5Info.awayPoints || set5Info.startTime);
  const set5PointsOf = (key: 'home' | 'away') => (set5Started ? (key === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0);
  const set5FinalScoreLeft = set5PointsOf(set5TeamOnLeft);
  const set5FinalScoreRight = set5PointsOf(set5TeamOnRight);

  // Empty grids, once per set
  const emptyGrid: Record<number, boolean> = { 1: isEmptyGrid(1), 2: isEmptyGrid(2), 3: isEmptyGrid(3), 4: isEmptyGrid(4), 5: isEmptyGrid(5) };

  return {
    match, homeTeam, awayTeam, sets, events, officials,
    teamAKey, teamBKey, coinTossConfirmed, bestOf, isBestOf3, bestOf3ExtraSets,
    sheetHomeTeam, sheetAwayTeam, teamAName, teamBName, homeShortName, awayShortName, teamAShortName, teamBShortName,
    set1ServeIsA, set5SwitchAt,
    lcsData, hasLiberoActivity, sheetWarnings,
    set1Data, set2Data, set3Data, set4Data, emptySetData, emptyGrid,
    shouldShowSet1, shouldShowSet2, shouldShowSet3, shouldShowSet4,
    set5Data, set5Shown, set5LeftTeamIsB, set5FirstServeTeamKey, set5TeamOnLeft, set5FinalScoreLeft, set5FinalScoreRight,
    markedPointsA_Left, markedPointsA_Right, markedPointsB, circledPointsA_Left, circledPointsA_Right, circledPointsB,
    set5ServiceRoundsLeftTeam_Before, set5ServiceRoundsLeftTeam_After, set5ServiceRoundsRightTeam,
    autoRemarks, remarks, remarksSignatures, sanctionsInBox, overflowSanctions, improperRequests,
    setResults, matchStart, matchEndFinal, matchDuration, winner, result,
    homeRows, awayRows, homeLiberos, awayLiberos, lineJudges, idHeading
  };
}

export type SheetModel = ReturnType<typeof buildSheetModel>;
