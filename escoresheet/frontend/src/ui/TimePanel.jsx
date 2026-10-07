// The hour / minute lists inside TimeField's popover.
//
//   Hours      Minutes
//   00         00
//   …          05        every `step` minutes (5 by default); a typed exact
//   23         …         minute (20:47) shows up in the list too
//              55
//   Now · Clear            Done
//
// An hour keeps the minute (or takes :00) and moves on to the minutes; a
// minute completes the time and closes. Keys: ↑ ↓ in a list, ← → between the
// lists, Home / End, Enter / Space picks, Escape closes (PickerPopover).
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.js';
import { FOCUS_RING, FOCUS_RING_INSET } from './Button.jsx';
import { minuteOptions, nowTime, pad2 } from './dateTime.js';

const FOOT_BTN = cn('h-9 rounded-lg px-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40 disabled:hover:bg-transparent', FOCUS_RING);
const DONE_BTN = cn('h-9 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800', FOCUS_RING);
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const fits = (value, min, max) => (!min || value >= min) && (!max || value <= max);

/**
 * @param {object} props
 * @param {string} props.value  'HH:MM' or ''
 * @param {(value: string, done: boolean) => void} props.onPick  done: close the popover
 * @param {() => void} props.onClear
 * @param {() => void} props.onDone
 * @param {number} [props.step]  minutes between the offered minutes
 * @param {string} [props.min]
 * @param {string} [props.max]
 */
export function TimePanel({ value, onPick, onClear, onDone, step = 5, min, max, clearable = true }) {
  const { t } = useTranslation();
  const hour = value ? Number(value.slice(0, 2)) : null;
  const minute = value ? Number(value.slice(3, 5)) : null;
  const minutes = minuteOptions(step, minute ?? undefined);
  const hoursRef = useRef(null);
  const minutesRef = useRef(null);

  // Open on the chosen hour (or the hour now) and scroll both lists to it.
  useEffect(() => {
    const h = hour ?? Number(nowTime(1).slice(0, 2));
    const hb = hoursRef.current?.querySelector(`[data-v="${h}"]`);
    const mb = minutesRef.current?.querySelector(`[data-v="${minute ?? 0}"]`);
    hb?.scrollIntoView?.({ block: 'center' });
    mb?.scrollIntoView?.({ block: 'center' });
    hb?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hourOk = (h) => minutes.some((m) => fits(`${pad2(h)}:${pad2(m)}`, min, max)) || fits(`${pad2(h)}:00`, min, max);

  const pickHour = (h) => {
    let m = minute ?? 0;
    if (!fits(`${pad2(h)}:${pad2(m)}`, min, max)) m = minutes.find((x) => fits(`${pad2(h)}:${pad2(x)}`, min, max)) ?? 0;
    onPick(`${pad2(h)}:${pad2(m)}`, false);
    // On to the minutes.
    setTimeout(() => minutesRef.current?.querySelector(`[data-v="${m}"]`)?.focus(), 0);
  };

  const pickMinute = (m) => {
    const h = hour ?? Number(nowTime(1).slice(0, 2));
    onPick(`${pad2(h)}:${pad2(m)}`, true);
  };

  const listKey = (list, other) => (e) => {
    const buttons = Array.from(list.current?.querySelectorAll('button:not([disabled])') || []);
    const i = buttons.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = buttons[Math.min(buttons.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = buttons[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const target = other.current?.querySelector('[aria-pressed="true"]:not([disabled])') || other.current?.querySelector('button:not([disabled])');
      target?.focus();
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    next?.focus();
    next?.scrollIntoView?.({ block: 'nearest' });
  };

  const now = nowTime(1);
  const cell = (on) => cn(
    'block w-full rounded-lg py-2 text-center text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:text-stone-300 disabled:hover:bg-transparent',
    FOCUS_RING_INSET,
    on ? 'bg-slate-900 font-semibold text-white hover:bg-slate-800' : 'text-stone-800 hover:bg-stone-100',
  );

  return (
    <div className="w-[17rem] max-w-full select-none">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('picker.hours', 'Hours')}</p>
          <div ref={hoursRef} role="group" aria-label={t('picker.hours', 'Hours')} onKeyDown={listKey(hoursRef, minutesRef)}
            className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
            {HOURS.map((h) => (
              <button key={h} type="button" data-v={h} className={cell(h === hour)} aria-pressed={h === hour}
                disabled={!hourOk(h)} onClick={() => pickHour(h)}>
                {pad2(h)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('picker.minutes', 'Minutes')}</p>
          <div ref={minutesRef} role="group" aria-label={t('picker.minutes', 'Minutes')} onKeyDown={listKey(minutesRef, hoursRef)}
            className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
            {minutes.map((m) => {
              const h = hour ?? Number(now.slice(0, 2));
              return (
                <button key={m} type="button" data-v={m} className={cell(m === minute)} aria-pressed={m === minute}
                  disabled={!fits(`${pad2(h)}:${pad2(m)}`, min, max)} onClick={() => pickMinute(m)}>
                  :{pad2(m)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-stone-100 pt-2">
        <button type="button" className={FOOT_BTN} disabled={!fits(now, min, max)} onClick={() => onPick(now, true)}>
          {t('picker.now', 'Now')}
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
}

export default TimePanel;
