// DateField, TimeField and DateTimeField: typed date / time fields with the
// kit's own calendar and time popovers. Use them instead of
// <input type="date|time|datetime-local"> (a guard test fails on those: the
// native WebKitGTK date popup in the Linux desktop app could not be closed).
//
//   <Field label="Datum"><DateField value={iso} onChange={setIso} /></Field>
//   <TimeField value="20:45" onChange={setTime} step={5} />
//   <DateTimeField value="2026-10-07T20:45" onChange={setAt} />
//
// - Typing: DD.MM.YYYY and HH:MM, whatever the app language (the Swiss order);
//   digits only are fine ("07102026", "2045"), a numeric keyboard on touch.
//   Month and day names in the calendar follow the app language.
// - Values in and out are ISO ('YYYY-MM-DD', 'HH:MM', 'YYYY-MM-DDTHH:MM').
//   onChange(value) gets the new value whenever it changes: the date once the
//   text is a complete, real date, '' while it is empty or unfinished (as a
//   native field reports it). Controlled (`value`) or not (`defaultValue`).
// - min / max (ISO): days outside are disabled in the calendar; a typed date
//   outside still reaches onChange (as natively) but the field turns red and
//   the form will not submit (setCustomValidity), like a native range error.
// - required, disabled, id, aria-*, data-* and the rest go to the text input,
//   so <Field> labels and describes it as any other input.
// - size: 'sm' | 'md' | 'lg' like Input; 'bare' leaves the look to the caller's
//   className / style (the scoring screens' inline-styled tables).
// - calendar={false} / picker={false}: no popover button, typing only.
import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { INPUT_INVALID, INPUT_SIZES } from './Input.jsx';
import { PickerPopover } from './PickerPopover.jsx';
import { Calendar } from './Calendar.jsx';
import { TimePanel } from './TimePanel.jsx';
import {
  acceptDateInput, acceptTimeInput, isoToDateText, joinDateTime, normalizeTime,
  parseDateText, parseIsoDate, parseTimeText, splitDateTime,
} from './dateTime.js';

// Room for the trailing button inside the kit sizes.
const PAD_RIGHT = { sm: 'pr-8', md: 'pr-9', lg: 'pr-11' };
const BTN_BOX = {
  sm: 'right-0.5 h-7 w-7',
  md: 'right-1 h-7 w-7',
  lg: 'right-1 h-9 w-9 rounded-lg',
};
const ICON_PX = { sm: 15, md: 16, lg: 18, bare: 14 };

/**
 * A text field bound to an ISO value: the text follows `value` when it changes
 * from outside, and reports what the text means when the user types.
 */
function useTypedValue({ value, defaultValue, onChange, toText, read }) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = (controlled ? value : inner) ?? '';
  const [text, setText] = useState(() => toText(current));
  // The value this field last reported: a different `value` came from outside
  // (a match that loaded, a reset), and the text follows it.
  const reported = useRef(current);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (current === reported.current) return;
    reported.current = current;
    setText(toText(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const report = (next) => {
    if (next === reported.current) return;
    reported.current = next;
    if (!controlled) setInner(next);
    onChangeRef.current?.(next);
  };

  const type = (nextText) => {
    setText(nextText);
    report(read(nextText));
  };

  /** A value picked in the popover: text and value at once. */
  const pick = (next) => {
    setText(toText(next));
    report(next);
  };

  return { text, setText, type, pick, current: reported.current };
}

/** Sets the browser's validity message, so a form will not submit a bad date. */
function useValidity(ref, message) {
  useEffect(() => {
    const el = ref.current;
    if (el && typeof el.setCustomValidity === 'function') el.setCustomValidity(message || '');
  }, [ref, message]);
}

function TriggerButton({ size, disabled, open, onOpen, label, icon: Icon, controls }) {
  const bare = size === 'bare';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      className={cn(
        // bg / p / border / font: the legacy `button` rule (styles.css) paints every
        // button green outside .ov-kit.
        'inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 font-normal text-stone-400 transition-colors hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-40',
        FOCUS_RING,
        bare ? 'ml-0.5 h-6 w-5 rounded' : cn('absolute top-1/2 -translate-y-1/2 rounded-md hover:bg-stone-100', BTN_BOX[size] ?? BTN_BOX.md),
      )}
    >
      <Icon size={ICON_PX[size] ?? 16} aria-hidden />
    </button>
  );
}

/** Inline layout for the bare input, so host CSS for `input` (width: 100%,
 *  flex: 0 0 100%, min-width) cannot push the button out of the field. */
function bareStyle(size, style) {
  return size === 'bare' ? { flex: '1 1 auto', minWidth: 0, ...style } : style;
}

function inputClass(size, { invalid, withButton, className }) {
  if (size === 'bare') return cn('min-w-0 flex-1 tabular-nums', className);
  return cn(INPUT_SIZES[size] ?? INPUT_SIZES.md, 'tabular-nums', withButton && (PAD_RIGHT[size] ?? PAD_RIGHT.md), invalid && INPUT_INVALID, className);
}

function useLang() {
  const { i18n } = useTranslation();
  return i18n?.resolvedLanguage || i18n?.language || 'de-CH';
}

/** Close the popover and put the focus back on the field. */
function useReturnFocus(inputRef, setOpen) {
  return () => {
    setOpen(false);
    // After the popover unmounts, so its focus handling cannot steal it back.
    setTimeout(() => inputRef.current?.focus?.({ preventScroll: true }), 0);
  };
}

/**
 * Date as DD.MM.YYYY text plus a calendar popover. ISO value in and out.
 * @param {object} props
 * @param {string} [props.value]          'YYYY-MM-DD' or ''
 * @param {string} [props.defaultValue]   uncontrolled start value
 * @param {(iso: string) => void} [props.onChange]
 * @param {string} [props.min]  'YYYY-MM-DD'
 * @param {string} [props.max]  'YYYY-MM-DD'
 * @param {'sm'|'md'|'lg'|'bare'} [props.size]
 * @param {boolean} [props.calendar]  show the calendar button (default true)
 * @param {boolean} [props.invalid]
 * @param {string} [props.wrapperClassName]
 */
export function DateField({
  value, defaultValue, onChange, min, max, size = 'md', calendar = true, invalid, disabled, readOnly,
  className, wrapperClassName, style, placeholder, inputRef: inputRefProp, onBlur, onFocus, onKeyDown, ...rest
}) {
  const { t } = useTranslation();
  const lang = useLang();
  const ownRef = useRef(null);
  const inputRef = inputRefProp || ownRef;
  const wrapRef = useRef(null);
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const range = { min: min || undefined, max: max || undefined };

  const field = useTypedValue({
    value, defaultValue, onChange,
    toText: isoToDateText,
    read: (text) => {
      const r = parseDateText(text, range);
      return r.iso;
    },
  });

  const status = parseDateText(field.text, range).status;
  const message = status === 'invalid' || status === 'incomplete'
    ? t('picker.invalidDate', 'Enter a date as DD.MM.YYYY.')
    : status === 'min'
      ? t('picker.dateBeforeMin', { defaultValue: 'The earliest date is {{date}}.', date: isoToDateText(min) })
      : status === 'max'
        ? t('picker.dateAfterMax', { defaultValue: 'The latest date is {{date}}.', date: isoToDateText(max) })
        : '';
  useValidity(inputRef, message);
  const ariaInvalid = rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  const bad = invalid || ariaInvalid || (touched && !!message);

  const close = useReturnFocus(inputRef, setOpen);
  const canPick = calendar && !disabled && !readOnly;

  return (
    <span ref={wrapRef} className={cn('relative flex w-full min-w-0 items-center', wrapperClassName)}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        size={10}
        placeholder={placeholder ?? t('picker.datePlaceholder', 'DD.MM.YYYY')}
        disabled={disabled}
        readOnly={readOnly}
        style={bareStyle(size, style)}
        {...rest}
        aria-invalid={bad || undefined}
        className={inputClass(size, { invalid: bad, withButton: calendar, className })}
        value={field.text}
        onChange={(e) => { setTouched(false); field.type(acceptDateInput(e.target.value)); }}
        onFocus={onFocus}
        onBlur={(e) => {
          // Tidy a complete date: 6.1.2026 -> 06.01.2026.
          const r = parseDateText(field.text, range);
          if (r.iso && isoToDateText(r.iso) !== field.text) field.setText(isoToDateText(r.iso));
          setTouched(true);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (canPick && (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); setOpen(true); return; }
          onKeyDown?.(e);
        }}
      />
      {calendar && (
        <TriggerButton size={size} disabled={!canPick} open={open} onOpen={() => setOpen((o) => !o)}
          label={t('picker.openCalendar', 'Open calendar')} icon={CalendarDays} controls={popId} />
      )}
      {open && (
        <PickerPopover open id={popId} anchorRef={wrapRef} onClose={close} label={t('picker.calendar', 'Calendar')}>
          <Calendar
            value={parseIsoDate(field.current) ? field.current : ''}
            min={range.min}
            max={range.max}
            lang={lang}
            clearable={!rest.required}
            onPick={(iso) => { field.pick(iso); setTouched(true); close(); }}
            onClear={() => { field.pick(''); close(); }}
            onDone={close}
          />
        </PickerPopover>
      )}
    </span>
  );
}

/**
 * Time as HH:MM text plus an hour / minute popover. 'HH:MM' in and out.
 * @param {object} props
 * @param {string} [props.value]  'HH:MM' or ''
 * @param {string} [props.defaultValue]
 * @param {(value: string) => void} [props.onChange]
 * @param {number} [props.step]  minutes between the offered minutes (default 5); typing any minute works
 * @param {string} [props.min]  'HH:MM'
 * @param {string} [props.max]  'HH:MM'
 * @param {'sm'|'md'|'lg'|'bare'} [props.size]
 * @param {boolean} [props.picker]  show the clock button (default true)
 */
export function TimeField({
  value, defaultValue, onChange, step = 5, min, max, size = 'md', picker = true, invalid, disabled, readOnly,
  className, wrapperClassName, style, placeholder, inputRef: inputRefProp, onBlur, onFocus, onKeyDown, ...rest
}) {
  const { t } = useTranslation();
  const ownRef = useRef(null);
  const inputRef = inputRefProp || ownRef;
  const wrapRef = useRef(null);
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const range = { min: normalizeTime(min) || undefined, max: normalizeTime(max) || undefined };

  const field = useTypedValue({
    value: value === undefined ? undefined : normalizeTime(value) || (value ? String(value) : ''),
    defaultValue: normalizeTime(defaultValue),
    onChange,
    toText: (v) => normalizeTime(v) || '',
    read: (text) => parseTimeText(text, range).value,
  });

  const status = parseTimeText(field.text, range).status;
  const message = status === 'invalid' || status === 'incomplete'
    ? t('picker.invalidTime', 'Enter a time as HH:MM.')
    : status === 'min'
      ? t('picker.timeBeforeMin', { defaultValue: 'The earliest time is {{time}}.', time: range.min })
      : status === 'max'
        ? t('picker.timeAfterMax', { defaultValue: 'The latest time is {{time}}.', time: range.max })
        : '';
  useValidity(inputRef, message);
  const ariaInvalid = rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  const bad = invalid || ariaInvalid || (touched && !!message);

  const close = useReturnFocus(inputRef, setOpen);
  const canPick = picker && !disabled && !readOnly;

  return (
    <span ref={wrapRef} className={cn('relative flex w-full min-w-0 items-center', wrapperClassName)}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        size={5}
        placeholder={placeholder ?? t('picker.timePlaceholder', 'HH:MM')}
        disabled={disabled}
        readOnly={readOnly}
        style={bareStyle(size, style)}
        {...rest}
        aria-invalid={bad || undefined}
        className={inputClass(size, { invalid: bad, withButton: picker, className })}
        value={field.text}
        onChange={(e) => { setTouched(false); field.type(acceptTimeInput(e.target.value)); }}
        onFocus={onFocus}
        onBlur={(e) => {
          // Tidy a complete time: 9:30 -> 09:30.
          const r = parseTimeText(field.text, range);
          if (r.value && r.value !== field.text) field.setText(r.value);
          setTouched(true);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (canPick && (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); setOpen(true); return; }
          onKeyDown?.(e);
        }}
      />
      {picker && (
        <TriggerButton size={size} disabled={!canPick} open={open} onOpen={() => setOpen((o) => !o)}
          label={t('picker.chooseTime', 'Choose time')} icon={Clock} controls={popId} />
      )}
      {open && (
        <PickerPopover open id={popId} anchorRef={wrapRef} onClose={close} label={t('picker.time', 'Time')}>
          <TimePanel
            value={normalizeTime(field.current)}
            step={step}
            min={range.min}
            max={range.max}
            clearable={!rest.required}
            onPick={(v, done) => { field.pick(v); if (done) { setTouched(true); close(); } }}
            onClear={() => { field.pick(''); close(); }}
            onDone={close}
          />
        </PickerPopover>
      )}
    </span>
  );
}

/**
 * Date and time side by side, one 'YYYY-MM-DDTHH:MM' value (as
 * datetime-local): '' until both parts are there.
 * @param {object} props
 * @param {string} [props.value]
 * @param {string} [props.defaultValue]
 * @param {(value: string) => void} [props.onChange]
 * @param {(value: string) => void} [props.onCommit]  once the focus leaves the
 *   whole field (inputs, buttons and popovers) with a changed value: for
 *   screens that save on blur
 * @param {number} [props.step]
 * @param {'sm'|'md'|'lg'|'bare'} [props.size]
 * @param {string} [props.className]  on each input
 * @param {object} [props.style]      on each input
 */
export function DateTimeField({
  value, defaultValue, onChange, onCommit, step = 5, size = 'md', disabled, readOnly, required,
  className, wrapperClassName, style, id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby, 'aria-invalid': ariaInvalid, invalid, ...rest
}) {
  const { t } = useTranslation();
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = (controlled ? value : inner) ?? '';
  const [parts, setParts] = useState(() => splitDateTime(current));
  const reported = useRef(current);
  const committed = useRef(current);
  const groupRef = useRef(null);

  useEffect(() => {
    if (current === reported.current) return;
    reported.current = current;
    committed.current = current;
    setParts(splitDateTime(current));
  }, [current]);

  const commit = () => {
    if (!onCommit || reported.current === committed.current) return;
    committed.current = reported.current;
    onCommit(reported.current);
  };

  const partsRef = useRef(parts);
  partsRef.current = parts;
  const update = (patch) => {
    const next = { ...partsRef.current, ...patch };
    partsRef.current = next;
    setParts(next);
    const joined = joinDateTime(next.date, next.time);
    if (joined === reported.current) return;
    reported.current = joined;
    if (!controlled) setInner(joined);
    onChange?.(joined);
  };

  const label = ariaLabel ? `${ariaLabel} – ` : '';
  return (
    <span
      ref={groupRef}
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn('flex w-full min-w-0 items-center gap-2', wrapperClassName)}
      onBlur={(e) => {
        // Focus moving inside the field (input -> button -> popover) is not leaving it.
        if (onCommit && !groupRef.current?.contains(e.relatedTarget)) setTimeout(() => {
          if (!groupRef.current?.contains(document.activeElement)) commit();
        }, 0);
      }}
      {...rest}
    >
      <DateField
        id={id}
        size={size}
        value={parts.date}
        onChange={(d) => update({ date: d })}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        invalid={invalid}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
        aria-label={`${label}${t('picker.date', 'Date')}`}
        className={className}
        style={style}
        wrapperClassName="flex-[3_1_0%]"
      />
      <TimeField
        size={size}
        value={parts.time}
        step={step}
        onChange={(v) => update({ time: v })}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        invalid={invalid}
        aria-invalid={ariaInvalid}
        aria-label={`${label}${t('picker.time', 'Time')}`}
        className={className}
        style={style}
        wrapperClassName="flex-[2_1_0%]"
      />
    </span>
  );
}

export default DateField;
