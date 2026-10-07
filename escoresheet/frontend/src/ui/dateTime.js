// Typed dates and times for DateField / TimeField / DateTimeField.
//
// Why not <input type="date|time|datetime-local">: the native pickers differ
// per engine and some cannot be left. In the Linux desktop app (WebKitGTK) the
// date popup under the field could not be dismissed at all, and WebKit draws an
// EMPTY date field with today's date in it. The kit fields are text fields the
// user types into (DD.MM.YYYY, HH:MM, the Swiss order in every language) with
// the kit's own calendar and time popovers next to them.
//
// Values in and out stay ISO, so callers keep their data model:
//   date  'YYYY-MM-DD'      time  'HH:MM'      date + time  'YYYY-MM-DDTHH:MM'
// '' means empty (or not a complete, real date/time yet), like a native field.
//
// Pure functions only: no React, no clock unless one is passed in.

import { localeOf, todayKey } from './format.js';

export const pad2 = (n) => String(n).padStart(2, '0');

const DATE_LIMITS = [2, 2, 4];
const DATE_SEPARATOR = /[.\/\-\s,]/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME_RE = /^(\d{2}):(\d{2})$/;

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * Shapes what the user typed into D.M.YYYY groups: digits only, a dot after a
 * full day and month (typed or not), a typed separator ends a group early
 * ("6." then "10." then "1990"). Never adds a trailing dot by itself, so
 * Backspace deletes the way the user expects.
 * @param {string} raw
 * @returns {string}
 */
export function shapeDateText(raw) {
  const groups = [''];
  for (const ch of String(raw || '')) {
    const cur = groups.length - 1;
    if (/\d/.test(ch)) {
      if (groups[cur].length < DATE_LIMITS[cur]) groups[cur] += ch;
      else if (cur < 2) groups.push(ch);
    } else if (DATE_SEPARATOR.test(ch)) {
      if (groups[cur].length > 0 && cur < 2) groups.push('');
    }
  }
  return groups.join('.');
}

/** 'YYYY-MM-DD' (or an ISO timestamp) -> 'DD.MM.YYYY'; anything else -> ''. */
export function isoToDateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** 'YYYY-MM-DD' -> { year, month, day } when it is a real calendar day, else null. */
export function parseIsoDate(iso) {
  const m = ISO_DATE_RE.exec(String(iso || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isRealDate(year, month, day)) return null;
  return { year, month, day };
}

export function isRealDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function toIsoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Days in a month (month 1..12). */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** An ISO day moved by whole calendar days. */
export function addDays(iso, delta) {
  const p = parseIsoDate(iso);
  if (!p) return '';
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + delta));
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** An ISO day moved by whole months; the 31st becomes the month's last day. */
export function addMonths(iso, delta) {
  const p = parseIsoDate(iso);
  if (!p) return '';
  const index = p.year * 12 + (p.month - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12 + 12) % 12 + 1;
  return toIsoDate(year, month, Math.min(p.day, daysInMonth(year, month)));
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(iso) {
  const p = parseIsoDate(iso);
  if (!p) return -1;
  return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
}

/** ISO strings compare as dates; '' / undefined means no bound. */
export function isBefore(iso, min) { return !!min && !!iso && iso < min; }
export function isAfter(iso, max) { return !!max && !!iso && iso > max; }
export function inRange(iso, min, max) { return !isBefore(iso, min) && !isAfter(iso, max); }

/** The nearest day to `iso` within [min, max]. */
export function clampDate(iso, min, max) {
  if (isBefore(iso, min)) return min;
  if (isAfter(iso, max)) return max;
  return iso;
}

/**
 * Reads typed text as a date.
 * @param {string} text  'D.M.YYYY' / 'DD.MM.YYYY' (also an ISO date, from autofill or a paste)
 * @param {{ min?: string, max?: string }} [range]  ISO bounds
 * @returns {{ iso: string, status: 'empty'|'ok'|'incomplete'|'invalid'|'min'|'max' }}
 *   iso is the date (also when out of range, as a native field keeps it), or ''.
 */
export function parseDateText(text, range = {}) {
  const s = String(text || '').trim();
  if (!s) return { iso: '', status: 'empty' };
  let year; let month; let day;
  const iso = ISO_DATE_RE.exec(s);
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (iso) { year = +iso[1]; month = +iso[2]; day = +iso[3]; }
  else if (dotted) { day = +dotted[1]; month = +dotted[2]; year = +dotted[3]; }
  else {
    // Something that could still become a date ("6.10.19") is unfinished; the rest is wrong.
    return { iso: '', status: /^\d{1,2}(\.\d{0,2}(\.\d{0,3})?)?$/.test(s) ? 'incomplete' : 'invalid' };
  }
  if (!isRealDate(year, month, day) || year < 1000) return { iso: '', status: 'invalid' };
  const out = toIsoDate(year, month, day);
  if (isBefore(out, range.min)) return { iso: out, status: 'min' };
  if (isAfter(out, range.max)) return { iso: out, status: 'max' };
  return { iso: out, status: 'ok' };
}

/** What the user typed, shaped; an ISO date (autofill, paste, tests) is taken whole. */
export function acceptDateInput(raw) {
  const s = String(raw || '').trim();
  if (ISO_DATE_RE.test(s)) return isoToDateText(s);
  return shapeDateText(raw);
}

/** Today as an ISO day on the Zürich clock (the app's clock, format.js). */
export function todayIso() {
  return todayKey();
}

/**
 * The 6×7 days shown for a month, Monday first, as ISO strings. Days of the
 * neighbouring months fill the first and last rows.
 */
export function monthGrid(year, month) {
  const first = toIsoDate(year, month, 1);
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const nameCache = new Map();
function cached(key, make) {
  if (!nameCache.has(key)) nameCache.set(key, make());
  return nameCache.get(key);
}

/** Month names in the app language ('January' / 'Januar' / 'janvier' / 'gennaio'). */
export function monthNames(lang) {
  const locale = localeOf(lang);
  return cached(`m:${locale}`, () => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2024, i, 1))));
  });
}

/** Short weekday names, Monday first ('Mo', 'Di' … / 'Mon', 'Tue' …). */
export function weekdayNames(lang) {
  const locale = localeOf(lang);
  return cached(`w:${locale}`, () => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    // 2024-01-01 is a Monday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))).replace(/\.$/, ''));
  });
}

/** 'Dienstag, 7. Oktober 2026': the spoken name of a day button. */
export function longDayLabel(iso, lang) {
  const p = parseIsoDate(iso);
  if (!p) return '';
  const locale = localeOf(lang);
  const fmt = cached(`l:${locale}`, () => new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }));
  const d = new Date(Date.UTC(2000, p.month - 1, p.day));
  d.setUTCFullYear(p.year);
  return fmt.format(d);
}

// ── Times ───────────────────────────────────────────────────────────────────

const TIME_SEPARATOR = /[:.h\s,]/i;

/**
 * Shapes typed text into H:MM / HH:MM: digits only, a colon after a full hour
 * ("2045" -> "20:45"; "930" -> "9:30" since no hour starts with 9x), a typed
 * separator ("9:" / "9.30" / "9h30") ends the hour early.
 * @param {string} raw
 */
export function shapeTimeText(raw) {
  const groups = [''];
  for (const ch of String(raw || '')) {
    const cur = groups.length - 1;
    if (/\d/.test(ch)) {
      const g = groups[cur];
      if (cur === 0) {
        if (g.length === 0) groups[0] = ch;
        else if (g.length === 1 && Number(g + ch) <= 23) groups[0] += ch;
        else { groups.push(ch); }
      } else if (g.length < 2) {
        groups[1] += ch;
      }
    } else if (TIME_SEPARATOR.test(ch)) {
      if (cur === 0 && groups[0].length > 0) groups.push('');
    }
  }
  return groups.join(':');
}

/**
 * Reads typed text as a time of day.
 * @param {string} text  'H:MM' / 'HH:MM'
 * @param {{ min?: string, max?: string }} [range]  'HH:MM' bounds
 * @returns {{ value: string, status: 'empty'|'ok'|'incomplete'|'invalid'|'min'|'max' }}
 */
export function parseTimeText(text, range = {}) {
  const s = String(text || '').trim();
  if (!s) return { value: '', status: 'empty' };
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return { value: '', status: /^\d{1,2}(:\d?)?$/.test(s) ? 'incomplete' : 'invalid' };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return { value: '', status: 'invalid' };
  const value = `${pad2(h)}:${pad2(min)}`;
  if (range.min && value < range.min) return { value, status: 'min' };
  if (range.max && value > range.max) return { value, status: 'max' };
  return { value, status: 'ok' };
}

/** 'HH:MM' (or 'HH:MM:SS') -> 'HH:MM'; anything else -> ''. */
export function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return `${pad2(m[1])}:${pad2(m[2])}`;
}

/** What the user typed, shaped; a full 'HH:MM[:SS]' is taken whole. */
export function acceptTimeInput(raw) {
  const s = String(raw || '').trim();
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 5);
  return shapeTimeText(raw);
}

/** Minutes offered in the time popover: every `step` minutes, plus the current one. */
export function minuteOptions(step = 5, current) {
  const s = Math.max(1, Math.min(60, Math.round(step) || 5));
  const out = [];
  for (let m = 0; m < 60; m += s) out.push(m);
  if (Number.isInteger(current) && current >= 0 && current < 60 && !out.includes(current)) {
    out.push(current);
    out.sort((a, b) => a - b);
  }
  return out;
}

/** 'HH:MM' of the Zürich clock now, rounded down to the step. */
export function nowTime(step = 1, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  const s = Math.max(1, step);
  return `${pad2(h)}:${pad2(Math.floor(m / s) * s)}`;
}

// ── Date + time ─────────────────────────────────────────────────────────────

/** 'YYYY-MM-DDTHH:MM[...]' -> { date, time }; missing parts are ''. */
export function splitDateTime(value) {
  const s = String(value || '');
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
  if (!m) return { date: '', time: '' };
  return { date: parseIsoDate(m[1]) ? m[1] : '', time: normalizeTime(m[2] || '') };
}

/** Both parts -> 'YYYY-MM-DDTHH:MM'; '' until both are there (as datetime-local). */
export function joinDateTime(date, time) {
  return date && time ? `${date}T${time}` : '';
}
