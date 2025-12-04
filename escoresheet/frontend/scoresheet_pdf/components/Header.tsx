import React, { useState } from 'react';
import swissvolleyLogo from './swissvolleylogo.jpg';
import favicon from '../../src/favicon.png';

interface HeaderProps {
  match?: any;
  homeTeam?: any;
  awayTeam?: any;
  teamAName?: string;
  teamBName?: string;
}

export const Header: React.FC<HeaderProps> = ({ match, homeTeam, awayTeam, teamAName, teamBName }) => {
  const [imageError, setImageError] = useState(false);
  const [faviconImageError, setFaviconImageError] = useState(false);
  
  // Format date and time
  const scheduledDate = match?.scheduledAt ? new Date(match.scheduledAt) : null;
  const dateStr = scheduledDate ? scheduledDate.toISOString().split('T')[0] : '';
  const timeStr = scheduledDate ? scheduledDate.toTimeString().slice(0, 5) : '';

  return (
    <header className="border border-black p-0.5 mb-1 bg-white">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-1 mb-1">
        <div className="flex items-center justify-center min-w-[140px]">
            {/* Swiss Volley Logo Section with Fallback */}
            {!imageError ? (
                <img 
                    src={swissvolleyLogo} 
                    alt="Swiss Volley Region Zürich" 
                    className="h-10 object-contain mx-auto" 
                    onError={() => setImageError(true)}
                />
            ) : (
                <div className="flex flex-col items-center select-none text-[10px] font-bold text-gray-600">
                  Swiss Volley
                </div>
            )}
        </div>
        
        <div className="flex-1 w-full md:w-auto grid grid-cols-1 md:grid-cols-4 gap-0.5 text-xs">
            {/* Match Type Block */}
            <div className="border border-black p-2">
                <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {(match?.matchType === 'championship' || match?.match_type_1 === 'championship') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Championship</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {(match?.matchType === 'cup' || match?.match_type_1 === 'cup') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Cup</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {(match?.matchType === 'friendly' || match?.match_type_1 === 'friendly') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Friendly</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {(match?.matchType === 'tournament' || match?.match_type_1 === 'tournament') && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Tournament</span>
                    </div>
                </div>
            </div>
            
            {/* Championship Type Block */}
            <div className="border border-black p-2">
                <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {match?.championshipType === 'regional' && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">Regional</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                            {match?.championshipType === 'national' && (
                                <span className="text-[10px] font-bold leading-none">X</span>
                            )}
                        </div>
                        <span className="text-[8px]">National</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
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
                            className="text-[8px] border-b border-black px-0.5 py-0.5 bg-white"
                            placeholder=""
                            value={match?.championshipTypeOther || ''}
                            onChange={e => {
                                if (typeof match === 'object' && match !== null && typeof match.setChampionshipTypeOther === 'function') {
                                    match.setChampionshipTypeOther(e.target.value);
                                }
                            }}
                            style={{ minWidth: '50px' }}
                            disabled={!((match && typeof match.setChampionshipTypeOther === 'function'))}
                        />
                    </div>
                </div>
            </div>
            
            {/* Category Block */}
            <div className="border border-black p-2">
                <div className="grid grid-cols-3 gap-x-0.5 gap-y-0.5">
                    <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.category === 'men' || match?.match_type_2 === 'men') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">Men</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.level === 'U23' || match?.match_type_3 === 'U23') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U23</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.level === 'U17' || match?.match_type_3 === 'U17') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U17</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.category === 'women' || match?.match_type_2 === 'women') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">Women</span>
                     </div>
                     <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.level === 'U19' || match?.match_type_3 === 'U19') && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <span className="text-[8px]">U19</span>
                     </div>
                      <div className="flex items-center gap-0.5">
                         <div className={`w-2.5 h-2.5 border border-black bg-white flex items-center justify-center relative`}>
                             {(match?.level === 'other' || (match?.match_type_3 === 'other' && match?.match_type_3_other)) && (
                                 <span className="text-[10px] font-bold leading-none">X</span>
                             )}
                         </div>
                         <input
                             type="text"
                             className="text-[8px] border-b border-black px-0.5 py-0.5 bg-white"
                             placeholder=""
                             value={match?.match_type_3_other || ''}
                             onChange={e => {
                                 if (typeof match === 'object' && match !== null && typeof match.setMatchType3Other === 'function') {
                                     match.setMatchType3Other(e.target.value);
                                 }
                             }}
                             style={{ minWidth: '50px' }}
                             disabled={!((match && typeof match.setMatchType3Other === 'function'))}
                         />
                     </div>
                 </div>
             </div>

            {/* Match ID Block */}
             <div className="border border-black p-0.5 flex flex-col h-full text-xs justify-center">
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

        <div className="flex items-center justify-center min-w-[140px]">
            {/* favicon Logo Section with Fallback */}
            {!faviconImageError ? (
                <img 
                    src={favicon} 
                    alt="favicon" 
                    className="h-10 object-contain mx-auto" 
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
      <div className="grid grid-cols-12 gap-0 border-t border-black pt-1 mt-1 text-xs">
        {/* Teams: 2/3rds width =8 cols */}
        <div className="col-span-6 border-r order-black px-2 flex flex-col justify-between">
            <div className="w-full text-center mb-0.5">
                <span className="text-[15px] uppercase font-bold text-gray-500 tracking-wide">Teams</span>
            </div>
             <div className="flex items-end gap-1 mb-0.5">
                 <div className="flex items-center gap-1 flex-1">
                    <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">A</div>
                     <div className="w-full font-bold text-xs uppercase text-center bg-white pb-0.5">{teamAName || ''}</div>
                 </div>
                 <div className="flex items-center h-full">
                     <span className="text-base font-bold">:</span>
                 </div>
                 <div className="flex items-center gap-1 flex-1">
                     <div className="w-full font-bold text-xs uppercase text-center bg-white pb-0.5">{teamBName || ''}</div>
                    <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">B</div>
                 </div>
            </div>
        </div>

        {/* City, Hall, Date, Time: All in one row */}
        <div className="col-span-6 px-2 flex flex-col justify-center h-full">
            <div className="flex gap-1 w-full">
                <div className="flex flex-col flex-[2]">
                    <span className="text-[8px] text-gray-500">City/Country</span>
                    <div className="w-full border-b border-black bg-white text-[10px] pb-0.5 font-bold">{match?.city || ''}</div>
                </div>
                <div className="flex flex-col flex-[4]">
                    <span className="text-[8px] text-gray-500">Hall/Gym</span>
                    <div className="w-full border-b border-black bg-white text-[10px] pb-0.5 font-bold">{match?.hall || ''}</div>
                </div>
                <div className="flex flex-col flex-[1.5]">
                    <span className="text-[8px] text-gray-500">Date</span>
                    <div className="w-full border-b border-black bg-white text-[10px] pb-0.5 font-bold">
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
                    <span className="text-[8px] text-gray-500">Time</span>
                    <div className="w-full border-b border-black bg-white text-[10px] pb-0.5 font-bold">{timeStr}</div>
                </div>
            </div>
        </div>
      </div>
    </header>
  );
};
