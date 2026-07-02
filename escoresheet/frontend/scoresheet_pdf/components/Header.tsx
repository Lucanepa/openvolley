import React, { useState } from 'react';
import swissvolleyLogo from './swissvolleylogo.jpg';
// Logo for white background (scoresheet PDF)
const openvolleyLogo = '/openvolley_no_bg.png';
import { formatTimeLocal } from '../../src/utils/timeUtils';

interface HeaderProps {
  match?: any;
  homeTeam?: any;
  awayTeam?: any;
  teamAName?: string;
  teamBName?: string;
  coinTossConfirmed?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ match, homeTeam, awayTeam, teamAName, teamBName, coinTossConfirmed }) => {
  const [imageError, setImageError] = useState(false);
  const [faviconImageError, setFaviconImageError] = useState(false);

  // Determine if home team is "A" based on coin toss result
  const homeIsA = (match?.coinTossTeamA || 'home') === 'home';

  // Format date and time (display in local timezone)
  const scheduledDate = match?.scheduledAt ? new Date(match.scheduledAt) : null;
  const dateStr = scheduledDate ? scheduledDate.toISOString().split('T')[0] : '';
  const timeStr = match?.scheduledAt ? formatTimeLocal(match.scheduledAt) : '';

  return (
    <header className="border border-black bg-white">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-0.5">
        <div className="flex items-center justify-center min-w-[120px]">
            {/* Swiss Volley logo (left slot), matching the official Matchblatt */}
            {!imageError ? (
                <img
                    src={swissvolleyLogo}
                    alt="Swiss Volley"
                    style={{ height:'40px' }}
                    onError={() => setImageError(true)}
                />
            ) : null}
        </div>
        
        <div className="flex-1 w-full md:w-auto grid grid-cols-1 md:grid-cols-4 gap-0.5 text-xs min-w-0 overflow-hidden">
            {/* Match Type Block */}
            <div className="border-r border-l border-black p-1 min-w-0 overflow-hidden">
                <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {(match?.matchType === 'championship' || match?.match_type_1 === 'championship') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Championship</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {(match?.matchType === 'cup' || match?.match_type_1 === 'cup') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Cup</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {(match?.matchType === 'friendly' || match?.match_type_1 === 'friendly') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Friendly</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {(match?.matchType === 'tournament' || match?.match_type_1 === 'tournament') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Tournament</span>
                    </div>
                </div>
            </div>
            
            {/* Championship Type Block */}
            <div className="border-r border-black p-1 min-w-0 overflow-hidden mr-[-1px]">
                <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {match?.championshipType === 'regional' && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Regional</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {match?.championshipType === 'national' && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">National</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                            {match?.championshipType === 'international' && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">International</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative shrink-0`}>
                            {match?.championshipType === 'other' && match?.championshipTypeOther && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <input
                            type="text"
                            className="text-[8px] px-0.5 py-0.5 bg-white w-full max-w-[50px] min-w-0"
                            value={match?.championshipTypeOther || ''}
                            onChange={e => {
                                if (typeof match === 'object' && match !== null && typeof match.setChampionshipTypeOther === 'function') {
                                    match.setChampionshipTypeOther(e.target.value);
                                }
                            }}
                            disabled={!((match && typeof match.setChampionshipTypeOther === 'function'))}
                            aria-label="Other championship type"
                        />
                    </div>
                </div>
            </div>
            
            {/* Gender Block */}
            <div className="border-r border-black p-1 min-w-0 overflow-hidden">
                <div className="grid grid-cols-3 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.gender === 'men' || match?.match_type_2 === 'men') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">Men</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.level === 'U23' || match?.match_type_3 === 'U23') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U23</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.level === 'U17' || match?.match_type_3 === 'U17') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U17</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.gender === 'women' || match?.match_type_2 === 'women') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">Women</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.level === 'U19' || match?.match_type_3 === 'U19') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U19</span>
                     </div>
                      <div className="flex items-center gap-0.5">
                         <div className="w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative">
                             {(match?.level === 'other' || (match?.match_type_3 === 'other' && match?.match_type_3_other)) && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <input
                             type="text"
                             className="text-[8px] px-0.5 py-0.5 bg-white w-full max-w-[50px] min-w-0"
                             value={match?.match_type_3_other || ''}
                             onChange={e => {
                                 if (typeof match === 'object' && match !== null && typeof match.setMatchType3Other === 'function') {
                                     match.setMatchType3Other(e.target.value);
                                 }
                             }}
                             aria-label="Other age category"
                             disabled={!((match && typeof match.setMatchType3Other === 'function'))}
                         />
                     </div>
                 </div>
             </div>

            {/* Match ID Block */}
             <div className="border-r border-black p-0.5 flex flex-col h-full text-xs justify-center min-w-0 overflow-hidden">
                <div className="flex justify-between items-center pl-2 flex-1">
                    <span>League:</span>
                    <div className="w-1/2 text-center uppercase text-xs font-bold">{match?.league || ''}</div>
                </div>
                <div className="flex justify-between items-center pt-1 pl-2 flex-1">
                    <span>Match No:</span>
                    <div className="w-1/2 text-center text-xs font-bold">{match?.gameNumber || match?.externalId || ''}</div>
                </div>
            </div>
        </div>

        <div className="flex items-center justify-center min-w-[120px]">
            {/* Openvolley Logo Section with Fallback */}
            {!faviconImageError ? (
                <img
                    src={openvolleyLogo}
                    alt="Openvolley"
                    style={{ aspectRatio: '1/1', height:'45px' }}
                    onError={() => setFaviconImageError(true)}
                />
            ) : (
                <div className="flex flex-col items-center select-none text-[10px] font-bold text-gray-600">
                  FIVB
                </div>
            )}
        </div>
      </div>

      {/* Teams and Location */}
      <div className="grid grid-cols-12 gap-0 border-t border-black text-xs">
        {/* Teams: 5-column grid layout with TEAMS above VS */}
        <div className="col-span-6 border-r border-black px-2 py-1">
            {/* 5-column grid: Circle | Home Name | TEAMS/VS | Away Name | Circle */}
            <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-1">
                {/* Col 1: Left circle (Home team A/B) - vertically centered */}
                <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">
                    {coinTossConfirmed ? (homeIsA ? 'A' : 'B') : ''}
                </div>
                {/* Col 2: Home team name - vertically centered */}
                <div className="font-bold text-[18px] uppercase text-center bg-white">
                    {homeTeam?.name || ''}
                </div>
                {/* Col 3: TEAMS label above VS */}
                <div className="flex flex-col items-center px-2">
                    <span className="text-[12px] uppercase font-bold text-gray-500 tracking-wide">Teams</span>
                    <span className="text-base font-bold text-gray-500 italic">VS</span>
                </div>
                {/* Col 4: Away team name - vertically centered */}
                <div className="font-bold text-[18px] uppercase text-center bg-white">
                    {awayTeam?.name || ''}
                </div>
                {/* Col 5: Right circle (Away team A/B) - vertically centered */}
                <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">
                    {coinTossConfirmed ? (homeIsA ? 'B' : 'A') : ''}
                </div>
            </div>
        </div>

        {/* City, Hall, Date, Time: All in one row */}
        <div className="col-span-6 px-2 flex flex-col justify-center h-full">
            <div className="flex gap-1 w-full">
                <div className="flex flex-col flex-[2]">
                    <span className="text-[12px] text-gray-500">City/Country</span>
                    <div className="w-full bg-white text-[12px] pb-0.5 font-bold">{match?.city || ''}</div>
                </div>
                <div className="flex flex-col flex-[4]">
                    <span className="text-[12px] text-gray-500">Hall/Gym</span>
                    <div className="w-full bg-white text-[12px] pb-0.5 font-bold">{match?.hall || ''}</div>
                </div>
                <div className="flex flex-col flex-[1.5]">
                    <span className="text-[12px] text-gray-500">Date</span>
                    <div className="w-full bg-white text-[12px] pb-0.5 font-bold">
                      {(() => {
                        if (!dateStr) return '';
                        const date = new Date(dateStr);
                        if (isNaN(date.getTime())) return dateStr; // fallback
                        const day = String(date.getDate()).padStart(2, '0');
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const year = date.getFullYear();
                        return `${day}/${month}/${year}`;
                      })()}
                    </div>
                </div>
                <div className="flex flex-col flex-[1.5]">
                    <span className="text-[12px] text-gray-500">Time</span>
                    <div className="w-full bg-white text-[12px] pb-0.5 font-bold">{timeStr}</div>
                </div>
            </div>
        </div>
      </div>

    </header>
  );
};
