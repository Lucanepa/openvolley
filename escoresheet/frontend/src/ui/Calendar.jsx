// The month calendar inside DateField's popover.
//
//   header   ‹  [month ▾] [year ▾]  ›      native selects: they open and close
//                                          fine everywhere, and a year 40 back
//                                          (a date of birth) is two taps away
//   grid     Mo … So, 6 rows, Monday first; days outside min/max are disabled
//   footer   Today · Clear            Done
//
// Keys on the grid (one roving tab stop, the focused day):
//   ← → ↑ ↓  a day / a week          Home / End  start / end of the week
//   PageUp / PageDown  a month (Shift: a year)
//   Enter / Space  pick the day      Escape  close (PickerPopover)
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.js';
import { FOCUS_RING, FOCUS_RING_INSET } from './Button.jsx';
import {
  addDays, addMonths, clampDate, inRange, longDayLabel, monthGrid, monthNames,
  parseIsoDate, todayIso, weekdayIndex, weekdayNames,
} from './dateTime.js';

const NAV_BTN = cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-800 disabled:opacity-40 disabled:hover:bg-transparent', FOCUS_RING);
const HEAD_SELECT = cn('h-9 min-w-0 rounded-lg border border-stone-300 bg-white px-2 text-sm font-medium text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500');
const FOOT_BTN = cn('h-9 rounded-lg px-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40 disabled:hover:bg-transparent', FOCUS_RING);
const DONE_BTN = cn('h-9 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800', FOCUS_RING);

/**
 * @param {object} props
 * @param {string} props.value  ISO date or ''
 * @param {(iso: string) => void} props.onPick   a day was picked (closes)
 * @param {() => void} props.onClear
 * @param {() => void} props.onDone
 * @param {string} [props.min]
 * @param {string} [props.max]
 * @param {string} [props.lang]
 */
export function Calendar({ value, onPick, onClear, onDone, min, max, lang, clearable = true }) {
  const { t } = useTranslation();
  const today = todayIso();
  const start = parseIsoDate(value) ? value : clampDate(today, min, max);
  const [focused, setFocused] = useState(start);
  const gridRef = useRef(null);
  const keyMoved = useRef(false);
  const firstFocus = useRef(true);

  const p = parseIsoDate(focused) || parseIsoDate(today);
  const days = monthGrid(p.year, p.month);
  const months = monthNames(lang);
  const weekdays = weekdayNames(lang);

  // The year list: the min/max years, or a wide window around today and the value.
  const thisYear = parseIsoDate(today).year;
  const lo = parseIsoDate(min)?.year ?? Math.min(1900, p.year);
  const hi = parseIsoDate(max)?.year ?? Math.max(thisYear + 10, p.year);
  const years = [];
  for (let y = hi; y >= lo; y -= 1) years.push(y);

  // Focus the picked (or today's) day when the popover opens, and follow the keys.
  useEffect(() => {
    if (!firstFocus.current && !keyMoved.current) return;
    firstFocus.current = false;
    keyMoved.current = false;
    gridRef.current?.querySelector(`[data-iso="${focused}"]`)?.focus();
  }, [focused]);

  const move = (next) => {
    const target = clampDate(next, min, max);
    if (!target) return;
    keyMoved.current = true;
    setFocused(target);
  };

  const showMonth = (year, month) => {
    // Keep the day number where the month has it; stay inside min/max.
    const day = Math.min(p.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
    setFocused(clampDate(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, min, max));
  };

  const onGridKey = (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') move(addDays(focused, -1));
    else if (k === 'ArrowRight') move(addDays(focused, 1));
    else if (k === 'ArrowUp') move(addDays(focused, -7));
    else if (k === 'ArrowDown') move(addDays(focused, 7));
    else if (k === 'Home') move(addDays(focused, -weekdayIndex(focused)));
    else if (k === 'End') move(addDays(focused, 6 - weekdayIndex(focused)));
    else if (k === 'PageUp') move(addMonths(focused, e.shiftKey ? -12 : -1));
    else if (k === 'PageDown') move(addMonths(focused, e.shiftKey ? 12 : 1));
    else if (k === 'Enter' || k === ' ') {
      if (inRange(focused, min, max)) onPick(focused);
    } else return;
    e.preventDefault();
  };

  const prevMonth = addMonths(toFirst(focused), -1);
  const nextMonth = addMonths(toFirst(focused), 1);
  const canPrev = !min || lastOfMonth(prevMonth) >= min;
  const canNext = !max || nextMonth <= max;
  const todayOk = inRange(today, min, max);

  return (
    <div className="w-[18rem] max-w-full select-none">
      <div className="mb-2 flex items-center gap-1">
        <button type="button" className={NAV_BTN} disabled={!canPrev} onClick={() => showMonthOf(prevMonth)}
          aria-label={t('picker.prevMonth', 'Previous month')} title={t('picker.prevMonth', 'Previous month')}>
          <ChevronLeft size={18} aria-hidden />
        </button>
        <select className={cn(HEAD_SELECT, 'flex-1')} value={p.month} aria-label={t('picker.month', 'Month')}
          onChange={(e) => showMonth(p.year, Number(e.target.value))}>
          {months.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
        </select>
        <select className={cn(HEAD_SELECT, 'w-[5.5rem] tabular-nums')} value={p.year} aria-label={t('picker.year', 'Year')}
          onChange={(e) => showMonth(Number(e.target.value), p.month)}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button type="button" className={NAV_BTN} disabled={!canNext} onClick={() => showMonthOf(nextMonth)}
          aria-label={t('picker.nextMonth', 'Next month')} title={t('picker.nextMonth', 'Next month')}>
          <ChevronRight size={18} aria-hidden />
        </button>
      </div>

      <div ref={gridRef} role="group" aria-label={`${months[p.month - 1]} ${p.year}`} onKeyDown={onGridKey}>
        <div className="grid grid-cols-7 text-center" aria-hidden>
          {weekdays.map((w, i) => (
            <span key={i} className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{w}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {days.map((iso) => {
            const d = parseIsoDate(iso);
            const outside = d.month !== p.month;
            const selected = iso === value;
            const isToday = iso === today;
            const disabled = !inRange(iso, min, max);
            return (
              <button
                key={iso}
                type="button"
                data-iso={iso}
                tabIndex={iso === focused ? 0 : -1}
                disabled={disabled}
                aria-label={longDayLabel(iso, lang)}
                aria-pressed={selected}
                aria-current={isToday ? 'date' : undefined}
                onClick={() => onPick(iso)}
                onFocus={() => { if (iso !== focused) setFocused(iso); }}
                className={cn(
                  'mx-auto flex h-10 w-10 items-center justify-center rounded-lg text-sm tabular-nums transition-colors',
                  FOCUS_RING_INSET,
                  selected
                    ? 'bg-slate-900 font-semibold text-white hover:bg-slate-800'
                    : cn('hover:bg-stone-100', outside ? 'text-stone-400' : 'text-stone-800'),
                  isToday && !selected && 'font-semibold ring-1 ring-inset ring-stone-300',
                  disabled && 'cursor-not-allowed text-stone-300 line-through hover:bg-transparent',
                )}
              >
                {d.day}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-stone-100 pt-2">
        <button type="button" className={FOOT_BTN} disabled={!todayOk} onClick={() => onPick(today)}>
          {t('picker.today', 'Today')}
        </button>
        {clearable && (
          <button type="button" className={FOOT_BTN} onClick={onClear}>
            {t('picker.clear', 'Clear')}
          </button>
        )}
        <button type="button" className={cn(DONE_BTN, 'ml-auto')} onClick={onDone}>
          {t('picker.done', 'Done')}
        </button>
      </div>
    </div>
  );

  function showMonthOf(iso) {
    const q = parseIsoDate(iso);
    if (q) showMonth(q.year, q.month);
  }
}

function toFirst(iso) {
  return `${iso.slice(0, 8)}01`;
}

function lastOfMonth(firstIso) {
  return addDays(addMonths(firstIso, 1), -1);
}

export default Calendar;
