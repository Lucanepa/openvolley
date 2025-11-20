import React from 'react';
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

  return (
    <div className="min-h-screen bg-gray-100 p-2 flex justify-center print:p-0 print:bg-white">
      <div className="w-[1160px] bg-white shadow-xl print:shadow-none p-2 print:w-full print:max-w-none print:p-0 print:scale-[0.95] print:origin-top-left">
        
        {/* Web Only Controls */}
        <div className="mb-2 flex justify-between items-center print:hidden">
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

        <div className="flex flex-col gap-1">
            <Header 
              match={match}
              homeTeam={homeTeam}
              awayTeam={awayTeam}
              teamAName={teamAName}
              teamBName={teamBName}
            />
            
            {/* Grid Layout: Sets 1-4 - Always show all sets */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <h3 className="font-black text-sm mb-0.5 text-center uppercase tracking-widest">Set 1</h3>
                    <StandardSet 
                        setNumber={1} 
                        teamNameLeft={teamAShortName}
                        teamNameRight={teamBShortName}
                        firstServeTeamA={match?.coinTossServeA}
                        {...set1Data}
                    />
                </div>
                <div>
                    <h3 className="font-black text-sm mb-0.5 text-center uppercase tracking-widest">Set 2</h3>
                    <StandardSet 
                        setNumber={2} 
                        isSwapped={true} 
                        teamNameLeft=""
                        teamNameRight=""
                        {...set2Data}
                    />
                </div>
                <div>
                    <h3 className="font-black text-sm mb-0.5 text-center uppercase tracking-widest">Set 3</h3>
                    <StandardSet 
                        setNumber={3} 
                        teamNameLeft=""
                        teamNameRight=""
                        {...set3Data}
                    />
                </div>
                <div>
                    <h3 className="font-black text-sm mb-0.5 text-center uppercase tracking-widest">Set 4</h3>
                    <StandardSet 
                        setNumber={4} 
                        isSwapped={true} 
                        teamNameLeft=""
                        teamNameRight=""
                        {...set4Data}
                    />
                </div>
            </div>

            {/* Bottom Section: Split into Set 5/Footer area and Rosters */}
            <div className="flex items-stretch gap-2 mt-1">
                {/* LEFT COLUMN: Set 5 + Footer Grid (~70% width) */}
                <div className="w-[70%] flex flex-col gap-2 shrink-0">
                    {/* Set 5 - Always show */}
                    <div>
                        <h3 className="font-black text-sm mb-0.5 text-center uppercase tracking-widest">Set 5</h3>
                        <SetFive 
                            teamNameA=""
                            teamNameB=""
                            pointsA_Left={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) ? (teamAKey === 'home' ? (set5Data.homePoints || 0) : (set5Data.awayPoints || 0)) : 0}
                            pointsB={(set5Data && (set5Data.homePoints > 0 || set5Data.awayPoints > 0 || set5Data.startTime)) ? (teamBKey === 'home' ? (set5Data.homePoints || 0) : (set5Data.awayPoints || 0)) : 0}
                            pointsA_Right={0}
                            pointsAtChange="8"
                        />
                    </div>
                    
                    {/* Footer Grid: Sanctions Left, Right Block (Remarks|Results over Approval) */}
                    <div className="flex gap-2 flex-1 min-h-[300px]">
                        {/* Col 1: Sanctions */}
                        <div className="w-[25%] flex flex-col">
                            <Sanctions items={sanctions} />
                        </div>
                        
                        {/* Col 2: Right Block */}
                        <div className="flex-1 flex flex-col gap-2">
                            {/* Top Row: Remarks and Results */}
                            <div className="flex gap-2">
                                <div className="w-[35%]">
                                    <Remarks />
                                </div>
                                <div className="flex-1">
                                    <Results />
                                </div>
                            </div>
                            
                            {/* Bottom Row: Approvals */}
                            <div className="flex-1">
                                <Approvals />
                            </div>
                        </div>
                    </div>
                </div>

                {/* RIGHT COLUMN: Rosters (Side by Side) - 3/4 Height */}
                <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex flex-row gap-1 h-[75%]">
                        <div className="flex-1 min-w-0 h-full">
                            <Roster 
                              team={teamAShortName} 
                              side="A" 
                              players={teamAPlayers}
                              benchStaff={teamAKey === 'home' ? match?.bench_home : match?.bench_away}
                            />
                        </div>
                        <div className="flex-1 min-w-0 h-full">
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
    </div>
  );
};

export default App;
