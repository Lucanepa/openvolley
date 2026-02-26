import { Player, LCSData, LiberoSetData, LiberoReplacement, LiberoRedesignation } from '../types_scoresheet';

export function extractLiberoData(
  events: any[],
  sets: any[],
  teamAKey: 'home' | 'away',
  teamAPlayers: Player[],
  teamBPlayers: Player[]
): LCSData {
  const teamBKey = teamAKey === 'home' ? 'away' : 'home';

  // Identify liberos per team
  const teamALiberos = teamAPlayers
    .filter(p => p.libero === 'libero1' || p.libero === 'libero2')
    .map(p => ({ number: Number(p.number), type: p.libero as string }))
    .sort((a, b) => (a.type === 'libero1' ? -1 : 1));

  const teamBLiberos = teamBPlayers
    .filter(p => p.libero === 'libero1' || p.libero === 'libero2')
    .map(p => ({ number: Number(p.number), type: p.libero as string }))
    .sort((a, b) => (a.type === 'libero1' ? -1 : 1));

  const redesignations: LiberoRedesignation[] = [];
  const lcsSetData: LiberoSetData[] = [];

  // Process each set (1-5, setIndex is 1-based in events)
  for (let setNumber = 1; setNumber <= 5; setNumber++) {
    const isSet5 = setNumber === 5;

    // Filter events for this set (setIndex is 1-based)
    const setEvents = events
      .filter(e => e.setIndex === setNumber)
      .sort((a: any, b: any) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });

    let homeScore = 0;
    let awayScore = 0;
    let courtChangeHappened = false;

    const teamAReps: LiberoReplacement[] = [];
    const teamBReps: LiberoReplacement[] = [];
    const teamAReps_After: LiberoReplacement[] = [];
    const teamBReps_After: LiberoReplacement[] = [];

    setEvents.forEach((event: any) => {
      if (event.type === 'point') {
        const scoringTeam = event.payload?.team as 'home' | 'away';
        if (scoringTeam === 'home') homeScore++;
        else awayScore++;

        if (isSet5 && !courtChangeHappened && (homeScore >= 8 || awayScore >= 8)) {
          courtChangeHappened = true;
        }
      } else if (event.type === 'libero_entry') {
        const team = event.payload?.team as 'home' | 'away';
        const isTeamA = team === teamAKey;
        const teamScore = team === 'home' ? homeScore : awayScore;
        const oppScore = team === 'home' ? awayScore : homeScore;

        const rep: LiberoReplacement = {
          liberoNumber: Number(event.payload?.liberoIn),
          replacedPlayer: Number(event.payload?.playerOut),
          score: `${teamScore}:${oppScore}`,
        };

        if (isTeamA) {
          if (isSet5 && courtChangeHappened) teamAReps_After.push(rep);
          else teamAReps.push(rep);
        } else {
          if (isSet5 && courtChangeHappened) teamBReps_After.push(rep);
          else teamBReps.push(rep);
        }
      } else if (event.type === 'libero_exit') {
        const team = event.payload?.team as 'home' | 'away';
        const isTeamA = team === teamAKey;
        const teamScore = team === 'home' ? homeScore : awayScore;
        const oppScore = team === 'home' ? awayScore : homeScore;

        const rep: LiberoReplacement = {
          liberoNumber: Number(event.payload?.liberoOut),
          replacedPlayer: Number(event.payload?.playerIn),
          score: `${teamScore}:${oppScore}`,
        };

        if (isTeamA) {
          if (isSet5 && courtChangeHappened) teamAReps_After.push(rep);
          else teamAReps.push(rep);
        } else {
          if (isSet5 && courtChangeHappened) teamBReps_After.push(rep);
          else teamBReps.push(rep);
        }
      } else if (event.type === 'libero_exchange') {
        const team = event.payload?.team as 'home' | 'away';
        const isTeamA = team === teamAKey;
        const teamScore = team === 'home' ? homeScore : awayScore;
        const oppScore = team === 'home' ? awayScore : homeScore;
        const score = `${teamScore}:${oppScore}`;

        // Exchange = one libero leaves, another enters at same position
        const repOut: LiberoReplacement = {
          liberoNumber: Number(event.payload?.liberoOut),
          replacedPlayer: Number(event.payload?.playerNumber || event.payload?.liberoIn),
          score,
          isExchange: true,
        };
        const repIn: LiberoReplacement = {
          liberoNumber: Number(event.payload?.liberoIn),
          replacedPlayer: Number(event.payload?.playerNumber || event.payload?.liberoOut),
          score,
          isExchange: true,
        };

        if (isTeamA) {
          if (isSet5 && courtChangeHappened) {
            teamAReps_After.push(repOut);
            teamAReps_After.push(repIn);
          } else {
            teamAReps.push(repOut);
            teamAReps.push(repIn);
          }
        } else {
          if (isSet5 && courtChangeHappened) {
            teamBReps_After.push(repOut);
            teamBReps_After.push(repIn);
          } else {
            teamBReps.push(repOut);
            teamBReps.push(repIn);
          }
        }
      } else if (event.type === 'libero_redesignation') {
        const team = event.payload?.team as 'home' | 'away';
        const teamScore = team === 'home' ? homeScore : awayScore;
        const oppScore = team === 'home' ? awayScore : homeScore;

        redesignations.push({
          team: team === teamAKey ? 'A' : 'B',
          outNumber: Number(event.payload?.unableLiberoNumber),
          inNumber: Number(event.payload?.newLiberoNumber),
          setNumber,
          score: `${teamScore}:${oppScore}`,
        });
      }
    });

    const setData: LiberoSetData = {
      setNumber,
      teamAReplacements: teamAReps,
      teamBReplacements: teamBReps,
    };

    if (isSet5) {
      setData.teamAReplacements_After = teamAReps_After;
      setData.teamBReplacements_After = teamBReps_After;
    }

    lcsSetData.push(setData);
  }

  return {
    teamALiberos,
    teamBLiberos,
    sets: lcsSetData,
    redesignations,
  };
}
