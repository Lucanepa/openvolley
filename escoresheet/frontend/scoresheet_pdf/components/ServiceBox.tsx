import React from 'react';
import { SubRecord } from '../types_scoresheet';
import { CrossMark, MARK_STROKE, NumberCircle } from './Marks';

export interface ServiceRoundMark {
  position: number; // 0-5 for I-VI
  box: number; // round number
  ticked: boolean;
  points: number | null;
  circled: boolean;
}

/**
 * One service-round box: the pre-printed round number (top right), its tick when
 * that position opened a service round, the team score written when the service
 * was lost, the X of the receiving team's I/1, the circle round the final points.
 */
export const ServiceBox: React.FC<{
  num: number;
  round?: ServiceRoundMark;
  showX?: boolean;
  lastRow?: boolean;
}> = ({ num, round, showX = false, lastRow = false }) => {
  const hasPoints = !!round && round.points !== null && round.points !== undefined;
  return (
    <div
      className={`relative flex items-center justify-center ${lastRow ? '' : 'border-b ss-rule'}`}
      style={{ height: '5mm' }}
      data-service-box={num}
    >
      <span className="absolute top-[0.5px] right-[1.5px] text-[7px] leading-none text-black font-medium pointer-events-none">{num}</span>
      {round?.ticked && !showX && (
        // the tick through the round number (~0.3 mm pen, as a hand stroke)
        <svg className="absolute pointer-events-none" style={{ top: '-0.2mm', right: '-0.1mm', width: '2.4mm', height: '2.4mm' }} viewBox="0 0 100 100" aria-hidden="true" data-mark="round-tick">
          <line x1="12" y1="88" x2="88" y2="12" stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {showX && <CrossMark />}
      {hasPoints && !showX && (
        <span className="absolute inset-0 flex items-center justify-center text-[10.5px] font-bold text-black pointer-events-none tabular-nums">{round!.points}</span>
      )}
      {round?.circled && <NumberCircle />}
    </div>
  );
};

/** A score "a:b" on its pre-printed ":" line. */
const ScoreLine: React.FC<{ score?: string; lastCol: boolean }> = ({ score, lastCol }) => (
  <div className={`flex items-center justify-center border-b border-black ${lastCol ? '' : 'border-r'}`} style={{ height: '5mm' }}>
    {score ? (
      <div className="text-[12px] text-center leading-tight flex items-center gap-0.5 tabular-nums">
        <span>{score.split(':')[0]}</span>
        <span>:</span>
        <span>{score.split(':')[1]}</span>
      </div>
    ) : (
      <div className="text-[12px] text-center leading-tight">:</div>
    )}
  </div>
);

/**
 * The substitution rows of one position: the substitute's number (circled once
 * the starter came back: that substitute cannot re-enter), then the score of
 * the substitution and of the return.
 */
export const SubstitutionCells: React.FC<{ subs?: SubRecord[]; lastCol: boolean }> = ({ subs = [], lastCol }) => {
  const sub1 = subs[0];
  const sub2 = subs[1];
  const shown = sub1 || sub2;
  return (
    <div className="flex flex-col h-full bg-white" style={{ width: '10mm' }}>
      <div className={`shrink-0 flex items-center justify-center relative border-b border-black ${lastCol ? '' : 'border-r'}`} style={{ height: '5mm' }}>
        {shown && (
          <>
            <div className={`${shown.isCircled ? 'text-[12px]' : 'text-[14px]'} text-center font-bold leading-none tabular-nums`}>{shown.playerIn}</div>
            {shown.isCircled && <NumberCircle testId="sub-circle" />}
          </>
        )}
      </div>
      <ScoreLine score={sub1?.score} lastCol={lastCol} />
      <ScoreLine score={sub2?.score} lastCol={lastCol} />
    </div>
  );
};
