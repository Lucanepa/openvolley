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
    
    return {
      startTime: hasBeenPlayed && setInfo?.startTime ? new Date(setInfo.startTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '',
      endTime: hasBeenPlayed && setInfo?.endTime ? new Date(setInfo.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '',
      leftLineup: [],
      rightLineup: [],
      leftPoints,
      rightPoints,
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
  const set5Data = sets?.find(s => s.index === 5);

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
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm shadow"
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

      <div className="min-h-screen bg-gray-100 p-2 flex justify-center print:p-0 print:bg-white print:h-[297mm] print:w-[420mm] print:flex print:items-start print:justify-start print:overflow-hidden">
        <div 
          ref={containerRef}
          className="w-[420mm] h-[297mm] bg-white shadow-xl print:shadow-none p-2 print:p-0 print:overflow-hidden print:m-0 print:w-[420mm] print:h-[297mm] print:box-border relative print:page-break-inside-avoid" 
          style={{ boxSizing: 'border-box' }}
        >
        <div className="h-[297mm] print:overflow-hidden">
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
            <div className="flex gap-1">
                  <div
                    className="border border-black bg-white shrink-0"
                    style={{ width: '65mm', height: '5.4cm', borderRightWidth: 0 }}
                  ></div>
                <div className="flex gap-1 flex-1">
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
            <div className="flex gap-1 mt-1">
                      <div
                        className="border border-black bg-white shrink-0"
                        style={{ width: '65mm', height: '5.4cm', borderRightWidth: 0 }}
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
                <div className="flex flex-col gap-2 min-h-0" style={{ width: '310mm' }}>
                    {/* Set 5 */}
                    <div ref={set5Ref} className="flex">
                        <div
                          className="border border-black bg-white shrink-0 mr-1"
                          style={{ width: '65mm', height: '4.9cm', borderRightWidth: 0 }}
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
                                startTime={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) && set5Data.startTime ? new Date(set5Data.startTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''}
                                endTime={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) && set5Data.endTime ? new Date(set5Data.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''}
                                pointsA_Left={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) ? (teamAKey === 'home' ? (set5Data.homePoints || 0) : (set5Data.awayPoints || 0)) : 0}
                                pointsB={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) ? (teamBKey === 'home' ? (set5Data.homePoints || 0) : (set5Data.awayPoints || 0)) : 0}
                                pointsA_Right={0}
                                pointsAtChange=""
                                positionBoxRef={positionBoxSet5Ref}
                            />
                        </div>
                    </div>
                    
                    {/* Footer sections row - flex for horizontal control */}
                    <div ref={footerRef} className="flex gap-0.5 shrink-0" style={{ height: '8.4cm' }}>
                        {/* Sanctions - adjust flex-[x] to change width proportion */}
                        <div ref={sanctionsRef} className="flex-[1] flex-col shrink-0" style={{ height: '8.4cm' }}>
                            <Sanctions items={sanctions} />
                        </div>
                        
                        {/* Remarks and Approvals stacked - adjust flex-[x] for width */}
                        <div className="flex-[2.5] flex flex-col gap-2 min-h-0">
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
                        <div ref={resultsRef} className="flex-[2] flex flex-col shrink-0" style={{ height: '8.4cm' }}>
                            <Results teamAShortName={teamAShortName} teamBShortName={teamBShortName} />
                        </div>
                    </div>
                </div>
                
                {/* Right side: Rosters spanning full height */}
                <div className="flex gap-0.5 shrink-0" style={{ width: '110mm', height: '13.5cm' }}>
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
