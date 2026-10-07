import React from 'react';
import { BRAND } from '../../src/brand.js';
import { formatTimeLocal } from '../../src/utils/timeUtils';
import { formatSheetDate, gameNumberOf } from '../utils/sheetFormat';
import { FitText } from './FitText';

// The scoresheet window also loads the scorer app's styles.css, whose global
// (unlayered) `input { background: #0f172a; border-radius; padding; color }`
// beats the Tailwind utilities and printed the empty 'other' fields as dark
// filled boxes. Inline styles win over it: a plain white field as on the form.
export const OTHER_FIELD_STYLE: React.CSSProperties = {
  background: '#fff',
  color: '#000',
  border: 0,
  borderBottom: '1px dotted #000',
  borderRadius: 0,
  boxShadow: 'none',
  height: 'auto',
  padding: '0 2px',
  fontSize: '8px',
  lineHeight: 1.2
};

interface HeaderProps {
  match?: any;
  homeTeam?: any;
  awayTeam?: any;
  teamAName?: string;
  teamBName?: string;
  coinTossConfirmed?: boolean;
}

/** One category box: the square, an X when it applies, its label. */
const CategoryBox: React.FC<{ checked: boolean; label: React.ReactNode }> = ({ checked, label }) => (
  <div className="flex items-center gap-0.5 min-w-0">
    {/* a box a hand X fits in (audit 2026-10: 2.6 mm was too small) */}
    <div className="w-3 h-3 border border-black bg-white flex items-center justify-center relative shrink-0">
      {checked && <span className="text-[11px] font-bold leading-none">X</span>}
    </div>
    {typeof label === 'string' ? <span className="text-[8px] whitespace-nowrap">{label}</span> : label}
  </div>
);

/** The "other" box: X when the category is "other", the text on a dotted line. */
const OtherField: React.FC<{
  value: string;
  ariaLabel: string;
  onChange?: (value: string) => void;
}> = ({ value, ariaLabel, onChange }) => (
  <div className="flex items-center gap-0.5 min-w-0 flex-1">
    <span className="text-[8px] shrink-0">Other:</span>
    <input
      type="text"
      className="text-[8px] px-0.5 py-0.5 bg-white w-full min-w-0"
      style={OTHER_FIELD_STYLE}
      value={value}
      onChange={e => onChange?.(e.target.value)}
      disabled={!onChange}
      aria-label={ariaLabel}
    />
  </div>
);

/**
 * The sheet's header (field-spec 2): the OpenVolley logo at the top left (no
 * federation logo on any platform), the category boxes, the match identity
 * (league, match no.) at the top right, then the teams line and the venue.
 *
 * One fixed layout, whatever the window size: the PDF is a capture of this
 * page, so a narrow window (an Android phone, a small desktop window) must not
 * switch it to a stacked "mobile" layout that pushes the sheet off the page.
 * Long names shrink to fit their box instead of growing the header.
 */
export const Header: React.FC<HeaderProps> = ({ match, homeTeam, awayTeam, coinTossConfirmed }) => {
  // Determine if home team is "A" based on coin toss result
  const homeIsA = (match?.coinTossTeamA || 'home') === 'home';

  // The local calendar day as DD.MM.YYYY and the local time (never the UTC day)
  const dateStr = formatSheetDate(match?.scheduledAt);
  const timeStr = match?.scheduledAt ? formatTimeLocal(match.scheduledAt) : '';

  const matchType = match?.matchType || match?.match_type_1;
  const gender = match?.gender || match?.match_type_2;
  const level = match?.level || match?.match_type_3;
  const isOtherLevel = level === 'other';
  const isOtherChampionship = match?.championshipType === 'other';
  const setChampionshipOther = typeof match?.setChampionshipTypeOther === 'function' ? match.setChampionshipTypeOther : undefined;
  const setLevelOther = typeof match?.setMatchType3Other === 'function' ? match.setMatchType3Other : undefined;

  return (
    <header className="border border-black bg-white">
      <div className="flex flex-row items-stretch" style={{ height: '11mm' }}>
        {/* OpenVolley logo (the one place the brand appears in the header) */}
        <div className="flex items-center justify-center shrink-0 border-r border-black px-2" style={{ width: '44mm' }}>
          <img
            src={BRAND.lockupPng}
            alt="OpenVolley"
            style={{ height: '26px', width: 'auto', maxWidth: '100%', objectFit: 'contain' }}
            data-testid="header-logo"
          />
        </div>

        <div className="flex-1 grid grid-cols-3 text-xs min-w-0">
          {/* Competition */}
          <div className="border-r border-black p-1 min-w-0 overflow-hidden">
            <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
              <CategoryBox checked={matchType === 'championship'} label="Championship" />
              <CategoryBox checked={matchType === 'cup'} label="Cup" />
              <CategoryBox checked={matchType === 'friendly'} label="Friendly" />
              <CategoryBox checked={matchType === 'tournament'} label="Tournament" />
            </div>
          </div>

          {/* Level */}
          <div className="border-r border-black p-1 min-w-0 overflow-hidden">
            <div className="grid grid-cols-2 gap-x-0.5 gap-y-0.5">
              <CategoryBox checked={match?.championshipType === 'regional'} label="Regional" />
              <CategoryBox checked={match?.championshipType === 'national'} label="National" />
              <CategoryBox checked={match?.championshipType === 'international'} label="International" />
              <CategoryBox
                checked={isOtherChampionship}
                label={<OtherField value={match?.championshipTypeOther || ''} ariaLabel="Other championship type" onChange={setChampionshipOther} />}
              />
            </div>
          </div>

          {/* Gender / age */}
          <div className="border-r border-black p-1 min-w-0 overflow-hidden">
            <div className="grid grid-cols-3 gap-x-0.5 gap-y-0.5">
              <CategoryBox checked={gender === 'men'} label="Men" />
              <CategoryBox checked={level === 'U23'} label="U23" />
              <CategoryBox checked={level === 'U17'} label="U17" />
              <CategoryBox checked={gender === 'women'} label="Women" />
              <CategoryBox checked={level === 'U19'} label="U19" />
              <CategoryBox
                checked={isOtherLevel}
                label={<OtherField value={match?.match_type_3_other || ''} ariaLabel="Other age category" onChange={setLevelOther} />}
              />
            </div>
          </div>
        </div>

        {/* Match identity at the top right: league and match number */}
        <div className="shrink-0 flex flex-col justify-center px-2 gap-0.5 min-w-0" style={{ width: '62mm' }} data-testid="header-identity">
          <div className="flex items-baseline gap-1 min-w-0">
            <span className="text-[9px] text-gray-500 shrink-0">League</span>
            <FitText max={12} min={6} className="flex-1 font-bold uppercase text-right" title={match?.league || ''}>
              {match?.league || ''}
            </FitText>
          </div>
          <div className="flex items-baseline gap-1 min-w-0">
            <span className="text-[9px] text-gray-500 shrink-0">Match No</span>
            <FitText max={14} min={6} className="flex-1 font-bold text-right" data-testid="header-match-no">
              {gameNumberOf(match)}
            </FitText>
          </div>
        </div>
      </div>

      {/* Teams and Location */}
      <div className="grid grid-cols-12 grid-rows-1 gap-0 border-t border-black text-xs" style={{ height: '10mm' }}>
        {/* Teams: Circle | Home Name | TEAMS/VS | Away Name | Circle (home always left) */}
        <div className="col-span-6 border-r border-black px-2 py-0.5 min-w-0 min-h-0 overflow-hidden">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-1 h-full">
            <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">
              {coinTossConfirmed ? (homeIsA ? 'A' : 'B') : ''}
            </div>
            <FitText max={18} min={7} className="font-bold uppercase text-center bg-white" title={homeTeam?.name || ''} data-testid="header-home">
              {homeTeam?.name || ''}
            </FitText>
            <div className="flex flex-col items-center px-2">
              <span className="text-[11px] leading-tight uppercase font-bold text-gray-500 tracking-wide">Teams</span>
              <span className="text-base font-bold text-gray-500 italic leading-none">VS</span>
            </div>
            <FitText max={18} min={7} className="font-bold uppercase text-center bg-white" title={awayTeam?.name || ''} data-testid="header-away">
              {awayTeam?.name || ''}
            </FitText>
            <div className="w-7 h-7 rounded-full border border-black text-center font-bold text-base bg-white shrink-0 flex items-center justify-center">
              {coinTossConfirmed ? (homeIsA ? 'B' : 'A') : ''}
            </div>
          </div>
        </div>

        {/* City, Hall, Date, Time */}
        {/* four separate fields, ruled apart as on the Matchblatt */}
        <div className="col-span-6 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <div className="flex w-full min-w-0 h-full items-stretch" data-testid="header-venue">
            <div className="flex flex-col justify-center flex-[2] min-w-0 px-2">
              <span className="text-[11px] leading-tight text-gray-500">City/Country</span>
              <FitText max={12} min={6} className="w-full bg-white pb-0.5 font-bold">{match?.city || ''}</FitText>
            </div>
            <div className="flex flex-col justify-center flex-[4] min-w-0 px-1.5 border-l border-black">
              <span className="text-[11px] leading-tight text-gray-500">Hall/Gym</span>
              <FitText max={12} min={6} className="w-full bg-white pb-0.5 font-bold">{match?.hall || ''}</FitText>
            </div>
            <div className="flex flex-col justify-center flex-[1.5] min-w-0 px-1.5 border-l border-black">
              <span className="text-[11px] leading-tight text-gray-500">Date</span>
              <div className="w-full bg-white text-[12px] pb-0.5 font-bold whitespace-nowrap" data-testid="header-date">{dateStr}</div>
            </div>
            <div className="flex flex-col justify-center flex-[1.2] min-w-0 px-1.5 border-l border-black">
              <span className="text-[11px] leading-tight text-gray-500">Time</span>
              <div className="w-full bg-white text-[12px] pb-0.5 font-bold whitespace-nowrap">{timeStr}</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
