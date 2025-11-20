import React, { useState } from 'react';
import swissvolleyLogo from './swissvolleylogo.jpg';

interface HeaderProps {
  match?: any;
  homeTeam?: any;
  awayTeam?: any;
  teamAName?: string;
  teamBName?: string;
}

export const Header: React.FC<HeaderProps> = ({ match, homeTeam, awayTeam, teamAName, teamBName }) => {
  const [imageError, setImageError] = useState(false);
  
  // Format date and time
  const scheduledDate = match?.scheduledAt ? new Date(match.scheduledAt) : null;
  const dateStr = scheduledDate ? scheduledDate.toISOString().split('T')[0] : '';
  const timeStr = scheduledDate ? scheduledDate.toTimeString().slice(0, 5) : '';

  return (
    <header className="border-2 border-black p-2 mb-2 bg-white">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
        <div className="flex items-center gap-4 min-w-[200px]">
            {/* Logo Section with Fallback */}
            {!imageError ? (
                <img 
                    src={swissvolleyLogo} 
                    alt="Swiss Volley Region Zürich" 
                    className="h-16 object-contain" 
                    onError={() => setImageError(true)}
                />
            ) : (
                /* CSS Fallback Logo if image is missing */
                <div className="flex flex-col items-start select-none text-sm font-bold text-gray-600">
                  Swiss Volley
                </div>
            )}
        </div>
        
        <div className="flex-1 w-full md:w-auto grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            {/* Match Info Block */}
            <div className="border border-black p-1 flex flex-col justify-between">
                <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.matchType === 'championship' || match?.match_type_1 === 'championship') ? 'bg-black' : 'bg-white'}`}>{(match?.matchType === 'championship' || match?.match_type_1 === 'championship') ? '✓' : ''}</div>
                        <span>Championship</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.matchType === 'cup' || match?.match_type_1 === 'cup') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Cup</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.matchType === 'friendly' || match?.match_type_1 === 'friendly') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Friendly</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.matchType === 'tournament' || match?.match_type_1 === 'tournament') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Tournament</span>
                    </div>
                </div>
                <div className="border-t border-gray-300 my-1"></div>
                <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${match?.championshipType === 'regional' ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Regional</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${match?.championshipType === 'national' ? 'bg-black' : 'bg-white'}`}></div>
                        <span>National</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${match?.championshipType === 'international' ? 'bg-black' : 'bg-white'}`}></div>
                        <span>International</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${match?.championshipType === 'other' && match?.championshipTypeOther ? 'bg-black' : 'bg-white'}`}></div>
                        <span className="text-[9px]">{match?.championshipTypeOther || ''}</span>
                    </div>
                </div>
            </div>
            
            {/* Category Block */}
             <div className="border border-black p-1">
                <div className="grid grid-cols-2 gap-1">
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.category === 'men' || match?.match_type_2 === 'men') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Men</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.category === 'women' || match?.match_type_2 === 'women') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>Women</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.level === 'U23' || match?.match_type_3 === 'U23') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>U23</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.level === 'U19' || match?.match_type_3 === 'U19') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>U19</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.level === 'U17' || match?.match_type_3 === 'U17') ? 'bg-black' : 'bg-white'}`}></div>
                        <span>U17</span>
                    </div>
                     <div className="flex items-center gap-1">
                        <div className={`w-3 h-3 border border-black ${(match?.level === 'other' || (match?.match_type_3 === 'other' && match?.match_type_3_other)) ? 'bg-black' : 'bg-white'}`}></div>
                        <span className="text-[9px]">{match?.match_type_3_other || ''}</span>
                    </div>
                </div>
            </div>

            {/* Match ID Block */}
             <div className="border border-black p-1 flex flex-col h-full text-xs">
                <div className="flex justify-between items-end border-b border-gray-300 pb-1 flex-1">
                    <span>League:</span>
                    <div className="border-b border-black w-1/2 text-center uppercase text-xs font-bold">{match?.league || ''}</div>
                </div>
                 <div className="flex justify-between items-end pt-1 flex-1">
                    <span>Match No:</span>
                    <div className="border-b border-black w-1/2 text-center text-xs font-bold">{match?.gameNumber || match?.externalId || ''}</div>
                </div>
            </div>
        </div>

      </div>

      {/* Teams and Location */}
      <div className="grid grid-cols-12 gap-0 border-t-2 border-black pt-2 text-xs">
        {/* Teams: 2/3rds width = 8 cols */}
        <div className="col-span-8 border-r border-black px-2 flex flex-col justify-between">
            <div className="w-full text-center border-b border-gray-200 mb-1">
                <span className="text-[10px] uppercase font-bold text-gray-500 tracking-widest">Teams</span>
            </div>
            <div className="flex items-end gap-4 mb-1">
                 <div className="flex items-center gap-2 flex-1">
                     <div className="w-8 h-8 rounded-full border-2 border-black text-center font-bold text-lg bg-white shrink-0 flex items-center justify-center">A</div>
                     <div className="w-full border-b border-black font-bold text-sm uppercase bg-white pb-1">{teamAName || ''}</div>
                 </div>
                 <div className="flex items-center gap-2 flex-1">
                     <div className="w-8 h-8 rounded-full border-2 border-black text-center font-bold text-lg bg-white shrink-0 flex items-center justify-center">B</div>
                     <div className="w-full border-b border-black font-bold text-sm uppercase bg-white pb-1">{teamBName || ''}</div>
                 </div>
            </div>
        </div>

        {/* City/Hall: 1/6th width = 2 cols */}
        <div className="col-span-2 border-r border-black px-2 flex flex-col justify-between">
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">City/Country</span>
                <div className="w-full border-b border-black bg-white text-xs pb-0.5">{match?.city || ''}</div>
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Hall/Gym</span>
                <div className="w-full border-b border-black bg-white text-xs pb-0.5">{match?.hall || ''}</div>
            </div>
        </div>

         {/* Date/Time: 1/6th width = 2 cols */}
         <div className="col-span-2 px-2 flex flex-col justify-between">
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Date</span>
                <div className="w-full border-b border-black bg-white text-xs pb-0.5">{dateStr}</div>
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Time</span>
                <div className="w-full border-b border-black bg-white text-xs pb-0.5">{timeStr}</div>
            </div>
        </div>
      </div>
    </header>
  );
};