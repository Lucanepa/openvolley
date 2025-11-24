import React, { useRef, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { StandardSet } from './components/StandardSet';
import { SetFive } from './components/SetFive';
import { Sanctions, Results, Approvals, Roster, Remarks } from './components/FooterSection';
import { Player, SanctionRecord } from './types_scoresheet';

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
}

const App: React.FC<AppScoresheetProps> = ({ matchData }) => {
  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, sanctions = [] } = matchData;
  
  // Helper function to format players for scoresheet
  const formatPlayers = (players: any[]): Player[] => {
    return players.map(p => ({
      number: String(p.number || ''),
      name: p.name || `${p.lastName || ''} ${p.firstName || ''}`.trim(),
      firstName: p.firstName,
      lastName: p.lastName,
      dob: p.dob,
      libero: p.libero,
      isCaptain: p.isCaptain,
      license: p.license || '',
      role: p.role
    }));
  };
  
  // Determine team labels (A or B) based on coin toss
  const teamAKey = match?.coinTossTeamA || 'home';
  const teamBKey = teamAKey === 'home' ? 'away' : 'home';
  
  const teamAPlayers = formatPlayers(teamAKey === 'home' ? homePlayers : awayPlayers);
  const teamBPlayers = formatPlayers(teamBKey === 'home' ? homePlayers : awayPlayers);
  
  // Use full team names
  const teamAName = (teamAKey === 'home' ? homeTeam?.name : awayTeam?.name) || (teamAKey === 'home' ? 'Home' : 'Away');
  const teamBName = (teamBKey === 'home' ? homeTeam?.name : awayTeam?.name) || (teamBKey === 'home' ? 'Home' : 'Away');
  
  // Use short names for set labels and rosters
  const teamAShortName = (teamAKey === 'home' ? match?.homeShortName : match?.awayShortName) || teamAName;
  const teamBShortName = (teamBKey === 'home' ? match?.homeShortName : match?.awayShortName) || teamBName;
  
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
    const setEvents = events?.filter(e => e.setIndex === setNumber) || [];
    const homeLineupEvent = setEvents.find(e => e.type === 'lineup' && e.payload?.team === 'home');
    const awayLineupEvent = setEvents.find(e => e.type === 'lineup' && e.payload?.team === 'away');
    
    // Extract lineup arrays (positions I-VI)
    const homeLineupObj = homeLineupEvent?.payload?.lineup || {};
    const awayLineupObj = awayLineupEvent?.payload?.lineup || {};
    const positions = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    const homeLineupArray = positions.map(pos => homeLineupObj[pos] ? String(homeLineupObj[pos]) : '');
    const awayLineupArray = positions.map(pos => awayLineupObj[pos] ? String(awayLineupObj[pos]) : '');
    
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
    let homeScore = 0;
    let awayScore = 0;
    
    pointEvents.forEach(event => {
      if (event.payload?.team === 'home') {
        homeScore++;
        homeMarkedPoints.push(homeScore);
      } else if (event.payload?.team === 'away') {
        awayScore++;
        awayMarkedPoints.push(awayScore);
      }
    });
    
    // Determine which team's points go left and right based on team assignments and swapping
    const leftMarkedPoints = !isSwapped 
      ? (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    const rightMarkedPoints = !isSwapped
      ? (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    // Determine start time
    let startTimeStr = '';
    if (setNumber === 1 && match?.scheduledAt) {
      // Set 1 uses match start time
      startTimeStr = new Date(match.scheduledAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    } else if (hasBeenPlayed && setInfo?.startTime) {
      // Other sets use their recorded start time
      startTimeStr = new Date(setInfo.startTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    }
    
    return {
      startTime: startTimeStr,
      endTime: hasBeenPlayed && setInfo?.endTime ? new Date(setInfo.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '',
      leftLineup,
      rightLineup,
      leftPoints,
      rightPoints,
      leftMarkedPoints,
      rightMarkedPoints,
      leftTimeouts: ['', ''] as [string, string],
      rightTimeouts: ['', ''] as [string, string],
      leftSubs: [[], [], [], [], [], []],
      rightSubs: [[], [], [], [], [], []]
    };
  };

  // Always get data for all sets (will be empty if not played)
  const set1Data = getSetData(1, false);
  const set2Data = getSetData(2, true);
  const set3Data = getSetData(3, false);
  const set4Data = getSetData(4, true);
  const set5Info = sets?.find(s => s.index === 5);
  
  // Get Set 5 marked points (special handling for 3 panels)
  const set5Events = events?.filter(e => e.setIndex === 5) || [];
  const set5PointEvents = set5Events
    .filter(e => e.type === 'point')
    .sort((a, b) => {
      const aSeq = a.seq || 0;
      const bSeq = b.seq || 0;
      if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
      return new Date(a.ts).getTime() - new Date(b.ts).getTime();
    });
  
  const set5MarkedPointsHome: number[] = [];
  const set5MarkedPointsAway: number[] = [];
  let set5HomeScore = 0;
  let set5AwayScore = 0;
  
  set5PointEvents.forEach(event => {
    if (event.payload?.team === 'home') {
      set5HomeScore++;
      set5MarkedPointsHome.push(set5HomeScore);
    } else if (event.payload?.team === 'away') {
      set5AwayScore++;
      set5MarkedPointsAway.push(set5AwayScore);
    }
  });
  
  // Team A marked points split at court change (8 points)
  const set5MarkedPointsTeamA = teamAKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  const set5MarkedPointsTeamB = teamBKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  
  const markedPointsA_Left = set5MarkedPointsTeamA.filter(p => p <= 8); // Points 1-8 on left
  const markedPointsA_Right = set5MarkedPointsTeamA.filter(p => p > 8).map(p => p - 8); // Points 9+ become 1, 2, 3... on right
  const markedPointsB = set5MarkedPointsTeamB; // Team B doesn't change sides

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
  



  return (
    <>
      {/* Web Only Controls - Outside print area */}
      <div className="mb-2 flex justify-center items-center print:hidden w-full">
          <div className="space-x-2">
              <button 
                  onClick={() => window.print()} 
                  className="bg-blue-500 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm shadow"
              >
                  Print PDF
              </button>
              <button 
                  onClick={() => window.close()} 
                  className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded text-sm shadow"
              >
                  Close
              </button>
          </div>
      </div>

      <div className="min-h-screen bg-gray-100 p-2 flex justify-center print:p-0 print:bg-white print:h-[297mm] print:w-[420mm] print:flex print:items-center print:justify-center print:overflow-hidden">
        <div 
          ref={containerRef}
          className="w-[410mm] h-[287mm] bg-white shadow-xl print:shadow-none p-3 print:p-0 print:overflow-hidden print:m-auto print:w-[410mm] print:h-[287mm] print:box-border relative print:page-break-inside-avoid" 
          style={{ boxSizing: 'border-box' }}
        >
        <div className="h-full print:overflow-hidden" style={{ padding: '5mm 5mm 5mm 5mm' }}>
            <div ref={headerRef}>
              <Header 
                match={match}
                homeTeam={homeTeam}
                awayTeam={awayTeam}
                teamAName={teamAName}
                teamBName={teamBName}
              />
            </div>
            
            {/* Row 1: Sets 1 and 2 - Full Width 50/50 */}
            <div className="flex">
                  <div
                    className="bg-white shrink-0"
                    style={{ width: '50mm', height: '5.3cm', borderRightWidth: 0 }}
                  ></div>
                <div className="flex flex-1 gap-1">
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
                                teamNameLeft={teamAShortName}
                                teamNameRight={teamBShortName}
                                firstServeTeamA={match?.coinTossServeA}
                                positionBoxRef={positionBoxSet1Ref}
                                {...set1Data}
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
                                teamNameLeft=""
                                teamNameRight=""
                                {...set2Data}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Row 2: Sets 3 and 4 - Full Width 50/50 */}
            <div className="flex mt-1">
                      <div
                        className=" bg-white shrink-0"
                        style={{ width: '50mm', height: '5.3cm', borderRightWidth: 0 }}
                      ></div>
                <div className="flex gap-1 flex-1">
                    <div ref={set3Ref} className="flex flex-1">
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">3</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={3} 
                                teamNameLeft=""
                                teamNameRight=""
                                {...set3Data}
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
                            <div className="font-black text-sm mt-1">4</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={4} 
                                isSwapped={true} 
                                teamNameLeft=""
                                teamNameRight=""
                                {...set4Data}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Rows 3-4: Set 5 + Footer sections on left, Rosters spanning on right */}
            <div className="flex gap-1 mt-1 items-stretch print:flex-1 print:min-h-0">
                {/* Left side: Set 5 + Footer sections stacked */}
                <div className="flex flex-col gap-2 min-h-0" style={{ width: '295mm' }}>
                    {/* Set 5 */}
                    <div ref={set5Ref} className="flex">
                        <div
                          className=" bg-white shrink-0 mr-1"
                          style={{ width: '49mm', height: '4.8cm', borderRightWidth: 0 }}
                        ></div>
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">5</div>
                        </div>
                        <div className="flex-1">
                            <SetFive 
                                teamNameA=""
                                teamNameB=""
                                startTime={(set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) && set5Info.startTime ? new Date(set5Info.startTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''}
                                endTime={(set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) && set5Info.endTime ? new Date(set5Info.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''}
                                pointsA_Left={Math.min((set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamAKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0, 8)}
                                markedPointsA_Left={markedPointsA_Left}
                                pointsB={(set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamBKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0}
                                markedPointsB={markedPointsB}
                                pointsA_Right={Math.max((set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamAKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0 - 8, 0)}
                                markedPointsA_Right={markedPointsA_Right}
                                pointsAtChange=""
                                positionBoxRef={positionBoxSet5Ref}
                            />
                        </div>
                    </div>
                    
                    {/* Footer sections row - flex for horizontal control */}
                    <div ref={footerRef} className="flex gap-0.5 shrink-0" style={{ height: '8.4cm' }}>
                        {/* Sanctions - narrower width */}
                        <div ref={sanctionsRef} className="flex-col shrink-0" style={{ height: '8.4cm', width: '50mm' }}>
                            <Sanctions items={sanctions} />
                        </div>
                        
                        {/* Remarks and Approvals stacked - takes remaining space */}
                        <div className="flex-1 flex flex-col gap-2 min-h-0">
                            {/* Remarks - 30% height */}
                            <div ref={remarksRef} className="flex-[3] min-h-0">
                                <Remarks />
                            </div>
                            {/* Approvals - 70% height */}
                            <div ref={approvalsRef} className="flex-[5] min-h-0">
                                <Approvals officials={match?.officials} />
                            </div>
                        </div>
                        
                        {/* Results - adjust flex-[x] to change width proportion */}
                        <div ref={resultsRef} className="flex-[0.67] flex flex-col shrink-0" style={{ height: '8.4cm' }}>
                            <Results teamAShortName={teamAShortName} teamBShortName={teamBShortName} />
                        </div>
                    </div>
                </div>
                
                {/* Right side: Rosters spanning full height */}
                <div className="flex gap-0.5 shrink-0" style={{ width: '110mm', height: '13.5cm', maxWidth: '110mm' }}>
                    <div ref={rosterARef} className="flex-1 min-w-0">
                        <Roster 
                          team={teamAShortName} 
                          side="A" 
                          players={teamAPlayers}
                          benchStaff={teamAKey === 'home' ? match?.bench_home : match?.bench_away}
                        />
                    </div>
                    <div ref={rosterBRef} className="flex-1 min-w-0">
                        <Roster 
                          team={teamBShortName} 
                          side="B" 
                          players={teamBPlayers}
                          benchStaff={teamBKey === 'home' ? match?.bench_home : match?.bench_away}
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
