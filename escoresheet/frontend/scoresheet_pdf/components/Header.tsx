import React, { useState } from 'react';

export const Header: React.FC = () => {
  const [imageError, setImageError] = useState(false);

  return (
    <header className="border-2 border-black p-2 mb-2 bg-white">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
        <div className="flex items-center gap-4 min-w-[200px]">
            {/* Logo Section with Fallback */}
            {!imageError ? (
                <img 
                    src="swissvolleylogo.jpg" 
                    alt="Swiss Volley Region Zürich" 
                    className="h-16 object-contain" 
                    onError={() => setImageError(true)}
                />
            ) : (
                /* CSS Fallback Logo if image is missing */
                <div className="flex flex-col items-start select-none">
                  
                </div>
            )}
        </div>
        
        <div className="flex-1 w-full md:w-auto grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            {/* Match Info Block */}
            <div className="border border-black p-1 flex flex-col justify-between">
                <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Championship
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Cup
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Friendly
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Tournament
                    </label>
                </div>
                <div className="border-t border-gray-300 my-1"></div>
                <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Regional
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> National
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> International
                    </label>
                    <div className="flex items-center gap-1">
                        <input type="checkbox" className="bg-white" />
                        <input type="text" className="border-b border-black w-full bg-white h-3 text-[9px] outline-none" />
                    </div>
                </div>
            </div>
            
            {/* Category Block */}
             <div className="border border-black p-1">
                <div className="grid grid-cols-2 gap-1">
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Men
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> Women
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> U23
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> U19
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" className="bg-white" /> U17
                    </label>
                     <div className="flex items-center gap-1">
                        <input type="checkbox" className="bg-white" />
                        <input type="text" className="border-b border-black w-full bg-white h-3 text-[9px] outline-none" />
                    </div>
                </div>
            </div>

            {/* Match ID Block */}
             <div className="border border-black p-1 flex flex-col h-full">
                <div className="flex justify-between items-end border-b border-gray-300 pb-1 flex-1">
                    <span>League:</span>
                    <input type="text" className="border-b border-black w-1/2 text-right font-mono bg-white focus:bg-blue-100 outline-none uppercase" />
                </div>
                 <div className="flex justify-between items-end pt-1 flex-1">
                    <span>Match No:</span>
                    <input type="text" className="border-b border-black w-1/2 text-right font-mono bg-white focus:bg-blue-100 outline-none" />
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
                     <input className="w-8 h-8 rounded-full border-2 border-black text-center font-bold text-lg outline-none bg-white shrink-0" />
                     <input type="text" className="w-full border-b border-black font-bold text-sm uppercase bg-white outline-none" placeholder="Team A" />
                 </div>
                 <div className="flex items-center gap-2 flex-1">
                     <input className="w-8 h-8 rounded-full border-2 border-black text-center font-bold text-lg outline-none bg-white shrink-0" />
                     <input type="text" className="w-full border-b border-black font-bold text-sm uppercase bg-white outline-none" placeholder="Team B" />
                 </div>
            </div>
        </div>

        {/* City/Hall: 1/6th width = 2 cols */}
        <div className="col-span-2 border-r border-black px-2 flex flex-col justify-between">
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">City/Country</span>
                <input type="text" className="w-full border-b border-black outline-none bg-white text-xs" />
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Hall/Gym</span>
                <input type="text" className="w-full border-b border-black outline-none bg-white text-xs" />
            </div>
        </div>

         {/* Date/Time: 1/6th width = 2 cols */}
         <div className="col-span-2 px-2 flex flex-col justify-between">
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Date</span>
                <input type="date" className="w-full border-b border-black outline-none bg-white text-xs" />
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] text-gray-500">Time</span>
                <input type="time" className="w-full border-b border-black outline-none bg-white text-xs" />
            </div>
        </div>
      </div>
    </header>
  );
};