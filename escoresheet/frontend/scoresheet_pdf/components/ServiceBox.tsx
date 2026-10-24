import React from 'react';
import { SubRecord } from '../types_scoresheet';
import { CrossMark, LINEUP_NUMBER_PT, MARK_STROKE, NumberCircle, SERVICE_NUMBER_DROP_MM, SERVICE_NUMBER_PX, SUB_CIRCLE_MM } from './Marks';

/** A thin white edge round written digits (~0.25 mm), so a stroke under them stops short of their ink. */
const DIGIT_HALO = ['1px 0', '-1px 0', '0 1px', '0 -1px', '0.7px 0.7px', '-0.7px 0.7px', '0.7px -0.7px', '-0.7px -0.7px'].map((o) => `${o} 0 #fff`).join(', ');

/**
 * Where the tick through the round number starts in its 2.4 mm square (viewBox
 * 0-100, from the bottom left): it crosses the small number and stops short of
 * the score below (owner 2026-10-24: shorter from the bottom left; it started
 * at 12 before, and ran into the score).
 */
export const TICK_START = 30;

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
          <line x1={TICK_START} y1={100 - TICK_START} x2="88" y2="12" stroke="black" strokeWidth={MARK_STROKE} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {showX && <CrossMark />}
      {hasPoints && !showX && (
        <span
          className="absolute inset-0 flex items-center justify-center font-bold text-black pointer-events-none tabular-nums"
          // below the round number's tick; a circled final stays in its ring, and a
          // white edge stops the tick at its digits (the ring is drawn over it)
          style={{
            fontSize: `${SERVICE_NUMBER_PX}px`,
            transform: round!.circled ? undefined : `translateY(${SERVICE_NUMBER_DROP_MM}mm)`,
            textShadow: round!.circled ? DIGIT_HALO : undefined
          }}
          data-mark="service-points"
        >{round!.points}</span>
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
            <div className="text-center font-bold leading-none tabular-nums" style={{ fontSize: `${LINEUP_NUMBER_PT}pt` }}>{shown.playerIn}</div>
            {shown.isCircled && <NumberCircle mm={SUB_CIRCLE_MM} testId="sub-circle" />}
          </>
        )}
      </div>
      <ScoreLine score={sub1?.score} lastCol={lastCol} />
      <ScoreLine score={sub2?.score} lastCol={lastCol} />
    </div>
  );
};
