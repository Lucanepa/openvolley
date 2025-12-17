import React from 'react';
import { SubRecord } from '../types_scoresheet';

// Full black border color for PDF capture
const borderColor75 = { borderColor: '#000000' };

interface ServiceRound {
  position: number;
  box: number;
  ticked: boolean;
  points: number | null;
  circled: boolean;
}

interface LeftInfoBoxProps {
  lineup?: string[];
  subs?: SubRecord[][];
  serviceRounds?: ServiceRound[];
  isSet5?: boolean;
}

export const LeftInfoBox: React.FC<LeftInfoBoxProps> = ({ 
  lineup = [], 
  subs = [], 
  serviceRounds = [],
  isSet5 = false
}) => {
  const positions = [0, 1, 2, 3, 4, 5];
  const serviceRoundNumbers = isSet5 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7, 8];
  const serviceRoundsPerColumn = isSet5 ? 3 : 4;
  
  return (
    <div
      className={`border bg-white flex flex-col ${isSet5 ? "mr-1" : "mr-2"}`}
      style={{ width: isSet5 ? '39.7mm' : '40mm', height: isSet5 ? '4.8cm' : '5.3cm', ...borderColor75 }}
    >
        <div className="flex flex-col items-center justify-center min-w-[30px] border-b p-1" style={{height:'0.8cm', ...borderColor75}}>

        </div>
      {/* Rotation Header */}
      <div className="border-b text-right pr-1 font-bold text-[10px] py-0.5 shrink-0" style={{height:'0.5cm', ...borderColor75}}>
        Rotation
      </div>
      
      {/* Starting line up Header */}
      <div className="border-b text-right pr-1 font-bold text-[10px] py-0.5 shrink-0" style={{height:'0.5cm', ...borderColor75}}>
        Starting line up
      </div>
      
      {/* Substitutions and Player Number Table */}
      <div className="flex border-b shrink-0" style={{height:'1.5cm', ...borderColor75}}>
        {/* Substitutions Column */}
        <div className="border-r flex flex-col" style={{ width: '25mm', ...borderColor75 }}>
          <div className="border-b p-1 font-bold text-[9px] py-0.5 shrink-0" style={{height:'1.5cm', ...borderColor75}}>
            Substitutions
          </div>
        </div>
        
        {/* N.of the player Column */}
        <div className="flex flex-col flex-1">
          <div className="border-b p-1 font-bold text-[9px] py-0.5 shrink-0" style={{height:'0.5cm', ...borderColor75}}>
            Player N.
          </div>
          {/* Score sub-header */}
          <div className="border-b p-1 font-bold text-[9px] py-0.5 shrink-0" style={{height:'1cm', ...borderColor75}}>
            Score
          </div>
        </div>
      </div>
      <div className="flex shrink-0" style={{height: isSet5 ? '1.5cm' : '2cm'}}>
        {/* Service Rounds Header - 2cm tall */}
        <div className="border-r text-center font-bold text-[10px] py-0.5 shrink-0 flex items-center justify-center" style={{width: '25mm', height: isSet5 ? '1.5cm' : '2cm', ...borderColor75}}>
          Service Rounds
        </div>
        
        {/* Service Rounds Grid - Split into 2 columns */}
        <div className="flex-1 flex border-b-0" style={{height: isSet5 ? '1.5cm' : '2cm', ...borderColor75}}>
          {/* First Column: for set5 show 1-3, else 1-4 */}
          <div className="border-r flex flex-col flex-1" style={borderColor75}>
            {(isSet5 ? [1, 2, 3] : [1, 2, 3, 4]).map((num) => (
              <div key={num} className="flex-1 border-b last:border-b-0 flex items-center justify-center" style={borderColor75}>
                <div className="text-[9px] font-bold">{num}</div>
              </div>
            ))}
          </div>
          
          {/* Second Column: 5, 6, 7, 8 */}
          <div className="flex flex-col flex-1">
            {(isSet5 ? [4, 5, 6] : [5, 6, 7, 8]).map((num) => (
              <div key={num} className="flex-1 border-b last:border-b-0 flex items-center justify-center" style={borderColor75}>
                <div className="text-[9px] font-bold">{num}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

